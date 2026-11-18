//! Redis driver — `DbConnection` impl on top of the `redis` crate.
//!
//! The query string is `redis-cli` text: one command per line (see
//! [`parse`]). Each reply is shaped into a grid table by the command that
//! produced it (see [`reply`]); running several commands at once yields one
//! row per command instead.
//!
//! ## Connections
//!
//! A long-lived multiplexed connection serves `ping` and `introspect`. Every
//! streamed query gets its **own** connection, opened for that query and
//! dropped when it finishes. Commands on one connection run in order, so on a
//! shared connection a blocking command (`BLPOP key 0`) would stall the tree
//! and every other tab; and dropping the dedicated connection is what makes
//! [`cancel`](DbConnection::cancel) real — the server sees the client go away
//! and abandons the blocked command. A per-query `SELECT` also stays local to
//! that query.
//!
//! The `redis` crate's default async timeouts (1 s connect, 500 ms response)
//! suit a cache client, not an interactive one: the connect timeout comes from
//! the config like the other drivers, and there is no response timeout — a
//! slow command runs until it finishes or the user cancels it.
//!
//! TLS (`rediss://`) verifies the server certificate against the OS trust
//! store.

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    error_chain, CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params,
    QueryHandle, QueryLang, RowBatch, RowSink, SchemaTree,
};
use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Client, Value};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

pub mod introspect;
pub mod parse;
pub mod reply;

use parse::Command;

const STREAM_BATCH: usize = 200;
/// Used when the config sets no connect timeout. Matches the Postgres driver.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Commands that put the connection into a mode a request/response grid can't
/// drive (pub/sub, replication, the `MONITOR` feed) or switch the protocol
/// under the client.
const REJECTED: &[&str] = &[
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "MONITOR",
    "SYNC",
    "PSYNC",
    "HELLO",
];

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct RedisConfig {
    pub host: String,
    pub port: u16,
    /// ACL user (Redis 6+). `None` authenticates as `default`.
    pub user: Option<String>,
    pub password: Option<String>,
    /// Logical database index (`SELECT n`).
    pub db: i64,
    pub tls: bool,
    pub connect_timeout_ms: Option<u64>,
}

/// Hand-written so a `{:?}` never prints the password.
impl std::fmt::Debug for RedisConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("db", &self.db)
            .field("tls", &self.tls)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

impl RedisConfig {
    /// `redis[s]://[user][:password@]host:port/db`, credentials URL-encoded.
    fn connection_url(&self) -> String {
        let mut url = String::from(if self.tls { "rediss://" } else { "redis://" });
        let user = self.user.as_deref().filter(|u| !u.is_empty());
        let password = self.password.as_deref().filter(|p| !p.is_empty());
        if user.is_some() || password.is_some() {
            if let Some(u) = user {
                url.push_str(&urlencode(u));
            }
            if let Some(p) = password {
                url.push(':');
                url.push_str(&urlencode(p));
            }
            url.push('@');
        }
        if self.host.contains(':') && !self.host.starts_with('[') {
            url.push_str(&format!("[{}]", self.host)); // bare IPv6 literal
        } else {
            url.push_str(&self.host);
        }
        url.push_str(&format!(":{}/{}", self.port, self.db));
        url
    }

    fn async_config(&self) -> AsyncConnectionConfig {
        let connect = self
            .connect_timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT);
        AsyncConnectionConfig::new()
            .set_connection_timeout(Some(connect))
            .set_response_timeout(None)
    }
}

/// Percent-encode the userinfo part of the URL — everything outside the
/// unreserved set, so `:`, `@`, `/`, `%`, … in a password can't break parsing.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub struct RedisConn {
    client: Client,
    config: AsyncConnectionConfig,
    /// Shared connection for `ping` / `introspect`. Cheap to clone; clones
    /// share one socket.
    shared: MultiplexedConnection,
    db: i64,
    /// handle -> the query's task; aborting it drops its dedicated connection.
    running: Arc<DashMap<QueryHandle, JoinHandle<()>>>,
}

impl RedisConn {
    pub async fn connect(cfg: RedisConfig) -> DbResult<Arc<Self>> {
        // rustls needs a process-wide crypto provider for `rediss://`. Ignore
        // the error if another driver already installed one.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client =
            Client::open(cfg.connection_url()).map_err(|e| DbError::Connect(error_chain(&e)))?;
        let config = cfg.async_config();
        let mut shared = client
            .get_multiplexed_async_connection_with_config(&config)
            .await
            .map_err(|e| DbError::Connect(error_chain(&e)))?;
        // Opening the connection already authenticated and SELECTed; a PING
        // proves the server answers commands (and not, say, a TLS terminator
        // with nothing behind it).
        redis::cmd("PING")
            .query_async::<()>(&mut shared)
            .await
            .map_err(|e| DbError::Connect(error_chain(&e)))?;
        Ok(Arc::new(Self {
            client,
            config,
            shared,
            db: cfg.db,
            running: Arc::new(DashMap::new()),
        }))
    }

    async fn dedicated(
        client: &Client,
        config: &AsyncConnectionConfig,
    ) -> DbResult<MultiplexedConnection> {
        client
            .get_multiplexed_async_connection_with_config(config)
            .await
            .map_err(|e| DbError::Driver(error_chain(&e)))
    }
}

/// Parse and refuse commands the grid can't drive.
fn parse_checked(query: &str) -> DbResult<Vec<Command>> {
    let cmds = parse::parse_script(query).map_err(DbError::Driver)?;
    for c in &cmds {
        let name = c.name();
        if REJECTED.contains(&name.as_str()) {
            return Err(DbError::Driver(format!(
                "{name} isn't supported in the query editor — it switches the \
                 connection into a mode that doesn't return a result set"
            )));
        }
    }
    Ok(cmds)
}

