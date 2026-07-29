//! The seam between the sandbox and a real database.
//!
//! The sandbox knows how to run JavaScript and how to expose a `db.query`
//! function; it does *not* know about sqlx, Mongo, connection pools, or
//! `db-core`'s `DbConnection` trait. All of that lives behind [`QueryRunner`].
//! P1 tests drive the sandbox with an in-memory fake; P2 will add an adapter in
//! the Tauri crate that implements this trait over `DbConnection::stream`,
//! collecting the streamed `RowBatch`es into one [`QueryResult`].

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// One query's fully-materialized result, shaped for JS consumption. This is a
/// deliberately JSON-friendly projection of `db-core::RowBatch` — the sandbox
/// converts it into a JS object `{ columns, rows, rowCount }` so a script can
/// write `result.rows[0].id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueryResult {
    /// Column names in order. Rows are objects keyed by these names.
    pub columns: Vec<String>,
    /// Each row is a JSON object keyed by column name. Using objects rather
    /// than positional arrays is what lets a script say `row.user_id`.
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
}

impl QueryResult {
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }
}

/// Executes a single SQL statement on behalf of a running script.
///
/// Implementors run the query against the live connection and materialize the
/// result. Params arrive as JSON values (whatever the script passed to
/// `db.query(sql, params)`); the implementor maps them onto the driver's
/// native parameter type.
#[async_trait]
pub trait QueryRunner: Send + Sync {
    async fn query(&self, sql: &str, params: Vec<serde_json::Value>)
        -> Result<QueryResult, String>;
}
