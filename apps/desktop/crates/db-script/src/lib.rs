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

mod runner;
mod sandbox;

pub use runner::{QueryResult, QueryRunner};

/// Everything a finished script hands back to the caller.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Log,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    /// The script exceeded a configured guard (row cap, etc.). Timeouts are
    /// enforced by the caller via [`run`]'s cancellation, not here.
    #[error("script exceeded limit: {0}")]
    Limit(String),
    #[error("engine error: {0}")]
    Engine(String),
}

/// Guards applied to a single script run. Kept small in P1; P5 adds a
/// wall-clock timeout (enforced by the caller wrapping [`run`] in a
/// `tokio::time::timeout`) and memory limits.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Hard cap on total rows summed across every `db.query` the script runs.
    /// Prevents a loop of unbounded selects from exhausting memory.
    pub max_total_rows: usize,
    /// Hard cap on `db.query` calls, so an accidental infinite loop that only
    /// queries (never allocates unboundedly) still terminates.
    pub max_queries: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_total_rows: 1_000_000,
            max_queries: 100_000,
        }
    }
}

/// Run `source` as a script against `runner`, returning the grid data and
/// captured logs. `runner` is the only way the script can reach a database.
pub async fn run(
    source: &str,
    runner: Arc<dyn QueryRunner>,
    limits: Limits,
) -> Result<ScriptOutcome, ScriptError> {
    sandbox::execute(source, runner, limits).await
}
