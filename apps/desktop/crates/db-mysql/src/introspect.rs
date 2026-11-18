//! Schema introspection for MySQL / MariaDB, shaped to fit [`SchemaTree`].
//!
//! MySQL has no level between server and table: a "database" *is* a schema
//! (`information_schema.SCHEMATA`). So the tree is one [`DatabaseNode`] for
//! the server whose [`SchemaNode`]s are its databases — the connection's own
//! database first (the frontend opens `schemas[0]` by default), system
//! databases hidden. Everything comes from `information_schema` in a fixed
//! number of round trips, whatever the table count.

use std::collections::BTreeMap;

use db_core::{
    ColumnNode, DatabaseNode, DbError, DbResult, ForeignKey, FunctionNode, IndexNode, RelationNode,
    SchemaNode, SchemaTree,
};
use mysql_async::prelude::*;
use mysql_async::Conn;

const SYSTEM_SCHEMAS: &[&str] = &["mysql", "information_schema", "performance_schema", "sys"];

fn drv(e: mysql_async::Error) -> DbError {
    DbError::Driver(crate::mysql_err(&e))
}

/// `IN (?, ?, …)` for `n` parameters.
fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

#[derive(Default)]
struct Rel {
    is_view: bool,
    columns: Vec<ColumnNode>,
    primary_key: Vec<String>,
    foreign_keys: Vec<ForeignKey>,
    indexes: Vec<IndexNode>,
}

