//! Schema introspection for Mongo, shaped to fit [`SchemaTree`].
//!
//! Mongo has no schema layer and no fixed column set, so the relational
//! tree is synthesised:
//!
//! - each Mongo **database** → a [`DatabaseNode`]
//! - a single synthetic **schema** per database (named after the database,
//!   since there's nothing finer-grained) holding every collection
//! - each **collection** → a [`RelationNode`] ("table")
//! - **columns** are *inferred* by sampling a handful of documents and
//!   unioning their top-level field names — this is exactly what
//!   nosqlbooster's tree does. The `type_name` is the BSON type of the
//!   first sample that has the field; `nullable` is true whenever any
//!   sampled doc omitted it.
//! - **indexes** come from `listIndexes`; the `_id_` index is reported as
//!   the primary key.
//!
//! We skip Mongo's internal databases (`admin`, `local`, `config`) by
//! default — power users rarely browse them and they clutter the tree.

use db_core::{
    ColumnNode, DatabaseNode, DbError, DbResult, IndexNode, RelationNode, SchemaNode, SchemaTree,
};
use futures::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::Client;
use std::collections::BTreeMap;

/// How many documents to sample per collection when inferring columns. Small
/// enough to stay cheap on big collections, large enough to catch the common
/// fields. nosqlbooster uses a similar bounded sample.
const SAMPLE_SIZE: i64 = 25;

const INTERNAL_DBS: &[&str] = &["admin", "local", "config"];

pub async fn introspect(client: &Client, default_db: Option<&str>) -> DbResult<SchemaTree> {
    let db_names = client
        .list_database_names()
        .await
        .map_err(|e| DbError::Driver(e.to_string()))?;

    let mut databases = Vec::new();
    for db_name in db_names {
        if INTERNAL_DBS.contains(&db_name.as_str()) {
            continue;
        }
        let node = introspect_database(client, &db_name).await?;
        databases.push(node);
    }

    // If the user pinned a specific database that happens to be internal (or
    // simply isn't listed because it has no collections yet), make sure it
    // still shows up so they're not staring at an empty tree.
    if let Some(db) = default_db {
        if !databases.iter().any(|d| d.name == db) {
            databases.push(introspect_database(client, db).await?);
        }
    }

    // Surface the pinned database FIRST. The frontend resolves the active
    // database as `tree.databases[0]` (Mongo has no single "current" db), so
    // without this the data view could open against whichever database Mongo
    // happened to list first — not the one the connection specified.
    pin_default_first(&mut databases, default_db);

    Ok(SchemaTree { databases })
}

/// Move the pinned `default_db` to the front of the list so `databases[0]`
/// (what the frontend treats as the active database) is the one the connection
/// specified. No-op when nothing is pinned or the pinned db isn't present.
fn pin_default_first(databases: &mut [DatabaseNode], default_db: Option<&str>) {
    if let Some(db) = default_db {
        if let Some(pos) = databases.iter().position(|d| d.name == db) {
            databases.swap(0, pos);
        }
    }
}

async fn introspect_database(client: &Client, db_name: &str) -> DbResult<DatabaseNode> {
    let db = client.database(db_name);
    let coll_names = db
        .list_collection_names()
        .await
        .map_err(|e| DbError::Driver(e.to_string()))?;

    let mut tables = Vec::new();
    for coll_name in coll_names {
        tables.push(introspect_collection(&db, &coll_name).await?);
    }

    Ok(DatabaseNode {
        name: db_name.to_string(),
        // One synthetic schema named after the database. Mongo has no
        // schema concept, but SchemaTree demands the layer.
        schemas: vec![SchemaNode {
            name: db_name.to_string(),
            tables,
            views: vec![],
            functions: vec![],
        }],
    })
}

