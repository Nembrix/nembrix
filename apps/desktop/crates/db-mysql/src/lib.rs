//! MySQL / MariaDB driver — `DbConnection` impl on top of `mysql_async`.
//!
//! Queries without parameters use the text protocol (`query_iter`), so they
//! run exactly as typed — multi-statement scripts included. Parameterised
//! queries (`db.query("… WHERE id = ?", [id])` from scripts) use prepared
//! statements, so values are bound, never interpolated. Placeholders are
//! MySQL's `?`, not Postgres' `$1`.
//!
//! Streaming mirrors the Postgres driver: rows of every result set flow under
//! the first set's columns, a DML-only run ends with no columns, and an error
//! arrives in-band as a final single-cell row.
//!
//! ## Cancellation
//!
//! [`cancel`](DbConnection::cancel) is server-side: `KILL QUERY <thread id>`
//! from a second pooled connection. Because pooled connections are reused, a
//! late KILL could hit someone else's query on the same thread; the running
//! task and `cancel` share a lock so the task can't release its connection
//! while a KILL is in flight, and after it has, the KILL is skipped.
//!
//! ## TLS
//!
//! The SSL modes follow libpq like the Postgres driver: `disable`; `prefer`
//! (TLS when the server offers it, plaintext otherwise); `require` (encrypted,
//! server not authenticated); `verify-full` (certificate chain and host name
//! checked against the OS trust store plus Mozilla's roots).

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    error_chain, CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params,
    QueryHandle, QueryLang, RowBatch, RowSink, SchemaTree,
};
use futures::StreamExt;
use mysql_async::prelude::*;
use mysql_async::{
    Conn, DriverError, OptsBuilder, Pool, PoolConstraints, PoolOpts, QueryResult, Row, SslOpts,
    Value,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub mod introspect;
pub mod value;

const STREAM_BATCH: usize = 200;
const POOL_SIZE: usize = 8;
/// Used when the config sets no connect timeout. Matches the Postgres driver.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MySqlSsl {
    Disable,
    Prefer,
    Require,
    VerifyFull,
}

impl MySqlSsl {
    /// Parse the persisted `ssl_mode` string; unknown values mean `Prefer`.
    pub fn from_mode_str(s: &str) -> Self {
        match s {
            "disable" => MySqlSsl::Disable,
            "require" => MySqlSsl::Require,
            "verify-full" | "verify_full" => MySqlSsl::VerifyFull,
            _ => MySqlSsl::Prefer,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct MySqlConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    /// Default database (`USE db`). Optional: MySQL connections aren't bound
    /// to one, and the tree lists every database the user can see.
    pub database: Option<String>,
    pub ssl_mode: MySqlSsl,
    pub connect_timeout_ms: Option<u64>,
}

/// Hand-written so a `{:?}` never prints the password.
impl std::fmt::Debug for MySqlConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MySqlConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("database", &self.database)
            .field("ssl_mode", &self.ssl_mode)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

impl MySqlConfig {
    fn opts(&self, tls: Option<SslOpts>) -> OptsBuilder {
        let pool = PoolOpts::default()
            .with_constraints(PoolConstraints::new(0, POOL_SIZE).expect("0 <= POOL_SIZE"));
        OptsBuilder::default()
            .ip_or_hostname(self.host.clone())
            .tcp_port(self.port)
            .user(Some(self.user.clone()))
            .pass(self.password.clone().filter(|p| !p.is_empty()))
            .db_name(self.database.clone().filter(|d| !d.is_empty()))
            // Over SSH the host is 127.0.0.1 and the Unix socket would be the
            // *local* server's — never swap the TCP target for a socket.
            .prefer_socket(false)
            .pool_opts(pool)
            .ssl_opts(tls)
    }

    fn connect_timeout(&self) -> Duration {
        self.connect_timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT)
    }
}

fn tls_opts(mode: MySqlSsl) -> Option<SslOpts> {
    match mode {
        MySqlSsl::Disable => None,
        // Encrypt without authenticating the server — libpq `require`.
        MySqlSsl::Prefer | MySqlSsl::Require => Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true),
        ),
        MySqlSsl::VerifyFull => Some(
            SslOpts::default()
                .with_root_certs(native_roots_pem().into_iter().map(Into::into).collect()),
        ),
    }
}

/// The OS trust store as PEM buffers (mysql_async reads roots as PEM), added
/// to its built-in Mozilla roots so a locally installed CA is honoured.
fn native_roots_pem() -> Vec<Vec<u8>> {
    use base64::Engine;
    let found = rustls_native_certs::load_native_certs();
    for e in &found.errors {
        tracing::warn!("loading OS root certificate: {e}");
    }
    found
        .certs
        .into_iter()
        .map(|der| {
            let b64 = base64::engine::general_purpose::STANDARD.encode(der.as_ref());
            let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
            for line in b64.as_bytes().chunks(64) {
                pem.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
                pem.push('\n');
            }
            pem.push_str("-----END CERTIFICATE-----\n");
            pem.into_bytes()
        })
        .collect()
}

