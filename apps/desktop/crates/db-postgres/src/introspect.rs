//! Schema introspection — one cheap pass per (database, refresh) so the
//! editor's autocomplete and sidebar tree can be populated up front.
//!
//! Every query runs on the **simple query protocol** (`simple_query`) for the
//! same pooler-safety reason as the rest of the driver (see crate docs). That
//! means all values arrive as text and array columns come back in Postgres'
//! `{a,b,c}` array-literal form, which we parse by hand (see [`parse_pg_array`]).

use db_core::{
    ColumnNode, DatabaseNode, DbError, DbResult, ForeignKey, FunctionNode, IndexNode, RelationNode,
    SchemaNode, SchemaTree,
};
use std::collections::BTreeMap;
use tokio_postgres::{Client, SimpleQueryMessage, SimpleQueryRow};

/// Run a `simple_query` and return only its data rows.
async fn rows(client: &Client, sql: &str) -> DbResult<Vec<SimpleQueryRow>> {
    let msgs = client
        .simple_query(sql)
        .await
        .map_err(|e| DbError::Driver(e.to_string()))?;
    Ok(msgs
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => Some(r),
            _ => None,
        })
        .collect())
}

/// Column value by name, as an owned `String` (empty when NULL/absent).
fn col(row: &SimpleQueryRow, name: &str) -> String {
    row.get(name).unwrap_or("").to_string()
}

/// Parse a Postgres array literal (`{a,b,"c,d"}`) into its elements. Handles
/// quoted elements with escaped quotes/backslashes; returns an empty vec for
/// `{}` or a NULL/empty input.
fn parse_pg_array(s: &str) -> Vec<String> {
    let s = s.trim();
    if s.len() < 2 || !s.starts_with('{') || !s.ends_with('}') {
        return Vec::new();
    }
    let inner = &s[1..s.len() - 1];
    if inner.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if !in_quotes => in_quotes = true,
            '"' if in_quotes => in_quotes = false,
            '\\' if in_quotes => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            }
            ',' if !in_quotes => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    out.push(cur);
    // Unquoted NULL elements come through as the literal token `NULL`; the
    // schema paths that use this (FK/index columns) never contain NULLs, so we
    // keep them verbatim rather than special-casing.
    out
}

