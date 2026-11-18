//! SQL Server driver — `DbConnection` impl on top of `tiberius` (TDS).
//!
//! Streamed queries without parameters run as a plain SQL batch, exactly as
//! typed (`GO` is a client-side separator, not T-SQL, and isn't understood).
//! Parameterised queries (`db.query("… WHERE id = @P1", [id])` from scripts)
//! go through `sp_executesql` with the values bound, never interpolated.
//!
//! Streaming mirrors the other SQL drivers: rows of every result set flow
//! under the first set's columns, a DML-only run ends with no columns, and an
//! error arrives in-band as a final single-cell row.
//!
//! ## Connections
//!
//! A small pool of TDS connections. A connection that ends a query inside an
//! open transaction (`BEGIN TRAN` typed in the editor) is kept and handed to
//! the next query first, so the user's `COMMIT` lands on it; internal work
//! (introspection, batches) never borrows it.
//!
//! ## Cancellation
//!
//! [`cancel`](DbConnection::cancel) sends a TDS attention to the running
//! request — no `KILL`, so it needs no server permission, and the connection
//! stays usable.
//!
//! ## TLS
//!
//! The SSL modes follow libpq like the other drivers: `disable`; `prefer`
//! (TLS when the server offers it, plaintext otherwise); `require`
//! (encrypted, server not authenticated); `verify-full` (certificate chain and
//! host name checked against the OS trust store). SQL Server ships with a
//! self-signed certificate, so `prefer`/`require` are what work out of the box.

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    error_chain, CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params,
    QueryHandle, QueryLang, RowBatch, RowSink, SchemaTree,
};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tiberius::{AuthMethod, Config, EncryptionLevel, Query, QueryItem, QueryStream};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

pub mod introspect;
pub mod value;

pub type Client = tiberius::Client<Compat<TcpStream>>;

const STREAM_BATCH: usize = 200;
const POOL_SIZE: usize = 8;
/// Used when the config sets no connect timeout. Matches the other drivers.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MssqlSsl {
    Disable,
    Prefer,
    Require,
    VerifyFull,
}

impl MssqlSsl {
    /// Parse the persisted `ssl_mode` string; unknown values mean `Prefer`.
    pub fn from_mode_str(s: &str) -> Self {
        match s {
            "disable" => MssqlSsl::Disable,
            "require" => MssqlSsl::Require,
            "verify-full" | "verify_full" => MssqlSsl::VerifyFull,
            _ => MssqlSsl::Prefer,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct MssqlConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    /// Initial database. Optional: blank means the login's default database.
    pub database: Option<String>,
    pub ssl_mode: MssqlSsl,
    pub connect_timeout_ms: Option<u64>,
}

/// Hand-written so a `{:?}` never prints the password.
impl std::fmt::Debug for MssqlConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MssqlConfig")
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

impl MssqlConfig {
    fn tiberius(&self, encryption: EncryptionLevel) -> Config {
        let mut c = Config::new();
        c.host(&self.host);
        c.port(self.port);
        if let Some(db) = self.database.as_deref().filter(|d| !d.is_empty()) {
            c.database(db);
        }
        c.authentication(AuthMethod::sql_server(
            &self.user,
            self.password.as_deref().unwrap_or(""),
        ));
        c.application_name("nembrix");
        c.encryption(encryption);
        // Encrypt without authenticating the server — libpq `require`.
        if matches!(self.ssl_mode, MssqlSsl::Prefer | MssqlSsl::Require) {
            c.trust_cert();
        }
        c
    }

    fn connect_timeout(&self) -> Duration {
        self.connect_timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT)
    }
}

/// A SQL Server error as one readable line. Server errors carry their own
/// message (`Invalid object name 'nope'.`) and number; everything else (I/O,
/// TLS, …) keeps the full chain.
pub fn mssql_err(e: &tiberius::error::Error) -> String {
    match e {
        tiberius::error::Error::Server(t) => format!("{} (error {})", t.message(), t.code()),
        other => error_chain(other),
    }
}

/// A server-reported error leaves the connection usable; anything else
/// (I/O, protocol, TLS) means it can't be trusted for the next query.
fn leaves_conn_usable(e: &tiberius::error::Error) -> bool {
    matches!(e, tiberius::error::Error::Server(_))
}

/// The server has no TLS at all, so a TLS-wanting client gave up.
fn is_no_tls(e: &tiberius::error::Error) -> bool {
    matches!(e, tiberius::error::Error::Protocol(m) if m.contains("does not allow the requested encryption"))
}

/// Open one authenticated connection, following one Azure gateway redirect.
async fn open(cfg: &MssqlConfig) -> tiberius::Result<Client> {
    let timeout = cfg.connect_timeout();
    let first = match cfg.ssl_mode {
        MssqlSsl::Disable => EncryptionLevel::NotSupported,
        MssqlSsl::Prefer => EncryptionLevel::On,
        MssqlSsl::Require | MssqlSsl::VerifyFull => EncryptionLevel::Required,
    };
    match open_at(cfg.tiberius(first), timeout).await {
        // `prefer`: fall back to plaintext only when the server has no TLS
        // at all — any other failure must not trigger a downgrade.
        Err(e) if cfg.ssl_mode == MssqlSsl::Prefer && is_no_tls(&e) => {
            open_at(cfg.tiberius(EncryptionLevel::NotSupported), timeout).await
        }
        other => other,
    }
}

async fn open_at(mut config: Config, timeout: Duration) -> tiberius::Result<Client> {
    for _ in 0..2 {
        let connect = async {
            let tcp = TcpStream::connect(config.get_addr()).await?;
            tcp.set_nodelay(true)?;
            tiberius::Client::connect(config.clone(), tcp.compat_write()).await
        };
        match tokio::time::timeout(timeout, connect).await {
            Err(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "connection timed out",
                )
                .into())
            }
            // Azure SQL's gateway hands the client a node to talk to instead.
            Ok(Err(tiberius::error::Error::Routing { host, port })) => {
                config.host(host);
                config.port(port);
            }
            Ok(other) => return other,
        }
    }
    Err(tiberius::error::Error::Protocol(
        "the server redirected the connection more than once".into(),
    ))
}

