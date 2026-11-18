//! Schema introspection for SQLite, shaped to fit [`SchemaTree`].
//!
//! One [`DatabaseNode`] named after the file, whose [`SchemaNode`]s are the
//! connection's databases: `main` first (the frontend opens `schemas[0]` by
//! default), then any `ATTACH`ed ones; `temp` is left out. Everything comes
//! from `sqlite_schema` and the `pragma_*` table-valued functions. SQLite has
//! no stored functions to list.

use std::collections::BTreeMap;

use db_core::{
    ColumnNode, DatabaseNode, DbResult, ForeignKey, IndexNode, RelationNode, SchemaNode, SchemaTree,
};
use rusqlite::{params, Connection};

use crate::drv;

fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

pub fn introspect(conn: &Connection, file_name: &str) -> DbResult<SchemaTree> {
    let mut names: Vec<String> = conn
        .prepare("SELECT name FROM pragma_database_list ORDER BY seq")
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .map_err(drv)?;
    names.retain(|n| n != "temp");

    let schemas = names
        .iter()
        .map(|s| schema(conn, s))
        .collect::<DbResult<Vec<_>>>()?;
    Ok(SchemaTree {
        databases: vec![DatabaseNode {
            name: file_name.to_string(),
            schemas,
        }],
    })
}

fn schema(conn: &Connection, schema: &str) -> DbResult<SchemaNode> {
    // (type, name, tbl_name, sql) for every user object.
    let objects: Vec<(String, String, String, Option<String>)> = conn
        .prepare(&format!(
            "SELECT type, name, tbl_name, sql FROM {}.sqlite_schema \
             WHERE type IN ('table', 'view', 'index') \
               AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY name",
            quote(schema)
        ))
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect()
        })
        .map_err(drv)?;

    // Index DDL by name; auto-indexes (UNIQUE / PRIMARY KEY constraints) have
    // none and don't appear here at all.
    let index_sql: BTreeMap<&str, &str> = objects
        .iter()
        .filter(|o| o.0 == "index")
        .filter_map(|o| o.3.as_deref().map(|sql| (o.1.as_str(), sql)))
        .collect();

    let mut tables = Vec::new();
    let mut views = Vec::new();
    for (ty, name, _, _) in &objects {
        match ty.as_str() {
            "table" => tables.push(relation(conn, schema, name, &index_sql)?),
            "view" => views.push(relation(conn, schema, name, &index_sql)?),
            _ => {}
        }
    }
    Ok(SchemaNode {
        name: schema.to_string(),
        tables,
        views,
        functions: Vec::new(),
    })
}

fn relation(
    conn: &Connection,
    schema: &str,
    table: &str,
    index_sql: &BTreeMap<&str, &str>,
) -> DbResult<RelationNode> {
    // `hidden` 1 = a virtual table's hidden column; 2 / 3 = generated columns,
    // which are real columns to show.
    let cols: Vec<(String, String, bool, Option<String>, i64)> = conn
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value, pk \
             FROM pragma_table_xinfo(?1, ?2) WHERE hidden <> 1 ORDER BY cid",
        )
        .and_then(|mut s| {
            s.query_map(params![table, schema], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect()
        })
        .map_err(drv)?;

    let mut pk: Vec<(i64, String)> = cols
        .iter()
        .filter(|c| c.4 > 0)
        .map(|c| (c.4, c.0.clone()))
        .collect();
    pk.sort();
    let primary_key: Vec<String> = pk.into_iter().map(|(_, n)| n).collect();

    let columns = cols
        .into_iter()
        .map(|(name, type_name, notnull, default, _)| ColumnNode {
            name,
            type_name: type_name.to_ascii_lowercase(),
            nullable: !notnull,
            default,
        })
        .collect();

    Ok(RelationNode {
        name: table.to_string(),
        columns,
        foreign_keys: foreign_keys(conn, schema, table)?,
        indexes: indexes(conn, schema, table, index_sql)?,
        primary_key,
    })
}

fn foreign_keys(conn: &Connection, schema: &str, table: &str) -> DbResult<Vec<ForeignKey>> {
    // (id, target table, from, to). `to` is NULL when the constraint names
    // only the table — it then references that table's primary key.
    let rows: Vec<(i64, String, String, Option<String>)> = conn
        .prepare(
            "SELECT id, \"table\", \"from\", \"to\" \
             FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
        )
        .and_then(|mut s| {
            s.query_map(params![table, schema], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect()
        })
        .map_err(drv)?;

    let mut by_id: BTreeMap<i64, ForeignKey> = BTreeMap::new();
    let mut implicit: Vec<i64> = Vec::new();
    for (id, target, from, to) in rows {
        let fk = by_id.entry(id).or_insert_with(|| ForeignKey {
            // SQLite keeps no constraint names; use Postgres' default shape.
            name: String::new(),
            columns: Vec::new(),
            // A foreign key always points into the same database file.
            referenced_schema: schema.to_string(),
            referenced_table: target,
            referenced_columns: Vec::new(),
        });
        fk.columns.push(from);
        match to {
            Some(to) => fk.referenced_columns.push(to),
            None => implicit.push(id),
        }
    }
    for id in implicit {
        let fk = by_id.get_mut(&id).expect("collected above");
        if fk.referenced_columns.is_empty() {
            fk.referenced_columns = primary_key_of(conn, schema, &fk.referenced_table)?;
        }
    }
    Ok(by_id
        .into_values()
        .map(|mut fk| {
            fk.name = format!("{}_{}_fkey", table, fk.columns.join("_"));
            fk
        })
        .collect())
}

fn primary_key_of(conn: &Connection, schema: &str, table: &str) -> DbResult<Vec<String>> {
    conn.prepare("SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk")
        .and_then(|mut s| s.query_map(params![table, schema], |r| r.get(0))?.collect())
        .map_err(drv)
}

fn indexes(
    conn: &Connection,
    schema: &str,
    table: &str,
    index_sql: &BTreeMap<&str, &str>,
) -> DbResult<Vec<IndexNode>> {
    // origin: 'c' = CREATE INDEX, 'u' = UNIQUE constraint, 'pk' = PRIMARY KEY.
    let list: Vec<(String, bool, String)> = conn
        .prepare("SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2) ORDER BY name")
        .and_then(|mut s| {
            s.query_map(params![table, schema], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect()
        })
        .map_err(drv)?;

    let mut out = Vec::with_capacity(list.len());
    for (name, is_unique, origin) in list {
        // An expression column has no name.
        let columns: Vec<String> = conn
            .prepare(
                "SELECT coalesce(name, '<expr>') FROM pragma_index_info(?1, ?2) ORDER BY seqno",
            )
            .and_then(|mut s| s.query_map(params![name, schema], |r| r.get(0))?.collect())
            .map_err(drv)?;
        let definition = match index_sql.get(name.as_str()) {
            Some(sql) => sql.to_string(),
            // Created by a constraint: describe it the way it was declared.
            None => format!(
                "{} ({})",
                if origin == "pk" {
                    "PRIMARY KEY"
                } else {
                    "UNIQUE"
                },
                columns.join(", ")
            ),
        };
        out.push(IndexNode {
            name,
            columns,
            is_unique,
            is_primary: origin == "pk",
            method: "btree".into(),
            definition,
        });
    }
    Ok(out)
}
