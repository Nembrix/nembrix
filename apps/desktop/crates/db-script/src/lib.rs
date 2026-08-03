//! JavaScript scripting mode for RDBMS connections.
//!
//! A user writes ordinary JavaScript in a Script tab — `await db.query(sql,
//! params)` with loops and branching — and it runs against the live SQL
//! connection. This crate embeds QuickJS (via [`rquickjs`]) and hands the
//! engine exactly one capability: a `db.query` host function. Everything else
//! a normal JS environment might reach (filesystem, network, timers, `eval` of
//! new modules) is simply never installed, so a script can touch the database
//! and nothing else on the machine.
//!
//! The seam is [`QueryRunner`]: the sandbox depends on that trait, not on
//! `db-core`'s driver types. P1 exercises it with an in-memory fake; P2 plugs
//! in an adapter over the real `DbConnection::stream`.
//!
//! Results follow the "last query + log" model from the design doc: the value
//! the script `return`s (or its last `db.query` result if it returns nothing)
//! becomes the grid data, and every `console.log` line is captured into
//! [`ScriptOutcome::logs`].

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;

mod runner;
mod sandbox;

pub use runner::{QueryResult, QueryRunner};

/// Everything a finished script hands back to the caller.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct ScriptOutcome {
    /// The grid payload: the script's return value, coerced to a
    /// [`QueryResult`] when it is one, otherwise the last `db.query` result the
    /// script ran. `None` when the script returned a non-tabular value and ran
    /// no queries (e.g. a pure `console.log` script).
    pub data: Option<QueryResult>,
    /// `console.log` / `console.error` lines, in emission order.
    pub logs: Vec<LogLine>,
    /// Number of `db.query` calls the script made — surfaced in the Message tab
    /// so an empty grid reads as "ran N queries, 0 rows" rather than "broken".
    pub query_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Log,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Type)]
pub struct LogLine {
    pub level: LogLevel,
    pub text: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ScriptError {
    /// The script threw or failed to parse. Carries the JS-side message.
    #[error("script error: {0}")]
    Js(String),
    /// A `db.query` call failed inside the script. Carries the driver message.
    #[error("query failed: {0}")]
    Query(String),
    /// The script exceeded a configured guard (row cap, query cap).
    #[error("script exceeded limit: {0}")]
    Limit(String),
    /// The script ran longer than the configured wall-clock timeout.
    #[error("script timed out after {0:?}")]
    Timeout(std::time::Duration),
    /// The script was cancelled by the user.
    #[error("script cancelled")]
    Cancelled,
    #[error("engine error: {0}")]
    Engine(String),
}

/// Guards applied to a single script run.
#[derive(Clone)]
pub struct Limits {
    /// Hard cap on total rows summed across every `db.query` the script runs.
    /// Prevents a loop of unbounded selects from exhausting memory.
    pub max_total_rows: usize,
    /// Hard cap on `db.query` calls, so an accidental infinite loop that only
    /// queries (never allocates unboundedly) still terminates.
    pub max_queries: u32,
    /// Wall-clock timeout for the whole run. Enforced by an rquickjs interrupt
    /// handler that fires an uncatchable exception once elapsed — this is what
    /// stops a pure `while (true) {}` that never awaits (a `tokio` timeout on
    /// the caller can't, since the engine thread would spin forever).
    pub timeout: std::time::Duration,
    /// Cooperative cancellation flag. When flipped to `true` (by the Tauri
    /// `cancel_script` command), the same interrupt handler tears the script
    /// down at the next check. Shared so the engine thread and the command
    /// handler point at one bool.
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_total_rows: 1_000_000,
            max_queries: 100_000,
            timeout: std::time::Duration::from_secs(30),
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

/// Run `source` as a script against `runner`, returning the grid data and
/// captured logs. `runner` is the only way the script can reach a database.
///
/// ## Threading
///
/// QuickJS is single-threaded: rquickjs's `AsyncRuntime`/`AsyncContext` are
/// `!Send`, so the engine (and any future that holds it across an `.await`)
/// cannot cross threads. Tauri commands, however, require `Send` futures. We
/// bridge the two by confining the entire engine to a dedicated OS thread that
/// runs its own current-thread Tokio runtime with a `LocalSet`, and handing the
/// result back over a `Send` oneshot channel. The future this function returns
/// is therefore `Send` even though nothing inside the engine is.
///
/// The `runner`'s own futures (which call back into the driver's multi-threaded
/// pool) execute on that current-thread runtime — that's fine, they only need
/// to be pollable there, not `Send` across it.
pub async fn run(
    source: &str,
    runner: Arc<dyn QueryRunner>,
    limits: Limits,
) -> Result<ScriptOutcome, ScriptError> {
    let source = source.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();

    std::thread::Builder::new()
        .name("nembrix-script".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = tx.send(Err(ScriptError::Engine(e.to_string())));
                    return;
                }
            };
            let local = tokio::task::LocalSet::new();
            let outcome = local.block_on(&rt, sandbox::execute(&source, runner, limits));
            let _ = tx.send(outcome);
        })
        .map_err(|e| ScriptError::Engine(e.to_string()))?;

    rx.await
        .map_err(|_| ScriptError::Engine("script thread terminated unexpectedly".into()))?
}
