//! Quick object operations: rename / copy / duplicate / drop for databases,
//! schemas, and tables. Every op is exposed as a `preview()` that returns
//! the SQL we *would* run, and an `apply()` that runs it. The frontend
//! always shows the preview before applying.
//!
//! Caveats baked into the API:
//! - Postgres can't rename the database you're currently connected to.
//!   `rename_database` errors with [`OpError::ConnectedToTarget`] in that case.
//! - `CREATE DATABASE x WITH TEMPLATE y` requires that no sessions be
//!   connected to `y`. If `y` is the current DB, error the same way.
//! - Table duplicates default to **schema + data**; `with_data=false` makes
//!   it `CREATE TABLE … (LIKE … INCLUDING ALL)` instead (no rows copied).

use sqlx::{Pool, Postgres};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("cannot perform this op on the database you're connected to ({0}); reconnect to a different DB first")]
    ConnectedToTarget(String),
    #[error("invalid identifier: {0}")]
    InvalidIdent(String),
}

pub type Result<T> = std::result::Result<T, OpError>;

/// Quote an SQL identifier the Postgres way: double-quote and escape inner
/// quotes. Refuses NULs and empties — anything else is fair game and the
/// server will reject pathological names at parse time.
pub fn qi(ident: &str) -> Result<String> {
    if ident.is_empty() || ident.contains('\0') {
        return Err(OpError::InvalidIdent(ident.to_string()));
    }
    Ok(format!("\"{}\"", ident.replace('"', "\"\"")))
}

fn qq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// What an op intends to do, before we run it. The frontend renders this.
#[derive(Debug, Clone)]
pub struct OpPreview {
    pub sql: Vec<String>,
    pub warnings: Vec<String>,
}

// ───────────────────────── databases ─────────────────────────

pub fn preview_rename_database(from: &str, to: &str) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!("ALTER DATABASE {} RENAME TO {};", qi(from)?, qi(to)?)],
        warnings: vec![
            "Postgres can't rename the DB you're connected to — this runs against a sibling DB.".into(),
        ],
    })
}

/// Duplicates a database via `CREATE DATABASE … WITH TEMPLATE …`.
/// Server-side this is a fast file copy; no rows shipped over the wire.
pub fn preview_duplicate_database(source: &str, dest: &str) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!(
            "CREATE DATABASE {} WITH TEMPLATE {} OWNER CURRENT_USER;",
            qi(dest)?,
            qi(source)?
        )],
        warnings: vec![
            "Source DB must have zero active sessions while this runs.".into(),
        ],
    })
}

pub fn preview_drop_database(name: &str) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!("DROP DATABASE {} WITH (FORCE);", qi(name)?)],
        warnings: vec!["DROP … WITH (FORCE) terminates active sessions on the target DB.".into()],
    })
}

// ───────────────────────── schemas ─────────────────────────

pub fn preview_rename_schema(from: &str, to: &str) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!("ALTER SCHEMA {} RENAME TO {};", qi(from)?, qi(to)?)],
        warnings: vec![],
    })
}

// ───────────────────────── tables ─────────────────────────

pub fn preview_rename_table(schema: &str, from: &str, to: &str) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!(
            "ALTER TABLE {}.{} RENAME TO {};",
            qi(schema)?,
            qi(from)?,
            qi(to)?
        )],
        warnings: vec![],
    })
}

/// Move a table to a different schema (a "copy to schema" in the UI).
pub fn preview_move_table(
    schema: &str,
    name: &str,
    target_schema: &str,
) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!(
            "ALTER TABLE {}.{} SET SCHEMA {};",
            qi(schema)?,
            qi(name)?,
            qi(target_schema)?
        )],
        warnings: vec![],
    })
}

/// Duplicate a table. `with_data=true` runs `CREATE TABLE AS SELECT *` (rows
/// included, no constraints/indexes). `with_data=false` runs
/// `CREATE TABLE … (LIKE src INCLUDING ALL)` (constraints/indexes/defaults,
/// zero rows).
pub fn preview_duplicate_table(
    schema: &str,
    src: &str,
    dest_schema: &str,
    dest: &str,
    with_data: bool,
) -> Result<OpPreview> {
    let sql = if with_data {
        vec![format!(
            "CREATE TABLE {}.{} AS SELECT * FROM {}.{};",
            qi(dest_schema)?,
            qi(dest)?,
            qi(schema)?,
            qi(src)?
        )]
    } else {
        vec![format!(
            "CREATE TABLE {}.{} (LIKE {}.{} INCLUDING ALL);",
            qi(dest_schema)?,
            qi(dest)?,
            qi(schema)?,
            qi(src)?
        )]
    };
    let warnings = if with_data {
        vec!["CREATE TABLE AS does NOT copy indexes, constraints, or defaults.".into()]
    } else {
        vec![]
    };
    Ok(OpPreview { sql, warnings })
}

pub fn preview_drop_table(schema: &str, name: &str, cascade: bool) -> Result<OpPreview> {
    Ok(OpPreview {
        sql: vec![format!(
            "DROP TABLE {}.{}{};",
            qi(schema)?,
            qi(name)?,
            if cascade { " CASCADE" } else { "" }
        )],
        warnings: if cascade {
            vec!["CASCADE will drop dependent views, foreign keys, etc.".into()]
        } else {
            vec![]
        },
    })
}

// ───────────────────────── apply ─────────────────────────

/// Run every statement in `preview.sql` in a single transaction.
/// Refuses if the connected DB matches `forbidden_target` — used by the
/// rename/duplicate/drop database ops to avoid self-targeted Postgres errors.
pub async fn apply(
    pool: &Pool<Postgres>,
    preview: &OpPreview,
    forbidden_target: Option<&str>,
) -> Result<()> {
    if let Some(target) = forbidden_target {
        let current: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(pool)
            .await?;
        if current == target {
            return Err(OpError::ConnectedToTarget(target.to_string()));
        }
    }
    let mut tx = pool.begin().await?;
    for stmt in &preview.sql {
        sqlx::query(stmt).execute(tx.as_mut()).await?;
    }
    tx.commit().await?;
    Ok(())
}
