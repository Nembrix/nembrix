//! Schema introspection for Redis, shaped to fit [`SchemaTree`].
//!
//! Redis has no catalog, so the tree is synthesised from the keyspace of the
//! connection's logical database:
//!
//! - the database (`db0`, `db1`, …) → one [`DatabaseNode`] holding one
//!   [`SchemaNode`] of the same name (mirroring the Mongo driver)
//! - each **key** → a [`RelationNode`] ("table")
//! - **columns** are the grid columns that browsing the key produces (see
//!   [`crate::reply`]), and every column's `type_name` is the key's Redis
//!   type (`string`, `hash`, `list`, `set`, `zset`, `stream`, …). The
//!   frontend reads it to pick the browse command.
//!
//! Keys come from `SCAN` (never `KEYS`, which blocks the server), capped at
//! [`MAX_KEYS`], sorted. Types are fetched in one pipelined round trip.

use db_core::{ColumnNode, DatabaseNode, DbError, DbResult, RelationNode, SchemaNode, SchemaTree};
use redis::aio::MultiplexedConnection;

/// Upper bound on keys listed in the tree. A production keyspace can hold
/// millions; past this the user browses with `SCAN … MATCH` in the editor.
pub const MAX_KEYS: usize = 2_000;

/// `COUNT` hint per `SCAN` round trip.
const SCAN_COUNT: usize = 1_000;

pub async fn introspect(conn: &mut MultiplexedConnection, db: i64) -> DbResult<SchemaTree> {
    let drv = |e: redis::RedisError| DbError::Driver(db_core::error_chain(&e));

    let mut keys: Vec<Vec<u8>> = Vec::new();
    let mut cursor: u64 = 0;
    loop {
        let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(SCAN_COUNT)
            .query_async(conn)
            .await
            .map_err(drv)?;
        keys.extend(batch);
        cursor = next;
        if cursor == 0 || keys.len() >= MAX_KEYS {
            break;
        }
    }
    // SCAN may return a key more than once across iterations.
    keys.sort();
    keys.dedup();
    keys.truncate(MAX_KEYS);

    let types: Vec<String> = if keys.is_empty() {
        Vec::new()
    } else {
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k);
        }
        pipe.query_async(conn).await.map_err(drv)?
    };

    let tables = keys
        .into_iter()
        .zip(types)
        // Expired between SCAN and TYPE.
        .filter(|(_, ty)| ty != "none")
        .map(|(key, ty)| relation(String::from_utf8_lossy(&key).into_owned(), &ty))
        .collect();

    let name = format!("db{db}");
    Ok(SchemaTree {
        databases: vec![DatabaseNode {
            name: name.clone(),
            schemas: vec![SchemaNode {
                name,
                tables,
                views: Vec::new(),
                functions: Vec::new(),
            }],
        }],
    })
}

/// The grid columns browsing a key of type `ty` produces.
pub fn columns_for(ty: &str) -> &'static [&'static str] {
    match ty {
        "hash" => &["field", "value"],
        "list" => &["index", "value"],
        "set" => &["member"],
        "zset" => &["member", "score"],
        "stream" => &["id", "fields"],
        _ => &["value"],
    }
}

fn relation(key: String, ty: &str) -> RelationNode {
    RelationNode {
        name: key,
        columns: columns_for(ty)
            .iter()
            .map(|c| ColumnNode {
                name: c.to_string(),
                type_name: ty.to_string(),
                nullable: true,
                default: None,
            })
            .collect(),
        primary_key: Vec::new(),
        foreign_keys: Vec::new(),
        indexes: Vec::new(),
    }
}