/// One pooled connection and whether it's inside an open transaction.
struct Pooled {
    client: Client,
    in_txn: bool,
}

#[derive(Clone, Copy)]
enum Want {
    /// User queries: continue an open transaction if there is one.
    Any,
    /// Internal work that must not run inside the user's transaction.
    Autocommit,
}

struct Pool {
    cfg: MssqlConfig,
    idle: Mutex<Vec<Pooled>>,
}

impl Pool {
    async fn checkout(&self, want: Want) -> DbResult<Pooled> {
        {
            let mut idle = self.idle.lock().expect("pool lock");
            let pick = match want {
                Want::Any => idle
                    .iter()
                    .position(|c| c.in_txn)
                    .or(idle.len().checked_sub(1)),
                Want::Autocommit => idle.iter().rposition(|c| !c.in_txn),
            };
            if let Some(i) = pick {
                return Ok(idle.swap_remove(i));
            }
        }
        let client = open(&self.cfg)
            .await
            .map_err(|e| DbError::Driver(mssql_err(&e)))?;
        Ok(Pooled {
            client,
            in_txn: false,
        })
    }

    /// Return a connection after a user query: ask the server whether it left
    /// a transaction open, so the next query can continue it.
    async fn checkin_after_user(&self, mut conn: Pooled) {
        conn.in_txn = match trancount(&mut conn.client).await {
            Ok(n) => n > 0,
            Err(_) => return, // unusable: drop it
        };
        self.checkin(conn);
    }

    fn checkin(&self, conn: Pooled) {
        let mut idle = self.idle.lock().expect("pool lock");
        // Never drop a connection mid-transaction: closing it would roll the
        // user's open transaction back.
        if idle.len() < POOL_SIZE || conn.in_txn {
            idle.push(conn);
        }
    }
}

async fn trancount(client: &mut Client) -> tiberius::Result<i32> {
    let row = client
        .simple_query("SELECT @@TRANCOUNT")
        .await?
        .into_row()
        .await?;
    Ok(row.and_then(|r| r.get::<i32, _>(0)).unwrap_or(0))
}

pub struct MssqlConn {
    pool: Arc<Pool>,
    running: Arc<DashMap<QueryHandle, CancellationToken>>,
}

impl MssqlConn {
    pub async fn connect(cfg: MssqlConfig) -> DbResult<Arc<Self>> {
        // rustls needs a process-wide crypto provider. Ignore the error if
        // another driver (or the app) already installed one.
        let _ = rustls::crypto::ring::default_provider().install_default();

        // Prove the settings with one real connection, so connect fails fast
        // with the real reason (bad password, unreachable host, TLS, …).
        let client = open(&cfg)
            .await
            .map_err(|e| DbError::Connect(mssql_err(&e)))?;
        let pool = Arc::new(Pool {
            cfg,
            idle: Mutex::new(Vec::new()),
        });
        pool.checkin(Pooled {
            client,
            in_txn: false,
        });
        Ok(Arc::new(Self {
            pool,
            running: Arc::new(DashMap::new()),
        }))
    }
}

