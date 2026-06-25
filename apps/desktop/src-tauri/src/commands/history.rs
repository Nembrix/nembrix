//! Query history + saved queries — read/write the local SQLite store.
//!
//! Per-connection scope so different DBs don't bleed into each other.
//! Saved queries also support an optional name + tags for grouping later.

use crate::state::AppState;
use secrets::{HistoryEntry, SavedRow as SavedQuery};
use tauri::State;
use uuid::Uuid;

#[tauri::command]
#[specta::specta]
pub async fn query_history(
    state: State<'_, AppState>,
    conn_id: Uuid,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    state
        .store
        .query_history(conn_id, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn list_saved_queries(
    state: State<'_, AppState>,
    conn_id: Option<Uuid>,
) -> Result<Vec<SavedQuery>, String> {
    state
        .store
        .list_saved_queries(conn_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn save_query(
    state: State<'_, AppState>,
    id: Option<Uuid>,
    conn_id: Option<Uuid>,
    name: String,
    sql: String,
) -> Result<SavedQuery, String> {
    let id = id.unwrap_or_else(Uuid::new_v4);
    let now = chrono::Utc::now();
    state
        .store
        .upsert_saved_query(id, conn_id, &name, &sql, now)
        .map_err(|e| e.to_string())?;
    Ok(SavedQuery {
        id,
        conn_id,
        name,
        sql,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn delete_saved_query(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    state
        .store
        .delete_saved_query(id)
        .map_err(|e| e.to_string())
}
