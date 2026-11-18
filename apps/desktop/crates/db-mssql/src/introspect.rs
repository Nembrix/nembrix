//! Schema introspection for SQL Server, shaped to fit [`SchemaTree`].
//!
//! One [`DatabaseNode`] for the connection's current database (`DB_NAME()`)
//! — browsing builds two-part `[schema].[table]` names, which only resolve
//! there. Its schemas come from `sys.schemas`, the user's default schema first
//! (the frontend opens `schemas[0]` by default), system and fixed-role schemas
//! hidden. Everything comes from the `sys` catalog views in a fixed number of
//! round trips, whatever the table count.

use std::collections::BTreeMap;

use db_core::{
    ColumnNode, DatabaseNode, DbError, DbResult, ForeignKey, FunctionNode, IndexNode, RelationNode,
    SchemaNode, SchemaTree,
};
use tiberius::Row;

use crate::Client;

/// User objects only: tables, views, and the routine kinds.
const RELATIONS: &str = "o.type IN ('U', 'V') AND o.is_ms_shipped = 0";
const ROUTINES: &str =
    "o.type IN ('FN', 'IF', 'TF', 'P', 'FS', 'FT', 'PC') AND o.is_ms_shipped = 0";

async fn rows(client: &mut Client, sql: &str) -> DbResult<Vec<Row>> {
    let drv = |e: tiberius::error::Error| DbError::Driver(crate::mssql_err(&e));
    client
        .simple_query(sql)
        .await
        .map_err(drv)?
        .into_first_result()
        .await
        .map_err(drv)
}

fn text(r: &Row, i: usize) -> String {
    r.get::<&str, _>(i).unwrap_or_default().to_string()
}

#[derive(Default)]
struct Rel {
    is_view: bool,
    columns: Vec<ColumnNode>,
    primary_key: Vec<String>,
    foreign_keys: Vec<ForeignKey>,
    indexes: Vec<IndexNode>,
}

pub async fn introspect(client: &mut Client) -> DbResult<SchemaTree> {
    let db = rows(client, "SELECT DB_NAME()").await?;
    let database = db.first().map(|r| text(r, 0)).unwrap_or_default();

    // schema_id 2–4 are guest / INFORMATION_SCHEMA / sys; 16384+ are the
    // fixed database roles' schemas (db_owner, …).
    let schemas: Vec<String> = rows(
        client,
        "SELECT name FROM sys.schemas WHERE schema_id NOT IN (2, 3, 4) AND schema_id < 16384 \
         ORDER BY CASE WHEN name = SCHEMA_NAME() THEN 0 ELSE 1 END, name",
    )
    .await?
    .iter()
    .map(|r| text(r, 0))
    .collect();

    // Relations, keyed (schema, table) in name order.
    let mut rels: BTreeMap<(String, String), Rel> = BTreeMap::new();
    for r in rows(
        client,
        &format!(
            "SELECT s.name, o.name, o.type FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE {RELATIONS}"
        ),
    )
    .await?
    {
        rels.entry((text(&r, 0), text(&r, 1))).or_default().is_view = text(&r, 2).trim() == "V";
    }

    for r in rows(
        client,
        &format!(
            "SELECT s.name, o.name, c.name, t.name, c.max_length, c.precision, c.scale, \
                    c.is_nullable, dc.definition, c.is_identity \
             FROM sys.columns c \
             JOIN sys.objects o ON o.object_id = c.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             JOIN sys.types t ON t.user_type_id = c.user_type_id \
             LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
             WHERE {RELATIONS} ORDER BY s.name, o.name, c.column_id"
        ),
    )
    .await?
    {
        let Some(rel) = rels.get_mut(&(text(&r, 0), text(&r, 1))) else {
            continue;
        };
        let identity = r.get::<bool, _>(9).unwrap_or(false);
        rel.columns.push(ColumnNode {
            name: text(&r, 2),
            type_name: column_type(
                &text(&r, 3),
                r.get::<i16, _>(4).unwrap_or(0),
                r.get::<u8, _>(5).unwrap_or(0),
                r.get::<u8, _>(6).unwrap_or(0),
            ),
            nullable: r.get::<bool, _>(7).unwrap_or(true),
            // An identity column is server-generated, like a serial default.
            default: r
                .get::<&str, _>(8)
                .map(str::to_string)
                .or_else(|| identity.then(|| "IDENTITY".to_string())),
        });
    }

    // Indexes (incl. the primary key), one row per key column.
    for r in rows(
        client,
        &format!(
            "SELECT s.name, o.name, i.name, i.is_unique, i.is_primary_key, i.type_desc, \
                    c.name, ic.is_descending_key \
             FROM sys.indexes i \
             JOIN sys.objects o ON o.object_id = i.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE {RELATIONS} AND i.type > 0 AND i.is_hypothetical = 0 \
               AND ic.is_included_column = 0 AND ic.key_ordinal > 0 \
             ORDER BY s.name, o.name, i.name, ic.key_ordinal"
        ),
    )
    .await?
    {
        let Some(rel) = rels.get_mut(&(text(&r, 0), text(&r, 1))) else {
            continue;
        };
        let (index, column) = (text(&r, 2), text(&r, 6));
        let is_primary = r.get::<bool, _>(4).unwrap_or(false);
        if is_primary {
            rel.primary_key.push(column.clone());
        }
        let column = if r.get::<bool, _>(7).unwrap_or(false) {
            format!("{column} DESC")
        } else {
            column
        };
        match rel.indexes.iter_mut().find(|i| i.name == index) {
            Some(i) => i.columns.push(column),
            None => rel.indexes.push(IndexNode {
                name: index,
                columns: vec![column],
                is_unique: r.get::<bool, _>(3).unwrap_or(false),
                is_primary,
                method: text(&r, 5).to_ascii_lowercase(),
                definition: String::new(),
            }),
        }
    }
    for ((schema, table), rel) in rels.iter_mut() {
        for i in &mut rel.indexes {
            i.definition = index_definition(schema, table, i);
            // `DESC` was only for the definition; the column list is names.
            for c in &mut i.columns {
                if let Some(name) = c.strip_suffix(" DESC") {
                    *c = name.to_string();
                }
            }
        }
    }

    // Foreign keys, one row per column pair.
    for r in rows(
        client,
        "SELECT s.name, o.name, fk.name, pc.name, rs.name, ro.name, rc.name \
         FROM sys.foreign_keys fk \
         JOIN sys.objects o ON o.object_id = fk.parent_object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id \
         JOIN sys.schemas rs ON rs.schema_id = ro.schema_id \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
                            AND pc.column_id = fkc.parent_column_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id \
                            AND rc.column_id = fkc.referenced_column_id \
         ORDER BY s.name, o.name, fk.name, fkc.constraint_column_id",
    )
    .await?
    {
        let Some(rel) = rels.get_mut(&(text(&r, 0), text(&r, 1))) else {
            continue;
        };
        let (name, column, ref_column) = (text(&r, 2), text(&r, 3), text(&r, 6));
        match rel.foreign_keys.iter_mut().find(|f| f.name == name) {
            Some(f) => {
                f.columns.push(column);
                f.referenced_columns.push(ref_column);
            }
            None => rel.foreign_keys.push(ForeignKey {
                name,
                columns: vec![column],
                referenced_schema: text(&r, 4),
                referenced_table: text(&r, 5),
                referenced_columns: vec![ref_column],
            }),
        }
    }

    // Functions and procedures. A scalar function's return type is its
    // parameter 0; table-valued ones return a table.
    let routines = rows(
        client,
        &format!(
            "SELECT s.name, o.name, o.type FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE {ROUTINES} ORDER BY s.name, o.name"
        ),
    )
    .await?;
    let routine_params = rows(
        client,
        &format!(
            "SELECT s.name, o.name, p.parameter_id, t.name FROM sys.parameters p \
             JOIN sys.objects o ON o.object_id = p.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             JOIN sys.types t ON t.user_type_id = p.user_type_id \
             WHERE {ROUTINES} ORDER BY s.name, o.name, p.parameter_id"
        ),
    )
    .await?;
    let mut funcs: BTreeMap<String, Vec<FunctionNode>> = BTreeMap::new();
    for r in routines {
        let (schema, name) = (text(&r, 0), text(&r, 1));
        let mine = routine_params
            .iter()
            .filter(|p| text(p, 0) == schema && text(p, 1) == name);
        let mut returns = String::new();
        let mut argument_types = Vec::new();
        for p in mine {
            if p.get::<i32, _>(2) == Some(0) {
                returns = text(p, 3);
            } else {
                argument_types.push(text(p, 3));
            }
        }
        let return_type = match text(&r, 2).trim() {
            "P" | "PC" => "procedure".to_string(),
            "IF" | "TF" | "FT" => "table".to_string(),
            _ => returns,
        };
        funcs.entry(schema).or_default().push(FunctionNode {
            name,
            return_type,
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
            name: database,
            schemas: nodes,
        }],
    })
}

