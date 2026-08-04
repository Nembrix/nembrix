//! Schema introspection — one cheap pass per (database, refresh) so the
//! editor's autocomplete and sidebar tree can be populated up front.

use db_core::{
    ColumnNode, DatabaseNode, DbError, DbResult, ForeignKey, FunctionNode, IndexNode, RelationNode,
    SchemaNode, SchemaTree,
};
use sqlx::{Pool, Postgres, Row};
use std::collections::BTreeMap;

pub async fn introspect(pool: &Pool<Postgres>) -> DbResult<SchemaTree> {
    let db_name: String = sqlx::query_scalar("SELECT current_database()")
        .persistent(false)
        .fetch_one(pool)
        .await
        .map_err(|e| DbError::Driver(e.to_string()))?;

    // Schemas — skip pg_* and information_schema unless they're useful.
    // We keep `public`, user-created schemas, and pg_catalog (handy for power users).
    let schemas: Vec<String> = sqlx::query_scalar(
        "SELECT n.nspname FROM pg_namespace n
         WHERE n.nspname NOT LIKE 'pg_temp_%'
           AND n.nspname NOT LIKE 'pg_toast%'
           AND n.nspname <> 'information_schema'
         ORDER BY (n.nspname = 'public') DESC, n.nspname",
    )
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    // One pass for all relations across all schemas.
    // relkind: r=table, v=view, m=matview
    let rel_rows = sqlx::query(
        r#"
        SELECT n.nspname AS schema,
               c.relname AS name,
               c.relkind AS kind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v','m')
          AND n.nspname NOT LIKE 'pg_temp_%'
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname <> 'information_schema'
        ORDER BY n.nspname, c.relname
        "#,
    )
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    // Columns for every (schema, table). One round trip via information_schema.
    let col_rows = sqlx::query(
        r#"
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default,
               ordinal_position
        FROM information_schema.columns
        WHERE table_schema NOT LIKE 'pg_%'
          AND table_schema <> 'information_schema'
        ORDER BY table_schema, table_name, ordinal_position
        "#,
    )
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    let pk_rows = sqlx::query(
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
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    // Foreign keys via pg_constraint (FOREIGN KEY = 'f').
    // conkey / confkey are int2[] (column attnums); we join pg_attribute twice
    // to expand them into column names. unnest WITH ORDINALITY keeps the
    // multi-column ordering aligned.
    let fk_rows = sqlx::query(
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
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    // Indexes via pg_index + pg_class + pg_am.
    let idx_rows = sqlx::query(
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
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    // User-defined functions only. prokind='f' keeps plain functions
    // (drops aggregates, window fns, procedures). The pg_depend check
    // excludes anything owned by an installed extension (e.g. postgis,
    // pgcrypto, hstore) — built-ins and extension routines should NOT
    // clutter the inspector's "Functions" list.
    let func_rows = sqlx::query(
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
    .persistent(false)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Driver(e.to_string()))?;

    // Index columns by (schema, table).
    let mut cols: BTreeMap<(String, String), Vec<ColumnNode>> = BTreeMap::new();
    for r in &col_rows {
        let sc: String = r.get("table_schema");
        let tn: String = r.get("table_name");
        cols.entry((sc, tn)).or_default().push(ColumnNode {
            name: r.get("column_name"),
            type_name: r.get("data_type"),
            nullable: matches!(r.get::<String, _>("is_nullable").as_str(), "YES"),
            default: r.get::<Option<String>, _>("column_default"),
        });
    }

    let mut pks: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for r in &pk_rows {
        let sc: String = r.get("table_schema");
        let tn: String = r.get("table_name");
        pks.entry((sc, tn)).or_default().push(r.get("column_name"));
    }

    let mut fks_by_table: BTreeMap<(String, String), Vec<ForeignKey>> = BTreeMap::new();
    for r in &fk_rows {
        let sc: String = r.get("schema");
        let tn: String = r.get("table_name");
        let cols: Vec<String> = r.try_get::<Vec<String>, _>("columns").unwrap_or_default();
        let ref_cols: Vec<String> = r
            .try_get::<Vec<String>, _>("ref_columns")
            .unwrap_or_default();
        fks_by_table.entry((sc, tn)).or_default().push(ForeignKey {
            name: r.get("name"),
            columns: cols,
            referenced_schema: r.get("ref_schema"),
            referenced_table: r.get("ref_table"),
            referenced_columns: ref_cols,
        });
    }

    let mut idx_by_table: BTreeMap<(String, String), Vec<IndexNode>> = BTreeMap::new();
    for r in &idx_rows {
        let sc: String = r.get("schema");
        let tn: String = r.get("table_name");
        let columns: Vec<String> = r.try_get::<Vec<String>, _>("columns").unwrap_or_default();
        idx_by_table.entry((sc, tn)).or_default().push(IndexNode {
            name: r.get("name"),
            columns,
            is_unique: r.get("is_unique"),
            is_primary: r.get("is_primary"),
            method: r.get("method"),
            definition: r.get("definition"),
        });
    }

    let mut funcs_by_schema: BTreeMap<String, Vec<FunctionNode>> = BTreeMap::new();
    for r in &func_rows {
        let sc: String = r.get("schema");
        let args: String = r.get::<Option<String>, _>("args").unwrap_or_default();
        funcs_by_schema.entry(sc).or_default().push(FunctionNode {
            name: r.get("name"),
            return_type: r
                .get::<Option<String>, _>("return_type")
                .unwrap_or_default(),
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
        let sc: String = r.get("schema");
        let nm: String = r.get("name");
        let kind: i8 = r.get::<i8, _>("kind");
        let key = (sc.clone(), nm.clone());
        let node = RelationNode {
            name: nm,
            columns: cols.remove(&key).unwrap_or_default(),
            primary_key: pks.remove(&key).unwrap_or_default(),
            foreign_keys: fks_by_table.remove(&key).unwrap_or_default(),
            indexes: idx_by_table.remove(&key).unwrap_or_default(),
        };
        // 'r' = 0x72, 'v' = 0x76, 'm' = 0x6d
        match kind as u8 as char {
            'r' => tables_by_schema.entry(sc).or_default().push(node),
            'v' | 'm' => views_by_schema.entry(sc).or_default().push(node),
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
