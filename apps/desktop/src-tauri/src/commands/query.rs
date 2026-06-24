use crate::state::AppState;
use db_core::{ExecSummary, QueryHandle, RowBatch};
use sql_format::FormatConfig;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
#[specta::specta]
pub async fn execute(
    state: State<'_, AppState>,
    conn_id: Uuid,
    sql: String,
) -> Result<ExecSummary, String> {
    let g = state.conns.read().await;
    let live = g.get(&conn_id).ok_or("not connected")?;
    let started = std::time::Instant::now();
    let res = live
        .db
        .execute(&sql, vec![])
        .await
        .map_err(|e| e.to_string())?;
    let _ = state
        .store
        .record_query(conn_id, &sql, started.elapsed().as_millis() as u64);
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub async fn stream(
    state: State<'_, AppState>,
    conn_id: Uuid,
    sql: String,
    sink: Channel<RowBatch>,
) -> Result<QueryHandle, String> {
    let g = state.conns.read().await;
    let live = g.get(&conn_id).ok_or("not connected")?;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<RowBatch>(8);

    // Bridge mpsc → Tauri Channel. The Channel is per-invocation and typed.
    let sink_c = sink.clone();
    tokio::spawn(async move {
        while let Some(batch) = rx.recv().await {
            let _ = sink_c.send(batch);
        }
    });

    let started = std::time::Instant::now();
    let handle = live
        .db
        .stream(&sql, vec![], tx)
        .await
        .map_err(|e| e.to_string())?;
    let _ = state
        .store
        .record_query(conn_id, &sql, started.elapsed().as_millis() as u64);
    Ok(handle)
}

#[tauri::command]
#[specta::specta]
pub async fn cancel(
    state: State<'_, AppState>,
    conn_id: Uuid,
    handle: QueryHandle,
) -> Result<(), String> {
    let g = state.conns.read().await;
    let live = g.get(&conn_id).ok_or("not connected")?;
    live.db.cancel(handle).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn format_sql(sql: String, cfg: Option<FormatConfig>) -> Result<String, String> {
    Ok(sql_format::format(&sql, cfg.unwrap_or_default()))
}