/// The declared type as written in DDL: `nvarchar(50)`, `varchar(max)`,
/// `decimal(10,2)`, `datetime2(3)`. `max_length` is in bytes (-1 for `max`),
/// so the UTF-16 types halve it.
pub fn column_type(name: &str, max_length: i16, precision: u8, scale: u8) -> String {
    let len = |chars: i16| {
        if max_length == -1 {
            "max".to_string()
        } else {
            chars.to_string()
        }
    };
    match name {
        "varchar" | "char" | "varbinary" | "binary" => format!("{name}({})", len(max_length)),
        "nvarchar" | "nchar" => format!("{name}({})", len(max_length / 2)),
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        // 7 is the default fractional-second precision; only show others.
        "datetime2" | "time" | "datetimeoffset" if scale != 7 => format!("{name}({scale})"),
        _ => name.to_string(),
    }
}

/// DDL-ish one-liner for the Info panel, e.g.
/// `UNIQUE NONCLUSTERED INDEX [uq_email] ON [dbo].[users] ([email])`.
fn index_definition(schema: &str, table: &str, i: &IndexNode) -> String {
    let q = |s: &str| format!("[{}]", s.replace(']', "]]"));
    let cols = i
        .columns
        .iter()
        .map(|c| match c.strip_suffix(" DESC") {
            Some(name) => format!("{} DESC", q(name)),
            None => q(c),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let kind = i.method.to_ascii_uppercase();
    if i.is_primary {
        return format!("PRIMARY KEY {kind} ({cols})");
    }
    let unique = if i.is_unique { "UNIQUE " } else { "" };
    format!(
        "{unique}{kind} INDEX {} ON {}.{} ({cols})",
        q(&i.name),
        q(schema),
        q(table)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_types_read_like_ddl() {
        assert_eq!(column_type("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(column_type("nvarchar", -1, 0, 0), "nvarchar(max)");
        assert_eq!(column_type("varbinary", 16, 0, 0), "varbinary(16)");
        assert_eq!(column_type("decimal", 9, 10, 2), "decimal(10,2)");
        assert_eq!(column_type("datetime2", 8, 27, 7), "datetime2");
        assert_eq!(column_type("datetime2", 7, 23, 3), "datetime2(3)");
        assert_eq!(column_type("int", 4, 10, 0), "int");
    }
}