async fn introspect_collection(db: &mongodb::Database, coll_name: &str) -> DbResult<RelationNode> {
    let coll = db.collection::<Document>(coll_name);

    // Sample documents for column inference.
    let mut cursor = coll
        .find(doc! {})
        .limit(SAMPLE_SIZE)
        .await
        .map_err(|e| DbError::Driver(e.to_string()))?;

    // Track first-seen order, the type of the first occurrence, and how many
    // samples carried each field (to decide nullability).
    let mut order: Vec<String> = Vec::new();
    let mut types: BTreeMap<String, String> = BTreeMap::new();
    let mut present: BTreeMap<String, usize> = BTreeMap::new();
    let mut sampled = 0usize;

    while let Some(d) = cursor
        .try_next()
        .await
        .map_err(|e| DbError::Driver(e.to_string()))?
    {
        sampled += 1;
        for (k, v) in &d {
            if !types.contains_key(k) {
                order.push(k.clone());
                types.insert(k.clone(), bson_type_name(v).to_string());
            }
            *present.entry(k.clone()).or_default() += 1;
        }
    }

    // `_id` first, then first-seen order. (`_id` is always present, but a
    // freshly-created empty collection samples nothing — pin it regardless.)
    if !order.iter().any(|n| n == "_id") {
        order.insert(0, "_id".to_string());
        types
            .entry("_id".to_string())
            .or_insert_with(|| "objectId".to_string());
    } else if let Some(pos) = order.iter().position(|n| n == "_id") {
        let id = order.remove(pos);
        order.insert(0, id);
    }

    let columns = order
        .iter()
        .map(|name| ColumnNode {
            name: name.clone(),
            type_name: types.get(name).cloned().unwrap_or_else(|| "bson".into()),
            // Nullable unless every sampled doc had it. `_id` is never null.
            nullable: name != "_id" && present.get(name).copied().unwrap_or(0) < sampled,
            default: None,
        })
        .collect();

    let indexes = list_indexes(&coll).await?;
    // `_id` is the de-facto primary key in every collection.
    let primary_key = vec!["_id".to_string()];

    Ok(RelationNode {
        name: coll_name.to_string(),
        columns,
        primary_key,
        foreign_keys: vec![], // Mongo has no FK concept.
        indexes,
    })
}

async fn list_indexes(coll: &mongodb::Collection<Document>) -> DbResult<Vec<IndexNode>> {
    // `list_indexes` yields IndexModel; we read the raw `key` doc and the
    // `unique` flag. Done defensively — a collection with no explicit indexes
    // still has `_id_`, and listing can fail on views, so we swallow errors
    // into an empty list rather than failing the whole introspection.
    let mut out = Vec::new();
    let mut cursor = match coll.list_indexes().await {
        Ok(c) => c,
        Err(_) => return Ok(out),
    };
    while let Ok(Some(model)) = cursor.try_next().await {
        let keys: Vec<String> = model.keys.keys().cloned().collect();
        let name = model
            .options
            .as_ref()
            .and_then(|o| o.name.clone())
            .unwrap_or_else(|| keys.join("_"));
        let is_unique = model
            .options
            .as_ref()
            .and_then(|o| o.unique)
            .unwrap_or(false);
        let is_primary = name == "_id_";
        out.push(IndexNode {
            name,
            columns: keys,
            is_unique: is_unique || is_primary,
            is_primary,
            method: index_method(&model.keys),
            definition: bson_to_compact_json(&model.keys),
        });
    }
    Ok(out)
}

/// Approximate the "method" column for the Info panel: most Mongo indexes are
/// b-tree-like; we surface the special index kinds (text, 2dsphere, hashed)
/// when their sentinel values appear in the key spec.
fn index_method(keys: &Document) -> String {
    for (_, v) in keys {
        match v {
            Bson::String(s) if s == "text" => return "text".into(),
            Bson::String(s) if s == "2dsphere" => return "2dsphere".into(),
            Bson::String(s) if s == "hashed" => return "hashed".into(),
            _ => {}
        }
    }
    "btree".into()
}

fn bson_to_compact_json(d: &Document) -> String {
    Bson::Document(d.clone()).into_relaxed_extjson().to_string()
}

/// Human-readable BSON type name for the column inspector.
fn bson_type_name(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::Boolean(_) => "bool",
        Bson::DateTime(_) => "date",
        Bson::Null | Bson::Undefined => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Decimal128(_) => "decimal",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Symbol(_) => "symbol",
        Bson::DbPointer(_) => "dbPointer",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str) -> DatabaseNode {
        DatabaseNode {
            name: name.to_string(),
            schemas: vec![],
        }
    }
    fn names(dbs: &[DatabaseNode]) -> Vec<String> {
        dbs.iter().map(|d| d.name.clone()).collect()
    }

    #[test]
    fn pins_the_connection_database_first() {
        let mut dbs = vec![node("analytics"), node("myapp"), node("logs")];
        pin_default_first(&mut dbs, Some("myapp"));
        assert_eq!(names(&dbs), vec!["myapp", "analytics", "logs"]);
    }

    #[test]
    fn already_first_is_unchanged() {
        let mut dbs = vec![node("myapp"), node("analytics")];
        pin_default_first(&mut dbs, Some("myapp"));
        assert_eq!(names(&dbs), vec!["myapp", "analytics"]);
    }

    #[test]
    fn no_pin_or_missing_pin_is_a_noop() {
        let mut dbs = vec![node("a"), node("b")];
        pin_default_first(&mut dbs, None);
        assert_eq!(names(&dbs), vec!["a", "b"]);
        pin_default_first(&mut dbs, Some("nope"));
        assert_eq!(names(&dbs), vec!["a", "b"]);
    }
}