/// A MySQL error as one readable line. Server errors are already complete
/// (`ERROR 1146 (42S02): Table 'test.nope' doesn't exist`); the driver's
/// wrapper repeats that text in its own Display, which `error_chain` would
/// then print twice. Everything else (I/O, TLS, …) keeps the full chain.
pub fn mysql_err(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(se) => se.to_string(),
        other => error_chain(other),
    }
}

/// The server has TLS switched off, so a TLS-wanting client gave up.
fn is_no_tls(e: &mysql_async::Error) -> bool {
    matches!(
        e,
        mysql_async::Error::Driver(DriverError::NoClientSslFlagFromServer)
    )
}

/// Per-query cancel state. `active` is cleared — under the lock — before the
/// query's connection goes back to the pool.
struct Running {
    thread_id: u32,
    active: Arc<Mutex<bool>>,
}

pub struct MySqlConn {
    pool: Pool,
    default_db: Option<String>,
    running: Arc<DashMap<QueryHandle, Running>>,
}

impl MySqlConn {
    pub async fn connect(cfg: MySqlConfig) -> DbResult<Arc<Self>> {
        // rustls needs a process-wide crypto provider. Ignore the error if
        // another driver already installed one.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let timeout = cfg.connect_timeout();
        let pool = match open(&cfg, tls_opts(cfg.ssl_mode), timeout).await {
            Ok(pool) => pool,
            // `prefer`: fall back to plaintext only when the server has no TLS
            // at all — any other failure must not trigger a downgrade.
            Err(e) if cfg.ssl_mode == MySqlSsl::Prefer && is_no_tls(&e) => {
                open(&cfg, None, timeout)
                    .await
                    .map_err(|e| DbError::Connect(mysql_err(&e)))?
            }
            Err(e) => return Err(DbError::Connect(mysql_err(&e))),
        };
        Ok(Arc::new(Self {
            pool,
            default_db: cfg.database.filter(|d| !d.is_empty()),
            running: Arc::new(DashMap::new()),
        }))
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    async fn conn(&self) -> DbResult<Conn> {
        self.pool
            .get_conn()
            .await
            .map_err(|e| DbError::Driver(mysql_err(&e)))
    }
}

/// Build a pool and prove it with one real connection, so connect fails fast
/// with the real reason (bad password, unreachable host, TLS refused, …).
async fn open(
    cfg: &MySqlConfig,
    tls: Option<SslOpts>,
    timeout: Duration,
) -> mysql_async::Result<Pool> {
    let pool = Pool::new(cfg.opts(tls));
    let conn = tokio::time::timeout(timeout, pool.get_conn())
        .await
        .map_err(|_| {
            mysql_async::Error::Io(mysql_async::IoError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "connection timed out",
            )))
        })??;
    drop(conn);
    Ok(pool)
}

/// Grid params → MySQL values for a prepared statement.
fn to_mysql(p: CellValue) -> Value {
    match p {
        CellValue::Null => Value::NULL,
        CellValue::Bool(b) => Value::Int(b as i64),
        CellValue::Int(i) => Value::Int(i),
        CellValue::Float(f) => Value::Double(f),
        CellValue::Text(s) | CellValue::Raw(s) => Value::Bytes(s.into_bytes()),
        CellValue::Document(d) => Value::Bytes(d.to_string().into_bytes()),
        CellValue::Bytes(b) => Value::Bytes(b),
    }
}

#[async_trait]
impl DbConnection for MySqlConn {
    fn lang(&self) -> QueryLang {
        QueryLang::Sql
    }

    async fn ping(&self) -> DbResult<()> {
        self.conn()
            .await?
            .ping()
            .await
            .map_err(|e| DbError::Driver(mysql_err(&e)))
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        let mut conn = self.conn().await?;
        introspect::introspect(&mut conn, self.default_db.as_deref()).await
    }