/// Bind grid params, in order, as `@P1`, `@P2`, ….
fn bind_all<'a>(query: &'a str, params: Params) -> Query<'a> {
    let mut q = Query::new(query);
    for p in params {
        match p {
            CellValue::Null => q.bind(Option::<Cow<str>>::None),
            CellValue::Bool(b) => q.bind(b),
            CellValue::Int(i) => q.bind(i),
            CellValue::Float(f) => q.bind(f),
            CellValue::Text(s) | CellValue::Raw(s) => q.bind(Cow::<str>::Owned(s)),
            CellValue::Document(d) => q.bind(Cow::<str>::Owned(d.to_string())),
            CellValue::Bytes(b) => q.bind(Cow::<[u8]>::Owned(b)),
        }
    }
    q
}

#[async_trait]
impl DbConnection for MssqlConn {
    fn lang(&self) -> QueryLang {
        QueryLang::Sql
    }

    async fn ping(&self) -> DbResult<()> {
        let mut conn = self.pool.checkout(Want::Autocommit).await?;
        match run(&mut conn.client, "SELECT 1").await {
            Ok(()) => {
                self.pool.checkin(conn);
                Ok(())
            }
            Err(e) => Err(DbError::Driver(mssql_err(&e))),
        }
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        let mut conn = self.pool.checkout(Want::Autocommit).await?;
        let tree = introspect::introspect(&mut conn.client).await;
        // A failed catalog query is a server error; the connection is fine.
        self.pool.checkin(conn);
        tree
    }

    async fn execute(&self, query: &str, params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let mut conn = self.pool.checkout(Want::Any).await?;
        let res = if params.is_empty() {
            exec_plain(&mut conn.client, query).await
        } else {
            bind_all(query, params)
                .execute(&mut conn.client)
                .await
                .map(|r| r.total())
        };
        match res {
            Ok(rows_affected) => {
                self.pool.checkin_after_user(conn).await;
                Ok(ExecSummary {
                    rows_affected,
                    last_insert_id: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                })
            }
            Err(e) => {
                if leaves_conn_usable(&e) {
                    self.pool.checkin_after_user(conn).await;
                }
                Err(DbError::Driver(mssql_err(&e)))
            }
        }
    }

