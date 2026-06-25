use crate::state::AppState;
use db_postgres::object_ops as ops;
use db_postgres::PgConn;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::{Pool, Postgres};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OpPreviewWire {
    pub sql: Vec<String>,
    pub warnings: Vec<String>,
}

impl From<ops::OpPreview> for OpPreviewWire {
    fn from(p: ops::OpPreview) -> Self {
        Self {
            sql: p.sql,
            warnings: p.warnings,
        }
    }
}

async fn pg_pool(state: &AppState, conn_id: Uuid) -> Result<Pool<Postgres>, String> {
    let g = state.conns.read().await;
    let live = g.get(&conn_id).ok_or("not connected")?;
    let pg = live
        .db
        .as_any()
        .downcast_ref::<PgConn>()
        .ok_or("connection is not Postgres")?;
    Ok(pg.pool().clone())
}

// ───────────────────────── databases ─────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn preview_rename_database(from: String, to: String) -> Result<OpPreviewWire, String> {
    ops::preview_rename_database(&from, &to)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preview_duplicate_database(
    source: String,
    dest: String,
) -> Result<OpPreviewWire, String> {
    ops::preview_duplicate_database(&source, &dest)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preview_drop_database(name: String) -> Result<OpPreviewWire, String> {
    ops::preview_drop_database(&name)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn apply_database_op(
    state: State<'_, AppState>,
    conn_id: Uuid,
    preview: OpPreviewWire,
    forbidden_target: Option<String>,
) -> Result<(), String> {
    let pool = pg_pool(&state, conn_id).await?;
    let p = ops::OpPreview {
        sql: preview.sql,
        warnings: preview.warnings,
    };
    ops::apply(&pool, &p, forbidden_target.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ───────────────────────── schemas ─────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn preview_rename_schema(from: String, to: String) -> Result<OpPreviewWire, String> {
    ops::preview_rename_schema(&from, &to)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

// ───────────────────────── tables ─────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn preview_rename_table(
    schema: String,
    from: String,
    to: String,
) -> Result<OpPreviewWire, String> {
    ops::preview_rename_table(&schema, &from, &to)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preview_move_table(
    schema: String,
    name: String,
    target_schema: String,
) -> Result<OpPreviewWire, String> {
    ops::preview_move_table(&schema, &name, &target_schema)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preview_duplicate_table(
    schema: String,
    src: String,
    dest_schema: String,
    dest: String,
    with_data: bool,
) -> Result<OpPreviewWire, String> {
    ops::preview_duplicate_table(&schema, &src, &dest_schema, &dest, with_data)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preview_drop_table(
    schema: String,
    name: String,
    cascade: bool,
) -> Result<OpPreviewWire, String> {
    ops::preview_drop_table(&schema, &name, cascade)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

/// Apply a previously-previewed table/schema op against the live connection.
#[tauri::command]
#[specta::specta]
pub async fn apply_object_op(
    state: State<'_, AppState>,
    conn_id: Uuid,
    preview: OpPreviewWire,
) -> Result<(), String> {
    let pool = pg_pool(&state, conn_id).await?;
    let p = ops::OpPreview {
        sql: preview.sql,
        warnings: preview.warnings,
    };
    ops::apply(&pool, &p, None).await.map_err(|e| e.to_string())
}
