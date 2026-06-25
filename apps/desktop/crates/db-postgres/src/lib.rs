//! Postgres driver — `DbConnection` impl on top of `sqlx`.

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params, QueryHandle,
    QueryLang, RowBatch, RowSink, SchemaTree,
};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, Pool, Postgres, Row, TypeInfo, ValueRef};
use std::any::Any;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use uuid::Uuid;

pub mod introspect;
pub mod object_ops;

const STREAM_BATCH: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PgConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: PgSsl,
    pub application_name: Option<String>,
    pub statement_timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PgSsl {
    Disable,
    Prefer,
    Require,
}

impl PgSsl {
    fn to_sqlx(self) -> PgSslMode {
        match self {
            PgSsl::Disable => PgSslMode::Disable,
            PgSsl::Prefer => PgSslMode::Prefer,
            PgSsl::Require => PgSslMode::Require,
        }
    }
}

pub struct PgConn {
    pool: Pool<Postgres>,
    /// Sidechannel pool of size 1, used only for `pg_cancel_backend`. Keeps
    /// cancel signals from contending with the main pool for slots.
    cancel_pool: Pool<Postgres>,
    running: Arc<DashMap<QueryHandle, i32>>, // handle -> backend PID
}

impl PgConn {
    pub async fn connect(cfg: PgConfig) -> DbResult<Arc<Self>> {
        let opts = PgConnectOptions::new()
            .host(&cfg.host)
            .port(cfg.port)
            .username(&cfg.user)
            .ssl_mode(cfg.ssl_mode.to_sqlx())
            .application_name(cfg.application_name.as_deref().unwrap_or("nembrix"));
        let opts = if let Some(db) = &cfg.database {
            opts.database(db)
        } else {
            opts
        };
        let opts = if let Some(pw) = &cfg.password {
            opts.password(pw)
        } else {
            opts
        };

        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect_with(opts.clone())
            .await
            .map_err(|e| DbError::Connect(e.to_string()))?;

        let cancel_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .map_err(|e| DbError::Connect(e.to_string()))?;

        if let Some(ms) = cfg.statement_timeout_ms {
            let _ = sqlx::query(&format!("SET statement_timeout = {ms}"))
                .execute(&pool)
                .await;
        }

        Ok(Arc::new(Self {
            pool,
            cancel_pool,
            running: Arc::new(DashMap::new()),
        }))
    }

    pub fn pool(&self) -> &Pool<Postgres> {
        &self.pool
    }
}

#[async_trait]
impl DbConnection for PgConn {
    fn lang(&self) -> QueryLang {
        QueryLang::Sql
    }