    async fn execute(&self, query: &str, params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let mut conn = self.conn().await?;
        let res = if params.is_empty() {
            conn.query_drop(query).await
        } else {
            conn.exec_drop(query, params.into_iter().map(to_mysql).collect::<Vec<_>>())
                .await
        };
        res.map_err(|e| DbError::Driver(mysql_err(&e)))?;
        Ok(ExecSummary {
            rows_affected: conn.affected_rows(),
            last_insert_id: conn.last_insert_id().and_then(|id| i64::try_from(id).ok()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// One connection, one transaction. MySQL caveat: DDL (`CREATE`, `ALTER`,
    /// `DROP`, …) commits implicitly, so a batch mixing DDL can't be fully
    /// rolled back — the grid, Import and role edits only send DML.
    async fn execute_batch(&self, statements: &[String]) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let mut conn = self.conn().await?;
        conn.query_drop("START TRANSACTION")
            .await
            .map_err(|e| DbError::Driver(mysql_err(&e)))?;
        let mut rows_affected = 0u64;
        for (i, stmt) in statements.iter().enumerate() {
            if let Err(e) = conn.query_drop(stmt.as_str()).await {
                let err = DbError::Driver(format!(
                    "statement {} of {} failed, nothing was applied: {}",
                    i + 1,
                    statements.len(),
                    mysql_err(&e)
                ));
                if conn.query_drop("ROLLBACK").await.is_err() {
                    // Can't prove the session is clean: close it instead of
                    // returning it to the pool.
                    let _ = conn.disconnect().await;
                }
                return Err(err);
            }
            rows_affected += conn.affected_rows();
        }
        if let Err(e) = conn.query_drop("COMMIT").await {
            let _ = conn.disconnect().await;
            return Err(DbError::Driver(mysql_err(&e)));
        }
        Ok(ExecSummary {
            rows_affected,
            last_insert_id: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn stream(&self, query: &str, params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let conn = self.conn().await?;
        let handle = QueryHandle::new();
        let active = Arc::new(Mutex::new(true));
        self.running.insert(
            handle,
            Running {
                thread_id: conn.id(),
                active: active.clone(),
            },
        );
        let running = self.running.clone();
        let query = query.to_string();

        tokio::spawn(async move {
            let mut conn = conn;
            let outcome = if params.is_empty() {
                match conn.query_iter(query).await {
                    Ok(result) => drain(result, &sink).await,
                    Err(e) => Err(e),
                }
            } else {
                let values: Vec<Value> = params.into_iter().map(to_mysql).collect();
                match conn.exec_iter(query, values).await {
                    Ok(result) => drain(result, &sink).await,
                    Err(e) => Err(e),
                }
            };
            if let Err(e) = outcome {
                let _ = sink
                    .send(RowBatch {
                        columns: None,
                        rows: vec![vec![CellValue::Text(mysql_err(&e))]],
                        done: true,
                    })
                    .await;
            }
            // Retire the handle before the connection returns to the pool;
            // waits for any KILL in flight (see the module docs).
            *active.lock().await = false;
            running.remove(&handle);
            drop(conn);
        });

        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let (thread_id, active) = {
            let r = self.running.get(&handle).ok_or(DbError::UnknownHandle)?;
            (r.thread_id, r.active.clone())
        };
        let guard = active.lock().await;
        if !*guard {
            return Ok(()); // finished in the meantime
        }
        let mut killer = self.conn().await?;
        killer
            .query_drop(format!("KILL QUERY {thread_id}"))
            .await
            .map_err(|e| DbError::Driver(mysql_err(&e)))?;
        drop(guard);
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Push every result set's rows into `sink`, under the first set's columns.
async fn drain<P: Protocol + Unpin>(
    mut result: QueryResult<'_, 'static, P>,
    sink: &RowSink,
) -> mysql_async::Result<()> {
    let mut columns: Option<Vec<ColMeta>> = None;
    let mut sent_columns = false;
    let mut buf: Vec<Vec<CellValue>> = Vec::with_capacity(STREAM_BATCH);

    while let Some(mut set) = result.stream::<Row>().await? {
        let cols = set.columns();
        if cols.is_empty() {
            continue; // DML: no result set to show
        }
        if !sent_columns && columns.is_none() {
            columns = Some(cols.iter().map(value::col_meta).collect());
        }
        while let Some(row) = set.next().await {
            let row = row?;
            let cells = row
                .unwrap()
                .into_iter()
                .zip(cols.iter())
                .map(|(v, c)| value::to_cell(v, c))
                .collect();
            buf.push(cells);
            if buf.len() >= STREAM_BATCH {
                sent_columns = true;
                if sink
                    .send(RowBatch {
                        columns: columns.take(),
                        rows: std::mem::take(&mut buf),
                        done: false,
                    })
                    .await
                    .is_err()
                {
                    return Ok(()); // receiver gone
                }
            }
        }
    }
    let _ = sink
        .send(RowBatch {
            columns: columns.take(),
            rows: buf,
            done: true,
        })
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssl_modes_parse_like_postgres() {
        assert_eq!(MySqlSsl::from_mode_str("disable"), MySqlSsl::Disable);
        assert_eq!(MySqlSsl::from_mode_str("require"), MySqlSsl::Require);
        assert_eq!(MySqlSsl::from_mode_str("verify-full"), MySqlSsl::VerifyFull);
        assert_eq!(MySqlSsl::from_mode_str("prefer"), MySqlSsl::Prefer);
        assert_eq!(MySqlSsl::from_mode_str("bogus"), MySqlSsl::Prefer);
    }

    #[test]
    fn debug_redacts_password() {
        let c = MySqlConfig {
            host: "h".into(),
            port: 3306,
            user: "u".into(),
            password: Some("hunter2".into()),
            database: None,
            ssl_mode: MySqlSsl::Disable,
            connect_timeout_ms: None,
        };
        assert!(!format!("{c:?}").contains("hunter2"));
    }

    #[test]
    fn verify_full_loads_os_roots_as_pem() {
        for pem in native_roots_pem() {
            assert!(pem.starts_with(b"-----BEGIN CERTIFICATE-----\n"));
            assert!(pem.ends_with(b"-----END CERTIFICATE-----\n"));
        }
    }
}