pub async fn introspect(conn: &mut Conn, default_db: Option<&str>) -> DbResult<SchemaTree> {
    let mut schemas: Vec<String> = conn
        .query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
        .await
        .map_err(drv)?;
    schemas.retain(|s| !SYSTEM_SCHEMAS.contains(&s.to_ascii_lowercase().as_str()));
    if let Some(db) = default_db {
        if let Some(pos) = schemas.iter().position(|s| s == db) {
            let pinned = schemas.remove(pos);
            schemas.insert(0, pinned);
        }
    }
    let server = default_db.unwrap_or("mysql").to_string();
    if schemas.is_empty() {
        return Ok(SchemaTree {
            databases: vec![DatabaseNode {
                name: server,
                schemas: Vec::new(),
            }],
        });
    }
    let ph = placeholders(schemas.len());
    let params =
        mysql_async::Params::Positional(schemas.iter().map(|s| s.as_str().into()).collect());

    // Relations, keyed (schema, table) in name order.
    let mut rels: BTreeMap<(String, String), Rel> = BTreeMap::new();
    let tables: Vec<(String, String, String)> = conn
        .exec(
            format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA IN ({ph})"
            ),
            params.clone(),
        )
        .await
        .map_err(drv)?;
    for (schema, table, ty) in tables {
        rels.entry((schema, table)).or_default().is_view = ty.eq_ignore_ascii_case("VIEW");
    }

    let columns: Vec<(String, String, String, String, String, Option<String>)> = conn
        .exec(
            format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, \
                        COLUMN_DEFAULT \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN ({ph}) \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
            ),
            params.clone(),
        )
        .await
        .map_err(drv)?;
    for (schema, table, name, ty, is_null, default) in columns {
        if let Some(rel) = rels.get_mut(&(schema, table)) {
            rel.columns.push(ColumnNode {
                name,
                type_name: ty,
                nullable: is_null.eq_ignore_ascii_case("YES"),
                default,
            });
        }
    }

    // Indexes (incl. PRIMARY) from STATISTICS, one row per indexed column.
    let stats: Vec<(String, String, String, i64, String, String)> = conn
        .exec(
            format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE \
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN ({ph}) \
                 AND COLUMN_NAME IS NOT NULL \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
            ),
            params.clone(),
        )
        .await
        .map_err(drv)?;
    for (schema, table, index, non_unique, column, method) in stats {
        let Some(rel) = rels.get_mut(&(schema, table.clone())) else {
            continue;
        };
        let is_primary = index == "PRIMARY";
        if is_primary {
            rel.primary_key.push(column.clone());
        }
        match rel.indexes.iter_mut().find(|i| i.name == index) {
            Some(i) => i.columns.push(column),
            None => rel.indexes.push(IndexNode {
                name: index,
                columns: vec![column],
                is_unique: non_unique == 0,
                is_primary,
                method: method.to_ascii_lowercase(),
                definition: String::new(),
            }),
        }
    }
    for ((_, table), rel) in rels.iter_mut() {
        for i in &mut rel.indexes {
            i.definition = index_definition(table, i);
        }
    }

    // Foreign keys, one row per column pair.
    let fks: Vec<(String, String, String, String, String, String, String)> = conn
        .exec(
            format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, \
                        REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA IN ({ph}) AND REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"
            ),
            params.clone(),
        )
        .await
        .map_err(drv)?;
    for (schema, table, name, column, ref_schema, ref_table, ref_column) in fks {
        let Some(rel) = rels.get_mut(&(schema, table)) else {
            continue;
        };
        match rel.foreign_keys.iter_mut().find(|f| f.name == name) {
            Some(f) => {
                f.columns.push(column);
                f.referenced_columns.push(ref_column);
            }
            None => rel.foreign_keys.push(ForeignKey {
                name,
                columns: vec![column],
                referenced_schema: ref_schema,
                referenced_table: ref_table,
                referenced_columns: vec![ref_column],
            }),
        }
    }

    // Stored functions and procedures with their parameter types.
    let routines: Vec<(String, String, String, String)> = conn
        .exec(
            format!(
                "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, COALESCE(DTD_IDENTIFIER, '') \
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN ({ph}) \
                 ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME"
            ),
            params.clone(),
        )
        .await
        .map_err(drv)?;
    let routine_params: Vec<(String, String, String)> = conn
        .exec(
            format!(
                "SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, DTD_IDENTIFIER \
                 FROM information_schema.PARAMETERS \
                 WHERE SPECIFIC_SCHEMA IN ({ph}) AND ORDINAL_POSITION > 0 \
                 ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION"
            ),
            params,
        )
        .await
        .map_err(drv)?;
    let mut funcs: BTreeMap<String, Vec<FunctionNode>> = BTreeMap::new();
    for (schema, name, kind, returns) in routines {
        let argument_types = routine_params
            .iter()
            .filter(|(s, n, _)| *s == schema && *n == name)
            .map(|(_, _, t)| t.clone())
            .collect();
        funcs.entry(schema).or_default().push(FunctionNode {
            name,
            // Procedures return nothing; label them so the tree tells them apart.
            return_type: if kind.eq_ignore_ascii_case("PROCEDURE") {
                "procedure".into()
            } else {
                returns
            },
            argument_types,
        });
    }

    let mut nodes: Vec<SchemaNode> = schemas
        .iter()
        .map(|name| SchemaNode {
            name: name.clone(),
            tables: Vec::new(),
            views: Vec::new(),
            functions: funcs.remove(name).unwrap_or_default(),
        })
        .collect();
    for ((schema, table), rel) in rels {
        let Some(node) = nodes.iter_mut().find(|n| n.name == schema) else {
            continue;
        };
        let relation = RelationNode {
            name: table,
            columns: rel.columns,
            primary_key: rel.primary_key,
            foreign_keys: rel.foreign_keys,
            indexes: rel.indexes,
        };
        if rel.is_view {
            node.views.push(relation);
        } else {
            node.tables.push(relation);
        }
    }

    Ok(SchemaTree {
        databases: vec![DatabaseNode {
            name: server,
            schemas: nodes,
        }],
    })
}

/// DDL-ish one-liner for the Info panel, e.g.
/// ``UNIQUE INDEX `uq_email` ON `users` USING BTREE (`email`)``.
fn index_definition(table: &str, i: &IndexNode) -> String {
    let q = |s: &str| format!("`{}`", s.replace('`', "``"));
    let cols = i
        .columns
        .iter()
        .map(|c| q(c))
        .collect::<Vec<_>>()
        .join(", ");
    if i.is_primary {
        return format!("PRIMARY KEY ({cols})");
    }
    let unique = if i.is_unique { "UNIQUE " } else { "" };
    format!(
        "{unique}INDEX {} ON {} USING {} ({cols})",
        q(&i.name),
        q(table),
        i.method.to_ascii_uppercase()
    )
}
