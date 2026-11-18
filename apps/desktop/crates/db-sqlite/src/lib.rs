//! SQLite driver — `DbConnection` impl on top of `rusqlite` (SQLite bundled,
//! so every platform runs the same version).
//!
//! A connection is a database *file*: the path travels in the connection's
//! Database field. The file must already exist — a typo in the path should
//! fail, not silently create an empty database somewhere.
//!
//! SQLite's API is synchronous, so every call runs on a blocking thread over
//! a small pool of connections to the same file. Queries without parameters
//! run as typed, multi-statement scripts included; parameterised ones bind
//! `?` / `?NNN` / `:name` values, never interpolate them. Streaming mirrors
//! the other SQL drivers: rows of every statement flow under the first
//! result's columns, and an error arrives in-band as a final single-cell row.
//!
//! ## Transactions typed in the editor
//!
//! A connection left inside a transaction (`BEGIN` run on its own) is handed
//! out again first, so a later `COMMIT` / `ROLLBACK` reaches the transaction
//! it was meant for instead of a different pooled connection.
//!
//! ## Cancellation
//!
//! [`cancel`](DbConnection::cancel) calls `sqlite3_interrupt` on the query's
//! connection. Like the MySQL driver, the running task and `cancel` share a
//! lock, so an interrupt can never land on the connection after it has gone
//! back to the pool and picked up someone else's query.
//!
//! ## Opening untrusted files
//!
//! Every connection sets `trusted_schema = OFF`, so a view or trigger stored
//! in a downloaded database can't call functions with side effects; extension
//! loading is not compiled in. `foreign_keys` is switched on, so edits made
//! from the grid honour the declared constraints and cascades.

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params, QueryHandle,
    QueryLang, RowBatch, RowSink, SchemaTree,
};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Batch, Connection, ErrorCode, InterruptHandle, OpenFlags, Statement};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub mod introspect;

const STREAM_BATCH: usize = 200;
/// Idle connections kept open; more are opened on demand.
const POOL_SIZE: usize = 4;
/// How long a write waits for another connection's lock before failing with
/// "database is locked".
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SqliteConfig {
    /// Path to the database file. A leading `~/` means the home directory.
    pub path: String,
}

/// A SQLite error as one readable line. `sqlite3_interrupt` reads as plain
/// "interrupted"; say what actually happened.
pub fn sqlite_err(e: &rusqlite::Error) -> String {
    match e.sqlite_error_code() {
        Some(ErrorCode::OperationInterrupted) => "query cancelled".into(),
        _ => e.to_string(),
    }
}

fn drv(e: rusqlite::Error) -> DbError {
    DbError::Driver(sqlite_err(&e))
}

/// `~/x` → `$HOME/x`; anything else as given.
fn expand_home(raw: &str) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (raw.strip_prefix("~/").or(raw.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(raw),
    }
}

fn open(path: &Path) -> rusqlite::Result<Connection> {
    // No SQLITE_OPEN_CREATE (see the module docs) and no URI filenames, so the
    // path is only ever a path. A write-protected file opens read-only.
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "trusted_schema", false)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(conn)
}

/// Grid params → SQLite values.
fn to_sqlite(p: CellValue) -> Value {
    match p {
        CellValue::Null => Value::Null,
        CellValue::Bool(b) => Value::Integer(b as i64),
        CellValue::Int(i) => Value::Integer(i),
        CellValue::Float(f) => Value::Real(f),
        CellValue::Text(s) | CellValue::Raw(s) => Value::Text(s),
        CellValue::Document(d) => Value::Text(d.to_string()),
        CellValue::Bytes(b) => Value::Blob(b),
    }
}

/// SQLite is dynamically typed: a cell is read by the type of the value it
/// holds, whatever the column declares.
fn to_cell(v: ValueRef<'_>) -> CellValue {
    match v {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(i) => CellValue::from_i64(i),
        ValueRef::Real(f) => CellValue::Float(f),
        ValueRef::Text(t) => CellValue::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => CellValue::Bytes(b.to_vec()),
    }
}