    async fn ping(&self) -> DbResult<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|e| DbError::Driver(e.to_string()))?;
        Ok(())
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        introspect::introspect(&self.pool).await
    }

    async fn execute(&self, query: &str, _params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let res = sqlx::query(query)
            .execute(&self.pool)
            .await
            .map_err(|e| DbError::Driver(e.to_string()))?;
        Ok(ExecSummary {
            rows_affected: res.rows_affected(),
            last_insert_id: None, // Postgres returns via RETURNING; surface via stream() instead
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn stream(&self, query: &str, _params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let handle = QueryHandle::new();
        let pool = self.pool.clone();
        let query = query.to_string();
        let running = self.running.clone();
        let pid_holder = Arc::new(Mutex::new(None::<i32>));
        let pid_holder_c = pid_holder.clone();

        tokio::spawn(async move {
            let mut conn = match pool.acquire().await {
                Ok(c) => c,
                Err(e) => {
                    let _ = sink
                        .send(RowBatch {
                            columns: None,
                            rows: vec![vec![CellValue::Text(format!("acquire: {e}"))]],
                            done: true,
                        })
                        .await;
                    return;
                }
            };
            // Capture backend PID so we can cancel via pg_cancel_backend.
            if let Ok(row) = sqlx::query("SELECT pg_backend_pid()")
                .fetch_one(conn.as_mut())
                .await
            {
                if let Ok(pid) = row.try_get::<i32, _>(0) {
                    *pid_holder_c.lock().await = Some(pid);
                    running.insert(handle, pid);
                }
            }

            let mut stream = sqlx::query(&query).fetch(conn.as_mut());
            let mut buf: Vec<Vec<CellValue>> = Vec::with_capacity(STREAM_BATCH);
            let mut columns: Option<Vec<ColMeta>> = None;
            let mut emitted_first = false;

            loop {
                match stream.try_next().await {
                    Ok(Some(row)) => {
                        if !emitted_first {
                            columns = Some(extract_columns(&row));
                            emitted_first = true;
                        }
                        buf.push(extract_row(&row));
                        if buf.len() >= STREAM_BATCH {
                            let cols = columns.take();
                            let _ = sink
                                .send(RowBatch {
                                    columns: cols,
                                    rows: std::mem::take(&mut buf),
                                    done: false,
                                })
                                .await;
                        }
                    }
                    Ok(None) => {
                        let cols = columns.take();
                        let _ = sink
                            .send(RowBatch {
                                columns: cols,
                                rows: std::mem::take(&mut buf),
                                done: true,
                            })
                            .await;
                        break;
                    }
                    Err(e) => {
                        let _ = sink
                            .send(RowBatch {
                                columns: columns.take(),
                                rows: vec![vec![CellValue::Text(e.to_string())]],
                                done: true,
                            })
                            .await;
                        break;
                    }
                }
            }
            running.remove(&handle);
        });

        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let pid = self
            .running
            .get(&handle)
            .map(|e| *e.value())
            .ok_or(DbError::UnknownHandle)?;
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .execute(&self.cancel_pool)
            .await
            .map_err(|e| DbError::Driver(e.to_string()))?;
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

fn extract_columns(row: &PgRow) -> Vec<ColMeta> {
    row.columns()
        .iter()
        .map(|c| ColMeta {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
            nullable: true, // sqlx doesn't expose per-column nullability at row time
        })
        .collect()
}

fn extract_row(row: &PgRow) -> Vec<CellValue> {
    let n = row.columns().len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(cell_at(row, i));
    }
    out
}

/// Best-effort row→CellValue conversion. We try a small ladder of common
/// types; anything we don't recognise comes through as `Raw(Display)` or
/// `Bytes` so the grid always has *something* to render.
fn cell_at(row: &PgRow, idx: usize) -> CellValue {
    let raw = match row.try_get_raw(idx) {
        Ok(v) => v,
        Err(_) => return CellValue::Null,
    };
    if raw.is_null() {
        return CellValue::Null;
    }
    let ty = row.columns()[idx].type_info().name().to_string();

    macro_rules! try_typed {
        ($t:ty, $variant:expr) => {
            if let Ok(v) = row.try_get::<$t, _>(idx) {
                return $variant(v);
            }
        };
    }

    match ty.as_str() {
        "BOOL" => try_typed!(bool, CellValue::Bool),
        "INT2" | "INT4" | "INT8" => {
            if let Ok(v) = row.try_get::<i64, _>(idx) {
                return CellValue::Int(v);
            }
            if let Ok(v) = row.try_get::<i32, _>(idx) {
                return CellValue::Int(v as i64);
            }
            if let Ok(v) = row.try_get::<i16, _>(idx) {
                return CellValue::Int(v as i64);
            }
        }
        "FLOAT4" | "FLOAT8" => {
            if let Ok(v) = row.try_get::<f64, _>(idx) {
                return CellValue::Float(v);
            }
            if let Ok(v) = row.try_get::<f32, _>(idx) {
                return CellValue::Float(v as f64);
            }
        }
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CITEXT" => {
            try_typed!(String, CellValue::Text);
        }
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
                return CellValue::Document(v);
            }
        }
        "UUID" => {
            if let Ok(v) = row.try_get::<Uuid, _>(idx) {
                return CellValue::Text(v.to_string());
            }
        }
        "BYTEA" => {
            if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
                return CellValue::Bytes(v);
            }
        }
        _ => {}
    }

    // Catch-all: try string, then bytes.
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return CellValue::Raw(v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return CellValue::Bytes(v);
    }
    CellValue::Raw(format!("<{ty}>"))
}
