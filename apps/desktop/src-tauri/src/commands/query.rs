use crate::state::AppState;
use async_trait::async_trait;
use db_core::{CellValue, ColMeta, DynConn, ExecSummary, QueryHandle, RowBatch};
use db_script::{QueryResult, QueryRunner, ScriptOutcome};
use sql_format::FormatConfig;
use std::sync::Arc;
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

/// Adapter that lets a running JS script issue queries against a live
/// connection. This is the P2 seam: `db-script` knows only the [`QueryRunner`]
/// trait, and this type implements it over `DbConnection::stream`, draining the
/// streamed [`RowBatch`]es into one materialized [`QueryResult`].
///
/// Note the driver signals query errors *in-band*: on failure it emits a final
/// batch with no columns whose single cell carries the error text (see
/// `db-postgres::stream`). We detect that shape and surface it as `Err` so the
/// script sees a real thrown exception, not a phantom one-cell result.
struct ScriptRunner {
    db: DynConn,
}

#[async_trait]
impl QueryRunner for ScriptRunner {
    async fn query(
        &self,
        sql: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<QueryResult, String> {
        // Bind the script's params positionally ($1, $2, …). We map the JS
        // JSON values to driver CellValues; the driver .binds() them, so
        // `db.query("… WHERE id = $1", [id])` is a real parameterized query
        // (no string interpolation, no injection surface).
        let bound: db_core::Params = params.into_iter().map(json_to_cell).collect();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<RowBatch>(8);
        self.db
            .stream(sql, bound, tx)
            .await
            .map_err(|e| e.to_string())?;

        let mut columns: Vec<String> = Vec::new();
        let mut got_columns = false;
        let mut rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();

        while let Some(batch) = rx.recv().await {
            // In-band error batch: no columns ever seen + a lone text cell on a
            // done batch means the driver is reporting an error, not data.
            if batch.done && !got_columns && is_error_batch(&batch) {
                let msg = batch
                    .rows
                    .first()
                    .and_then(|r| r.first())
                    .map(cell_to_string)
                    .unwrap_or_else(|| "query failed".into());
                return Err(msg);
            }

            if let Some(cols) = batch.columns {
                columns = cols.iter().map(|c: &ColMeta| c.name.clone()).collect();
                got_columns = true;
            }
            for row in batch.rows {
                let mut obj = serde_json::Map::with_capacity(columns.len());
                for (i, cell) in row.into_iter().enumerate() {
                    let key = columns.get(i).cloned().unwrap_or_else(|| format!("col{i}"));
                    obj.insert(key, cell_to_json(cell));
                }
                rows.push(obj);
            }
            if batch.done {
                break;
            }
        }

        Ok(QueryResult { columns, rows })
    }
}

/// A batch is an error signal when it carries exactly one single-cell row and
/// that cell is text — the shape `db-postgres::stream` uses for `acquire:` /
/// driver errors. A legitimate one-column, one-row result would have arrived
/// *with* a `columns` header, which the caller checks separately.
fn is_error_batch(batch: &RowBatch) -> bool {
    batch.columns.is_none()
        && batch.rows.len() == 1
        && batch.rows[0].len() == 1
        && matches!(batch.rows[0][0], CellValue::Text(_))
}

fn cell_to_string(cell: &CellValue) -> String {
    match cell {
        CellValue::Text(s) | CellValue::Raw(s) => s.clone(),
        other => cell_to_json(other.clone()).to_string(),
    }
}

/// Project a driver [`CellValue`] into JSON for the script. Big/lossless types
/// (`Raw`) stay strings so precision survives; bytes become base64-ish text so
/// a script at least sees *something* rather than a panic.
fn cell_to_json(cell: CellValue) -> serde_json::Value {
    use serde_json::Value;
    match cell {
        CellValue::Null => Value::Null,
        CellValue::Bool(b) => Value::Bool(b),
        CellValue::Int(i) => Value::from(i),
        CellValue::Float(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        CellValue::Text(s) | CellValue::Raw(s) => Value::String(s),
        CellValue::Document(v) => v,
        CellValue::Bytes(b) => Value::String(format!("\\x{}", hex(&b))),
    }
}

/// Map a JS param value (JSON) into a driver [`CellValue`] for binding.
/// Inverse of [`cell_to_json`] for the shapes a script can pass. Numbers
/// split int/float; objects/arrays become `Document` (bound as JSONB);
/// strings stay `Text`. This is what makes `db.query(sql, params)` a real
/// parameterized query.
fn json_to_cell(v: serde_json::Value) -> CellValue {
    use serde_json::Value;
    match v {
        Value::Null => CellValue::Null,
        Value::Bool(b) => CellValue::Bool(b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                CellValue::Int(i)
            } else {
                CellValue::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => CellValue::Text(s),
        other @ (Value::Array(_) | Value::Object(_)) => CellValue::Document(other),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Run a JavaScript scripting-mode tab against the connection. Only offered for
/// SQL/RDBMS drivers (the frontend hides the toggle otherwise, and we re-check
/// here). Returns the grid data + captured console output.
#[tauri::command]
#[specta::specta]
pub async fn run_script(
    state: State<'_, AppState>,
    conn_id: Uuid,
    source: String,
) -> Result<ScriptOutcome, String> {
    let runner: Arc<dyn QueryRunner> = {
        let g = state.conns.read().await;
        let live = g.get(&conn_id).ok_or("not connected")?;
        // Scripting works for SQL and Mongo. In both, `db.query(...)` takes the
        // engine's own query text — SQL for RDBMS, a mongo-shell command
        // (`db.coll.find({...})`) for Mongo — and streams it through the same
        // driver seam. Other engines have no such facade.
        match live.db.lang() {
            db_core::QueryLang::Sql | db_core::QueryLang::MongoShell => {}
            _ => {
                return Err(
                    "scripting mode is only available for SQL and MongoDB connections".into(),
                )
            }
        }
        Arc::new(ScriptRunner {
            db: live.db.clone(),
        })
    };

    // Register a fresh cancel flag for this connection so `cancel_script`
    // can reach the running engine. Replaces any stale flag (one script per
    // connection). Removed in the guard below on every exit path.
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .script_cancels
        .write()
        .await
        .insert(conn_id, cancel.clone());
    // Ensure the flag is cleaned up even if the run errors/panics-unwinds.
    struct CancelGuard {
        cancels: Arc<
            tokio::sync::RwLock<
                std::collections::HashMap<Uuid, Arc<std::sync::atomic::AtomicBool>>,
            >,
        >,
        id: Uuid,
    }
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            let cancels = self.cancels.clone();
            let id = self.id;
            tokio::spawn(async move {
                cancels.write().await.remove(&id);
            });
        }
    }
    let _guard = CancelGuard {
        cancels: state.script_cancels.clone(),
        id: conn_id,
    };

    let limits = db_script::Limits {
        cancel,
        ..Default::default()
    };

    let started = std::time::Instant::now();
    let outcome = db_script::run(&source, runner, limits)
        .await
        .map_err(|e| e.to_string())?;
    let _ = state
        .store
        .record_query(conn_id, &source, started.elapsed().as_millis() as u64);
    Ok(outcome)
}

/// Cancel a running script on `conn_id` by flipping its cancel flag — the
/// script engine's interrupt handler tears the script down at the next check.
/// No-op if no script is running on that connection.
#[tauri::command]
#[specta::specta]
pub async fn cancel_script(state: State<'_, AppState>, conn_id: Uuid) -> Result<(), String> {
    if let Some(flag) = state.script_cancels.read().await.get(&conn_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}
