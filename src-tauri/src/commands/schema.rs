use crate::state::AppState;
use db_core::{DbConnection, SchemaTree};
use tauri::State;
use uuid::Uuid;

#[tauri::command]
#[specta::specta]
pub async fn introspect(state: State<'_, AppState>, conn_id: Uuid) -> Result<SchemaTree, String> {
    let g = state.conns.read().await;
    let live = g.get(&conn_id).ok_or("not connected")?;
    live.db.introspect().await.map_err(|e| e.to_string())
}