async fn run_one(conn: &mut MultiplexedConnection, cmd: &Command) -> Result<Value, String> {
    let mut c = redis::Cmd::new();
    for a in &cmd.args {
        c.arg(a.as_slice());
    }
    c.query_async::<Value>(conn)
        .await
        .map_err(|e| error_chain(&e))
}

#[async_trait]
impl DbConnection for RedisConn {
    fn lang(&self) -> QueryLang {
        QueryLang::RedisCmd
    }

    async fn ping(&self) -> DbResult<()> {
        redis::cmd("PING")
            .query_async::<()>(&mut self.shared.clone())
            .await
            .map_err(|e| DbError::Driver(error_chain(&e)))
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        introspect::introspect(&mut self.shared.clone(), self.db).await
    }

    /// Run every command; `rows_affected` is a lone command's integer reply
    /// (`DEL` → keys removed) or else the number of commands run.
    async fn execute(&self, query: &str, _params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let cmds = parse_checked(query)?;
        let mut conn = Self::dedicated(&self.client, &self.config).await?;
        let mut last = Value::Nil;
        for cmd in &cmds {
            last = run_one(&mut conn, cmd).await.map_err(DbError::Driver)?;
        }
        let rows_affected = match (cmds.len(), last) {
            (1, Value::Int(n)) if n >= 0 => n as u64,
            (n, _) => n as u64,
        };
        Ok(ExecSummary {
            rows_affected,
            last_insert_id: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn stream(&self, query: &str, _params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let cmds = parse_checked(query)?;
        let handle = QueryHandle::new();
        let client = self.client.clone();
        let config = self.config.clone();
        let running = self.running.clone();

        let task = tokio::spawn(async move {
            let result = match Self::dedicated(&client, &config).await {
                Ok(mut conn) => run_stream(&mut conn, &cmds, &sink).await,
                Err(e) => Err(e.to_string()),
            };
            // Same in-band error shape as the other drivers: a final batch with
            // no columns and the message in a single cell.
            if let Err(msg) = result {
                let _ = sink
                    .send(RowBatch {
                        columns: None,
                        rows: vec![vec![CellValue::Text(msg)]],
                        done: true,
                    })
                    .await;
            }
            running.remove(&handle);
        });

        self.running.insert(handle, task);
        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let (_, task) = self.running.remove(&handle).ok_or(DbError::UnknownHandle)?;
        // Dropping the task drops its dedicated connection; the server
        // abandons whatever that client was running or blocked on.
        task.abort();
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// One command: its reply as a shaped table. Several: one row per command
/// (`#`, `command`, `result`), continuing past errors like `redis-cli` does.
async fn run_stream(
    conn: &mut MultiplexedConnection,
    cmds: &[Command],
    sink: &RowSink,
) -> Result<(), String> {
    let table = if let [cmd] = cmds {
        let value = run_one(conn, cmd).await?;
        reply::shape(cmd, value)?
    } else {
        let mut rows = Vec::with_capacity(cmds.len());
        for (i, cmd) in cmds.iter().enumerate() {
            let result = match run_one(conn, cmd).await {
                Ok(v) => reply::cell(v),
                Err(e) => CellValue::Text(format!("(error) {e}")),
            };
            rows.push(vec![
                CellValue::from_i64(i as i64 + 1),
                CellValue::Text(cmd.display()),
                result,
            ]);
        }
        reply::Table {
            columns: ["#", "command", "result"]
                .iter()
                .map(|n| ColMeta {
                    name: n.to_string(),
                    type_name: String::new(),
                    nullable: true,
                })
                .collect(),
            rows,
        }
    };
    send_table(table, sink).await;
    Ok(())
}

async fn send_table(table: reply::Table, sink: &RowSink) {
    let mut columns = Some(table.columns);
    let mut rows = table.rows.into_iter().peekable();
    loop {
        let batch: Vec<_> = rows.by_ref().take(STREAM_BATCH).collect();
        let done = rows.peek().is_none();
        if sink
            .send(RowBatch {
                columns: columns.take(),
                rows: batch,
                done,
            })
            .await
            .is_err()
            || done
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RedisConfig {
        RedisConfig {
            host: "localhost".into(),
            port: 6379,
            user: None,
            password: None,
            db: 0,
            tls: false,
            connect_timeout_ms: None,
        }
    }

    #[test]
    fn url_without_credentials() {
        assert_eq!(cfg().connection_url(), "redis://localhost:6379/0");
    }

    #[test]
    fn url_encodes_credentials_and_uses_rediss_for_tls() {
        let c = RedisConfig {
            user: Some("app".into()),
            password: Some("p@ss:w/rd".into()),
            db: 3,
            tls: true,
            ..cfg()
        };
        assert_eq!(
            c.connection_url(),
            "rediss://app:p%40ss%3Aw%2Frd@localhost:6379/3"
        );
    }

    #[test]
    fn password_only_auth_and_ipv6_host() {
        let c = RedisConfig {
            host: "::1".into(),
            password: Some("secret".into()),
            ..cfg()
        };
        assert_eq!(c.connection_url(), "redis://:secret@[::1]:6379/0");
    }

    #[test]
    fn debug_redacts_password() {
        let c = RedisConfig {
            password: Some("hunter2".into()),
            ..cfg()
        };
        assert!(!format!("{c:?}").contains("hunter2"));
    }

    #[test]
    fn rejects_modal_commands() {
        let err = parse_checked("GET a\nsubscribe news")
            .unwrap_err()
            .to_string();
        assert!(err.contains("SUBSCRIBE"), "{err}");
        assert!(parse_checked("SELECT 2\nGET a").is_ok());
    }
}