pub async fn introspect(client: &Client) -> DbResult<SchemaTree> {
    let db_name = rows(client, "SELECT current_database() AS db")
        .await?
        .first()
        .map(|r| col(r, "db"))
        .unwrap_or_default();

    // Schemas — show user schemas only. Hide the Postgres internals
    // (pg_catalog, pg_toast, pg_temp*, information_schema); otherwise the
    // inspector defaults to pg_catalog's ~140 system tables instead of the
    // user's own `public` schema, which reads as "wrong / not my tables".
    let schema_rows = rows(
        client,
        "SELECT n.nspname AS name FROM pg_namespace n
         WHERE n.nspname NOT LIKE 'pg_%'
           AND n.nspname <> 'information_schema'
         ORDER BY (n.nspname = 'public') DESC, n.nspname",
    )
    .await?;
    let schemas: Vec<String> = schema_rows.iter().map(|r| col(r, "name")).collect();

    // One pass for all relations across all schemas.
    // relkind: r=table, v=view, m=matview
    let rel_rows = rows(
        client,
        r#"
        SELECT n.nspname AS schema,
               c.relname AS name,
               c.relkind AS kind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v','m')
          AND n.nspname NOT LIKE 'pg_%'
          AND n.nspname <> 'information_schema'
        ORDER BY n.nspname, c.relname
        "#,
    )
    .await?;

    // Columns for every (schema, table). One round trip via information_schema.
    let col_rows = rows(
        client,
        r#"
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default,
               ordinal_position
        FROM information_schema.columns
        WHERE table_schema NOT LIKE 'pg_%'
          AND table_schema <> 'information_schema'
        ORDER BY table_schema, table_name, ordinal_position
        "#,
    )
    .await?;

    let pk_rows = rows(
        client,
        r#"
        SELECT tc.table_schema, tc.table_name, kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
        ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
        "#,
    )
    .await?;

    // Foreign keys via pg_constraint (FOREIGN KEY = 'f').
    // conkey / confkey are int2[] (column attnums); we join pg_attribute twice
    // to expand them into column names. unnest WITH ORDINALITY keeps the
    // multi-column ordering aligned. The array_agg results come back as
    // Postgres array literals we parse client-side.
    let fk_rows = rows(
        client,
        r#"
        WITH fks AS (
            SELECT c.conname,
                   c.conrelid,
                   c.confrelid,
                   c.conkey,
                   c.confkey,
                   ns.nspname AS schema,
                   cl.relname AS table_name,
                   rns.nspname AS ref_schema,
                   rcl.relname AS ref_table
            FROM pg_constraint c
            JOIN pg_class      cl  ON cl.oid  = c.conrelid
            JOIN pg_namespace  ns  ON ns.oid  = cl.relnamespace
            JOIN pg_class      rcl ON rcl.oid = c.confrelid
            JOIN pg_namespace  rns ON rns.oid = rcl.relnamespace
            WHERE c.contype = 'f'
              AND ns.nspname NOT LIKE 'pg_%'
              AND ns.nspname <> 'information_schema'
        )
        SELECT
            fks.conname AS name,
            fks.schema,
            fks.table_name,
            fks.ref_schema,
            fks.ref_table,
            (SELECT array_agg(a.attname ORDER BY ord)
               FROM unnest(fks.conkey)  WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = fks.conrelid AND a.attnum = u.attnum
            ) AS columns,
            (SELECT array_agg(a.attname ORDER BY ord)
               FROM unnest(fks.confkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = fks.confrelid AND a.attnum = u.attnum
            ) AS ref_columns
        FROM fks
        ORDER BY fks.schema, fks.table_name, fks.conname
        "#,
    )
    .await?;

    // Indexes via pg_index + pg_class + pg_am.
    let idx_rows = rows(
        client,
        r#"
        SELECT n.nspname AS schema,
               t.relname AS table_name,
               i.relname AS name,
               ix.indisunique AS is_unique,
               ix.indisprimary AS is_primary,
               am.amname AS method,
               pg_get_indexdef(ix.indexrelid) AS definition,
               (SELECT array_agg(a.attname ORDER BY k.ord)
                  FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
               ) AS columns
        FROM pg_index ix
        JOIN pg_class t      ON t.oid = ix.indrelid
        JOIN pg_class i      ON i.oid = ix.indexrelid
        JOIN pg_namespace n  ON n.oid = t.relnamespace
        JOIN pg_am am        ON am.oid = i.relam
        WHERE n.nspname NOT LIKE 'pg_%'
          AND n.nspname <> 'information_schema'
        ORDER BY n.nspname, t.relname, i.relname
        "#,
    )
    .await?;

    // User-defined functions only. prokind='f' keeps plain functions
    // (drops aggregates, window fns, procedures). The pg_depend check
    // excludes anything owned by an installed extension (e.g. postgis,
    // pgcrypto, hstore) — built-ins and extension routines should NOT
    // clutter the inspector's "Functions" list.
    let func_rows = rows(
        client,
        r#"
        SELECT n.nspname AS schema,
               p.proname AS name,
               pg_get_function_result(p.oid) AS return_type,
               pg_get_function_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT LIKE 'pg_%'
          AND n.nspname <> 'information_schema'
          AND p.prokind = 'f'
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
               WHERE d.objid = p.oid AND d.deptype = 'e'
          )
        ORDER BY n.nspname, p.proname
        "#,
    )
    .await?;

    // Index columns by (schema, table).
    let mut cols: BTreeMap<(String, String), Vec<ColumnNode>> = BTreeMap::new();
    for r in &col_rows {
        let sc = col(r, "table_schema");
        let tn = col(r, "table_name");
        let default = r.get("column_default").map(|s| s.to_string());
        cols.entry((sc, tn)).or_default().push(ColumnNode {
            name: col(r, "column_name"),
            type_name: col(r, "data_type"),
            nullable: col(r, "is_nullable") == "YES",
            default,
        });
    }

    let mut pks: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for r in &pk_rows {
        let sc = col(r, "table_schema");
        let tn = col(r, "table_name");
        pks.entry((sc, tn)).or_default().push(col(r, "column_name"));
    }

    let mut fks_by_table: BTreeMap<(String, String), Vec<ForeignKey>> = BTreeMap::new();
    for r in &fk_rows {
        let sc = col(r, "schema");
        let tn = col(r, "table_name");
        fks_by_table.entry((sc, tn)).or_default().push(ForeignKey {
            name: col(r, "name"),
            columns: parse_pg_array(&col(r, "columns")),
            referenced_schema: col(r, "ref_schema"),
            referenced_table: col(r, "ref_table"),
            referenced_columns: parse_pg_array(&col(r, "ref_columns")),
        });
    }

    let mut idx_by_table: BTreeMap<(String, String), Vec<IndexNode>> = BTreeMap::new();
    for r in &idx_rows {
        let sc = col(r, "schema");
        let tn = col(r, "table_name");
        idx_by_table.entry((sc, tn)).or_default().push(IndexNode {
            name: col(r, "name"),
            columns: parse_pg_array(&col(r, "columns")),
            is_unique: col(r, "is_unique") == "t",
            is_primary: col(r, "is_primary") == "t",
            method: col(r, "method"),
            definition: col(r, "definition"),
        });
    }

    let mut funcs_by_schema: BTreeMap<String, Vec<FunctionNode>> = BTreeMap::new();
    for r in &func_rows {
        let sc = col(r, "schema");
        let args = col(r, "args");
        funcs_by_schema.entry(sc).or_default().push(FunctionNode {
            name: col(r, "name"),
            return_type: col(r, "return_type"),
            argument_types: args
                .split(',')
                .filter_map(|s| {
                    let s = s.trim();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.to_string())
                    }
                })
                .collect(),
        });
    }

    let mut tables_by_schema: BTreeMap<String, Vec<RelationNode>> = BTreeMap::new();
    let mut views_by_schema: BTreeMap<String, Vec<RelationNode>> = BTreeMap::new();
    for r in &rel_rows {
        let sc = col(r, "schema");
        let nm = col(r, "name");
        let kind = col(r, "kind");
        let key = (sc.clone(), nm.clone());
        let node = RelationNode {
            name: nm,
            columns: cols.remove(&key).unwrap_or_default(),
            primary_key: pks.remove(&key).unwrap_or_default(),
            foreign_keys: fks_by_table.remove(&key).unwrap_or_default(),
            indexes: idx_by_table.remove(&key).unwrap_or_default(),
        };
        match kind.as_str() {
            "r" => tables_by_schema.entry(sc).or_default().push(node),
            "v" | "m" => views_by_schema.entry(sc).or_default().push(node),
            _ => {}
        }
    }

    let schema_nodes = schemas
        .into_iter()
        .map(|name| {
            let tables = tables_by_schema.remove(&name).unwrap_or_default();
            let views = views_by_schema.remove(&name).unwrap_or_default();
            let functions = funcs_by_schema.remove(&name).unwrap_or_default();
            SchemaNode {
                name,
                tables,
                views,
                functions,
            }
        })
        .collect();

    Ok(SchemaTree {
        databases: vec![DatabaseNode {
            name: db_name,
            schemas: schema_nodes,
        }],
    })
}