    /// One connection, one transaction. Unlike MySQL, SQL Server DDL is
    /// transactional, so a failed batch leaves nothing behind.
    async fn execute_batch(&self, statements: &[String]) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let mut conn = self.pool.checkout(Want::Autocommit).await?;
        run(&mut conn.client, "BEGIN TRANSACTION")
            .await
            .map_err(|e| DbError::Driver(mssql_err(&e)))?;
        let mut rows_affected = 0u64;
        for (i, stmt) in statements.iter().enumerate() {
            match exec_plain(&mut conn.client, stmt).await {
                Ok(n) => rows_affected += n,
                Err(e) => {
                    let err = DbError::Driver(format!(
                        "statement {} of {} failed, nothing was applied: {}",
                        i + 1,
                        statements.len(),
                        mssql_err(&e)
                    ));
                    // Some errors already ended the transaction server-side.
                    if run(&mut conn.client, "IF @@TRANCOUNT > 0 ROLLBACK")
                        .await
                        .is_ok()
                    {
                        self.pool.checkin(conn);
                    } // else: can't prove the session is clean — drop it
                    return Err(err);
                }
            }
        }
        if let Err(e) = run(&mut conn.client, "COMMIT").await {
            return Err(DbError::Driver(mssql_err(&e)));
        }
        self.pool.checkin(conn);
        Ok(ExecSummary {
            rows_affected,
            last_insert_id: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn stream(&self, query: &str, params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let conn = self.pool.checkout(Want::Any).await?;
        let handle = QueryHandle::new();
        let token = CancellationToken::new();
        self.running.insert(handle, token.clone());
        let running = self.running.clone();
        let pool = self.pool.clone();
        let query = query.to_string();

        tokio::spawn(async move {
            let mut conn = conn;
            let outcome = run_stream(&mut conn.client, &query, params, &sink, &token).await;
            running.remove(&handle);
            let error = |message: String| RowBatch {
                columns: None,
                rows: vec![vec![CellValue::Text(message)]],
                done: true,
            };
            let (last, reusable) = match outcome {
                Ok(last) => (last, true),
                Err(Stop::Cancelled { acknowledged }) => {
                    (error("query cancelled".into()), acknowledged)
                }
                Err(Stop::Failed(e)) => (error(mssql_err(&e)), leaves_conn_usable(&e)),
            };
            // Back in the pool before the caller hears "done", so a follow-up
            // query (the user's COMMIT) finds this connection's transaction.
            if reusable {
                pool.checkin_after_user(conn).await;
            }
            let _ = sink.send(last).await;
        });

        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let token = self
            .running
            .get(&handle)
            .map(|t| t.clone())
            .ok_or(DbError::UnknownHandle)?;
        token.cancel();
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Run one statement in a scope of its own and return how many rows its last
/// statement touched.
///
/// Not `Client::execute`: that always declares a parameter list for
/// `sp_executesql` — even an empty one — and SQL Server then rejects
/// `CREATE VIEW` / `FUNCTION` / `PROCEDURE` / `TRIGGER`, which must start a
/// batch. Without the list, `sp_executesql` runs the text as its own batch.
async fn exec_plain(client: &mut Client, sql: &str) -> tiberius::Result<u64> {
    let batch = format!(
        "EXEC sp_executesql N'{}'; SELECT CAST(@@ROWCOUNT AS BIGINT)",
        sql.replace('\'', "''")
    );
    let sets = client.simple_query(batch).await?.into_results().await?;
    let count = sets
        .last()
        .and_then(|set| set.first())
        .and_then(|row| row.get::<i64, _>(0))
        .unwrap_or(0);
    Ok(count.max(0) as u64)
}

/// Run a statement and discard whatever it returns.
async fn run(client: &mut Client, sql: &str) -> tiberius::Result<()> {
    client.simple_query(sql).await?.into_results().await?;
    Ok(())
}

enum Stop {
    /// Stopped by [`DbConnection::cancel`]; `acknowledged` when the server
    /// confirmed the attention, i.e. the connection is clean again.
    Cancelled {
        acknowledged: bool,
    },
    Failed(tiberius::error::Error),
}

async fn open_stream<'a>(
    client: &'a mut Client,
    query: &'a str,
    params: Params,
) -> tiberius::Result<QueryStream<'a>> {
    if params.is_empty() {
        client.simple_query(query).await
    } else {
        bind_all(query, params).query(client).await
    }
}

/// Stream every result set's rows into `sink`, under the first set's
/// columns, until done or cancelled. Returns the final batch unsent.
async fn run_stream(
    client: &mut Client,
    query: &str,
    params: Params,
    sink: &RowSink,
    cancel: &CancellationToken,
) -> Result<RowBatch, Stop> {
    let finished = {
        let opened = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            r = open_stream(client, query, params) => Some(r),
        };
        match opened {
            None => None,
            Some(Err(e)) => return Err(Stop::Failed(e)),
            Some(Ok(mut stream)) => drain(&mut stream, sink, cancel)
                .await
                .map_err(Stop::Failed)?,
        }
    };
    if let Some(last) = finished {
        return Ok(last);
    }
    let acknowledged = client.cancel_query().await.is_ok();
    Err(Stop::Cancelled { acknowledged })
}

/// The final (unsent) batch when the stream ran to the end, `None` when
/// cancelled.
async fn drain(
    stream: &mut QueryStream<'_>,
    sink: &RowSink,
    cancel: &CancellationToken,
) -> tiberius::Result<Option<RowBatch>> {
    let mut columns: Option<Vec<ColMeta>> = None;
    let mut sent_columns = false;
    let mut buf: Vec<Vec<CellValue>> = Vec::with_capacity(STREAM_BATCH);

    loop {
        let item = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(None),
            item = stream.try_next() => item?,
        };
        match item {
            None => break,
            Some(QueryItem::Metadata(meta)) => {
                if !sent_columns && columns.is_none() {
                    columns = Some(meta.columns().iter().map(value::col_meta).collect());
                }
            }
            Some(QueryItem::Row(row)) => {
                buf.push(row.into_iter().map(value::to_cell).collect());
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
                        // Receiver gone: stop the server from producing more.
                        return Ok(None);
                    }
                }
            }
        }
    }
    Ok(Some(RowBatch {
        columns: columns.take(),
        rows: buf,
        done: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssl_modes_parse_like_postgres() {
        assert_eq!(MssqlSsl::from_mode_str("disable"), MssqlSsl::Disable);
        assert_eq!(MssqlSsl::from_mode_str("require"), MssqlSsl::Require);
        assert_eq!(MssqlSsl::from_mode_str("verify-full"), MssqlSsl::VerifyFull);
        assert_eq!(MssqlSsl::from_mode_str("prefer"), MssqlSsl::Prefer);
        assert_eq!(MssqlSsl::from_mode_str("bogus"), MssqlSsl::Prefer);
    }

    #[test]
    fn debug_redacts_password() {
        let c = MssqlConfig {
            host: "h".into(),
            port: 1433,
            user: "sa".into(),
            password: Some("hunter2".into()),
            database: None,
            ssl_mode: MssqlSsl::Disable,
            connect_timeout_ms: None,
        };
        assert!(!format!("{c:?}").contains("hunter2"));
    }
}