fn col_meta(stmt: &Statement<'_>) -> Vec<ColMeta> {
    stmt.columns()
        .iter()
        .map(|c| ColMeta {
            name: c.name().to_string(),
            // Expressions have no declared type.
            type_name: c.decl_type().unwrap_or("").to_ascii_lowercase(),
            nullable: true,
        })
        .collect()
}

/// Per-query cancel state, shared by the running task and `cancel`.
#[derive(Default)]
struct Flags {
    /// Cleared — under the lock — before the connection returns to the pool.
    active: bool,
    /// Set by `cancel`; checked between statements, where an interrupt
    /// would otherwise fall on no running statement and be lost.
    cancelled: bool,
}

struct Running {
    interrupt: Arc<InterruptHandle>,
    flags: Arc<Mutex<Flags>>,
}

/// Which idle connection a caller wants.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Want {
    /// The one inside an open transaction if there is one (editor queries).
    Any,
    /// One in autocommit mode (`execute_batch` opens its own transaction).
    Autocommit,
}

struct Pool {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

impl Pool {
    fn checkout(&self, want: Want) -> rusqlite::Result<Connection> {
        {
            let mut idle = self.idle.lock().expect("pool lock");
            let pick = match want {
                Want::Any => idle
                    .iter()
                    .position(|c| !c.is_autocommit())
                    .or(idle.len().checked_sub(1)),
                Want::Autocommit => idle.iter().rposition(|c| c.is_autocommit()),
            };
            if let Some(i) = pick {
                return Ok(idle.swap_remove(i));
            }
        }
        open(&self.path)
    }

    fn checkin(&self, conn: Connection) {
        let mut idle = self.idle.lock().expect("pool lock");
        // Never drop a connection mid-transaction: closing it would roll the
        // user's open transaction back.
        if idle.len() < POOL_SIZE || !conn.is_autocommit() {
            idle.push(conn);
        }
    }
}

pub struct SqliteConn {
    pool: Arc<Pool>,
    /// File name, shown as the database in the tree.
    name: String,
    running: Arc<DashMap<QueryHandle, Running>>,
}

impl SqliteConn {
    pub async fn connect(cfg: SqliteConfig) -> DbResult<Arc<Self>> {
        let raw = cfg.path.trim();
        if raw.is_empty() {
            return Err(DbError::Connect("no SQLite file chosen".into()));
        }
        let path = expand_home(raw);
        if !path.exists() {
            return Err(DbError::Connect(format!(
                "SQLite file not found: {}",
                path.display()
            )));
        }
        if !path.is_file() {
            return Err(DbError::Connect(format!("not a file: {}", path.display())));
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "main".into());
        let first = {
            let path = path.clone();
            blocking(move || {
                let conn = open(&path)?;
                // Opening is lazy; reading the schema proves it's a database
                // ("file is not a database" otherwise).
                conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))?;
                Ok(conn)
            })
            .await
            .map_err(DbError::Connect)?
        };
        Ok(Arc::new(Self {
            pool: Arc::new(Pool {
                path,
                idle: Mutex::new(vec![first]),
            }),
            name,
            running: Arc::new(DashMap::new()),
        }))
    }

    /// Run `f` on a pooled connection on a blocking thread.
    async fn with_conn<T, F>(&self, want: Want, f: F) -> DbResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> DbResult<T> + Send + 'static,
    {
        let pool = self.pool.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool.checkout(want).map_err(drv)?;
            let out = f(&mut conn);
            pool.checkin(conn);
            out
        })
        .await
        .map_err(|e| DbError::Driver(format!("sqlite task failed: {e}")))?
    }
}

/// Run a rusqlite closure on a blocking thread; the error as one line.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> rusqlite::Result<T> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r.map_err(|e| sqlite_err(&e)),
        Err(e) => Err(format!("sqlite task failed: {e}")),
    }
}

/// Run every statement of `sql`, stepping through (and discarding) any rows.
/// Returns the rows changed by the DML among them.
fn run_all(conn: &Connection, sql: &str) -> rusqlite::Result<u64> {
    let mut changed = 0u64;
    let mut batch = Batch::new(conn, sql);
    while let Some(mut stmt) = batch.next()? {
        if stmt.column_count() == 0 {
            stmt.raw_execute()?;
            changed += conn.changes();
        } else {
            // `INSERT … RETURNING` both returns rows and changes them.
            let writes = !stmt.readonly();
            let mut rows = stmt.raw_query();
            while rows.next()?.is_some() {}
            if writes {
                changed += conn.changes();
            }
        }
    }
    Ok(changed)
}

fn bind(stmt: &mut Statement<'_>, params: Params) -> rusqlite::Result<()> {
    for (i, p) in params.into_iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, to_sqlite(p))?;
    }
    Ok(())
}

/// Collects rows across statements and flushes them into the sink in
/// batches, the first batch carrying the columns.
struct Drain<'a> {
    sink: &'a RowSink,
    flags: &'a Mutex<Flags>,
    columns: Option<Vec<ColMeta>>,
    sent_columns: bool,
    buf: Vec<Vec<CellValue>>,
    /// The receiver is gone — stop quietly.
    closed: bool,
}

impl Drain<'_> {
    fn cancelled(&self) -> bool {
        self.flags.lock().expect("flags lock").cancelled
    }

    fn statement(&mut self, stmt: &mut Statement<'_>) -> rusqlite::Result<()> {
        if self.cancelled() {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_INTERRUPT),
                None,
            ));
        }
        if stmt.column_count() == 0 {
            stmt.raw_execute()?;
            return Ok(());
        }
        if !self.sent_columns && self.columns.is_none() {
            self.columns = Some(col_meta(stmt));
        }
        let n = stmt.column_count();
        let mut rows = stmt.raw_query();
        while let Some(row) = rows.next()? {
            let mut cells = Vec::with_capacity(n);
            for i in 0..n {
                cells.push(to_cell(row.get_ref(i)?));
            }
            self.buf.push(cells);
            if self.buf.len() >= STREAM_BATCH && !self.flush(false) {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Send what's buffered. False when the receiver is gone.
    fn flush(&mut self, done: bool) -> bool {
        self.sent_columns = true;
        let batch = RowBatch {
            columns: self.columns.take(),
            rows: std::mem::take(&mut self.buf),
            done,
        };
        if self.sink.blocking_send(batch).is_err() {
            self.closed = true;
        }
        !self.closed
    }
}

fn stream_blocking(
    conn: &Connection,
    query: &str,
    params: Params,
    sink: &RowSink,
    flags: &Mutex<Flags>,
) -> rusqlite::Result<()> {
    let mut d = Drain {
        sink,
        flags,
        columns: None,
        sent_columns: false,
        buf: Vec::with_capacity(STREAM_BATCH),
        closed: false,
    };
    if params.is_empty() {
        let mut batch = Batch::new(conn, query);
        while let Some(mut stmt) = batch.next()? {
            d.statement(&mut stmt)?;
            if d.closed {
                return Ok(());
            }
        }
    } else {
        let mut stmt = conn.prepare(query)?;
        bind(&mut stmt, params)?;
        d.statement(&mut stmt)?;
        if d.closed {
            return Ok(());
        }
    }
    d.flush(true);
    Ok(())
}

#[async_trait]
impl DbConnection for SqliteConn {
    fn lang(&self) -> QueryLang {
        QueryLang::Sql
    }

    async fn ping(&self) -> DbResult<()> {
        self.with_conn(Want::Any, |c| {
            c.query_row("SELECT 1", [], |_| Ok(())).map_err(drv)
        })
        .await
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        let name = self.name.clone();
        self.with_conn(Want::Any, move |c| introspect::introspect(c, &name))
            .await
    }

    async fn execute(&self, query: &str, params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let query = query.to_string();
        self.with_conn(Want::Any, move |c| {
            let rows_affected = if params.is_empty() {
                run_all(c, &query).map_err(drv)?
            } else {
                let mut stmt = c.prepare(&query).map_err(drv)?;
                bind(&mut stmt, params).map_err(drv)?;
                if stmt.column_count() == 0 {
                    stmt.raw_execute().map_err(drv)? as u64
                } else {
                    let mut rows = stmt.raw_query();
                    while rows.next().map_err(drv)?.is_some() {}
                    c.changes()
                }
            };
            let id = c.last_insert_rowid();
            Ok(ExecSummary {
                rows_affected,
                last_insert_id: (id != 0).then_some(id),
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        })
        .await
    }

    /// One connection, one transaction. `BEGIN IMMEDIATE` takes the write
    /// lock up front, so a concurrent writer fails here — before anything
    /// ran — rather than halfway through.
    async fn execute_batch(&self, statements: &[String]) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let statements = statements.to_vec();
        let pool = self.pool.clone();
        tokio::task::spawn_blocking(move || {
            let conn = pool.checkout(Want::Autocommit).map_err(drv)?;
            if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
                pool.checkin(conn);
                return Err(drv(e));
            }
            let mut rows_affected = 0u64;
            for (i, stmt) in statements.iter().enumerate() {
                match run_all(&conn, stmt) {
                    Ok(n) => rows_affected += n,
                    Err(e) => {
                        let err = DbError::Driver(format!(
                            "statement {} of {} failed, nothing was applied: {}",
                            i + 1,
                            statements.len(),
                            sqlite_err(&e)
                        ));
                        // Some errors (e.g. SQLITE_FULL) roll back on their
                        // own; a ROLLBACK then fails harmlessly.
                        let _ = conn.execute_batch("ROLLBACK");
                        if conn.is_autocommit() {
                            pool.checkin(conn);
                        } // else: closing it rolls back
                        return Err(err);
                    }
                }
            }
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                if conn.is_autocommit() {
                    pool.checkin(conn);
                }
                return Err(drv(e));
            }
            pool.checkin(conn);
            Ok(ExecSummary {
                rows_affected,
                last_insert_id: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        })
        .await
        .map_err(|e| DbError::Driver(format!("sqlite task failed: {e}")))?
    }

    async fn stream(&self, query: &str, params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let pool = self.pool.clone();
        let conn = {
            let pool = pool.clone();
            blocking(move || pool.checkout(Want::Any))
                .await
                .map_err(DbError::Driver)?
        };
        let handle = QueryHandle::new();
        let flags = Arc::new(Mutex::new(Flags {
            active: true,
            cancelled: false,
        }));
        self.running.insert(
            handle,
            Running {
                interrupt: Arc::new(conn.get_interrupt_handle()),
                flags: flags.clone(),
            },
        );
        let running = self.running.clone();
        let query = query.to_string();

        tokio::task::spawn_blocking(move || {
            if let Err(e) = stream_blocking(&conn, &query, params, &sink, &flags) {
                let _ = sink.blocking_send(RowBatch {
                    columns: None,
                    rows: vec![vec![CellValue::Text(sqlite_err(&e))]],
                    done: true,
                });
            }
            // Retire the handle before the connection returns to the pool;
            // waits for an interrupt in flight (see the module docs).
            flags.lock().expect("flags lock").active = false;
            running.remove(&handle);
            pool.checkin(conn);
        });

        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let (interrupt, flags) = {
            let r = self.running.get(&handle).ok_or(DbError::UnknownHandle)?;
            (r.interrupt.clone(), r.flags.clone())
        };
        let mut f = flags.lock().expect("flags lock");
        if f.active {
            f.cancelled = true;
            interrupt.interrupt();
        }
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_expanded() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_home("~/a.db"), PathBuf::from(home).join("a.db"));
        assert_eq!(expand_home("/tmp/a.db"), PathBuf::from("/tmp/a.db"));
        assert_eq!(expand_home("x~/a.db"), PathBuf::from("x~/a.db"));
    }

    #[test]
    fn values_round_trip_by_storage_class() {
        let c = Connection::open_in_memory().unwrap();
        let row: Vec<CellValue> = c
            .query_row(
                "SELECT NULL, 42, 1.5, 'hi', X'00ff', 9007199254740993",
                [],
                |r| (0..6).map(|i| r.get_ref(i).map(to_cell)).collect(),
            )
            .unwrap();
        assert!(matches!(row[0], CellValue::Null));
        assert!(matches!(row[1], CellValue::Int(42)));
        assert!(matches!(row[2], CellValue::Float(f) if f == 1.5));
        assert!(matches!(&row[3], CellValue::Text(s) if s == "hi"));
        assert!(matches!(&row[4], CellValue::Bytes(b) if b == &[0, 255]));
        assert!(matches!(&row[5], CellValue::Raw(s) if s == "9007199254740993"));
    }
}
