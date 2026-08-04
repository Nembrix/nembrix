//! Driver-agnostic database abstractions.
//!
//! Every engine (Postgres, MySQL, SQLite, Mongo, Redis) implements [`DbConnection`].
//! The [`QueryLang`] associated value tells the frontend which editor mode to load,
//! and [`CellValue::Document`] is the seam through which document stores flow
//! without polluting the relational path.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueryLang {
    Sql,
    MongoShell,
    RedisCmd,
    /// JavaScript scripting mode. Not a driver's native language — it's an
    /// editor mode layered *over* a SQL connection (see `db-script`). No
    /// driver returns this from [`DbConnection::lang`]; it's a per-tab choice
    /// the frontend makes, offered only when the driver's own `lang()` is
    /// [`QueryLang::Sql`].
    Script,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ColMeta {
    pub name: String,
    /// Driver-native type name (e.g. `text`, `int4`, `jsonb`).
    pub type_name: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CellValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    /// Default text representation for anything driver-rendered as a string.
    Text(String),
    /// Big integers, decimals, dates, intervals — anything that doesn't
    /// round-trip through JSON cleanly. Lossless string form.
    Raw(String),
    /// Document-store values (Mongo) and Postgres `jsonb`. The frontend grid
    /// renders this as a collapsed JSON tree.
    Document(serde_json::Value),
    Bytes(#[serde(with = "serde_bytes")] Vec<u8>),
}

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). An `i64` whose magnitude
/// exceeds this can't be represented exactly once it reaches the frontend as a
/// JSON number, so such values must travel as text ([`CellValue::Raw`]) instead
/// of [`CellValue::Int`].
pub const JS_MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

impl CellValue {
    /// Build a numeric cell from an `i64`, preserving exactness end-to-end.
    /// Values within JS's safe-integer range become [`CellValue::Int`] (a real
    /// number in the grid); anything larger in magnitude becomes
    /// [`CellValue::Raw`] with its exact decimal text, because the frontend
    /// reads `Int` as a JS `number` and would silently round it past 2^53.
    pub fn from_i64(v: i64) -> Self {
        if v.unsigned_abs() <= JS_MAX_SAFE_INT as u64 {
            CellValue::Int(v)
        } else {
            CellValue::Raw(v.to_string())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RowBatch {
    /// Sent on the first batch only; subsequent batches reuse the schema.
    pub columns: Option<Vec<ColMeta>>,
    pub rows: Vec<Vec<CellValue>>,
    /// True when this is the last batch the driver will emit for this query.
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExecSummary {
    pub rows_affected: u64,
    pub last_insert_id: Option<i64>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SchemaTree {
    pub databases: Vec<DatabaseNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DatabaseNode {
    pub name: String,
    pub schemas: Vec<SchemaNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<RelationNode>,
    pub views: Vec<RelationNode>,
    pub functions: Vec<FunctionNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RelationNode {
    pub name: String,
    pub columns: Vec<ColumnNode>,
    pub primary_key: Vec<String>,
    /// Outbound foreign keys: from columns of this relation to a target.
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<IndexNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IndexNode {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    /// btree / hash / gin / gist / brin / spgist
    pub method: String,
    /// Raw DDL fetched via `pg_get_indexdef`. Convenient for the Info panel.
    pub definition: String,
}

/// A single foreign-key constraint. Single-column FKs are by far the
/// common case; multi-column FKs use parallel arrays in `columns` /
/// `referenced_columns`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ColumnNode {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FunctionNode {
    pub name: String,
    pub return_type: String,
    pub argument_types: Vec<String>,
}

/// Driver-typed parameter set. Drivers convert these to their native binding
/// representation before issuing the query.
pub type Params = Vec<CellValue>;

/// Cancellation handle returned by [`DbConnection::stream`]. The driver owns
/// whatever state is needed (e.g. backend PID for `pg_cancel_backend`, the
/// Mongo cursor id) — callers treat this as opaque.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
pub struct QueryHandle(pub Uuid);

impl QueryHandle {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for QueryHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Error)]
pub enum DbError {
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("driver error: {0}")]
    Driver(String),
    #[error("query cancelled")]
    Cancelled,
    #[error("unknown query handle")]
    UnknownHandle,
    #[error("unsupported by this driver: {0}")]
    Unsupported(&'static str),
    #[error(transparent)]
    Other(#[from] anyhow_compat::AnyError),
}

/// Tiny shim so drivers can return arbitrary errors without pulling all of
/// `anyhow` into db-core's public API.
pub mod anyhow_compat {
    use std::fmt;
    #[derive(Debug)]
    pub struct AnyError(pub Box<dyn std::error::Error + Send + Sync + 'static>);
    impl fmt::Display for AnyError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            self.0.fmt(f)
        }
    }
    impl std::error::Error for AnyError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.0.source()
        }
    }
    // We can't write `impl<E: std::error::Error + Send + Sync + 'static>
    // From<E> for AnyError` here — the standard library already provides
    // `From<T> for T` reflexively, so the blanket impl conflicts with
    // `From<AnyError> for AnyError` (which is implied because AnyError
    // implements std::error::Error itself). Older Rust let this slide;
    // post-1.41 trait coherence rejects it.
    //
    // Use the explicit `AnyError::new(err)` constructor at call sites
    // instead of `.into()`.
    impl AnyError {
        pub fn new<E: std::error::Error + Send + Sync + 'static>(e: E) -> Self {
            Self(Box::new(e))
        }
    }
}

pub type DbResult<T> = Result<T, DbError>;

/// Sink for streamed result batches. Implemented as an mpsc sender so the
/// Tauri side can plug a [`tauri::ipc::Channel`] adapter into it without
/// db-core knowing about Tauri.
pub type RowSink = mpsc::Sender<RowBatch>;

#[async_trait]
pub trait DbConnection: Send + Sync {
    fn lang(&self) -> QueryLang;

    /// Cheap round-trip to confirm the connection is alive.
    async fn ping(&self) -> DbResult<()>;

    /// Full catalog walk. Cached by the frontend; refreshed on demand.
    async fn introspect(&self) -> DbResult<SchemaTree>;

    /// Fire-and-forget statement. Returns rows_affected etc.
    async fn execute(&self, query: &str, params: Params) -> DbResult<ExecSummary>;

    /// Streamed read. The driver pushes [`RowBatch`]es into `sink` and returns
    /// a handle the caller can later pass to [`cancel`](Self::cancel).
    async fn stream(&self, query: &str, params: Params, sink: RowSink) -> DbResult<QueryHandle>;

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()>;

    /// Soundness escape hatch for the Tauri layer: each driver returns a
    /// `&dyn Any` over itself so callers can downcast to the concrete type
    /// (e.g. when the Postgres-specific roles/object-ops module needs the
    /// raw `sqlx::Pool`). Drivers implement this as `fn as_any(&self) -> &dyn Any { self }`.
    fn as_any(&self) -> &dyn Any;
}

pub type DynConn = Arc<dyn DbConnection>;

#[cfg(test)]
mod cell_tests {
    use super::*;

    #[test]
    fn from_i64_keeps_safe_ints_as_int() {
        assert!(matches!(CellValue::from_i64(0), CellValue::Int(0)));
        assert!(matches!(CellValue::from_i64(-42), CellValue::Int(-42)));
        assert!(matches!(
            CellValue::from_i64(JS_MAX_SAFE_INT),
            CellValue::Int(_)
        ));
        assert!(matches!(
            CellValue::from_i64(-JS_MAX_SAFE_INT),
            CellValue::Int(_)
        ));
    }

    #[test]
    fn from_i64_routes_unsafe_ints_to_lossless_raw() {
        // Just past the safe boundary, both signs.
        match CellValue::from_i64(JS_MAX_SAFE_INT + 1) {
            CellValue::Raw(s) => assert_eq!(s, "9007199254740992"),
            other => panic!("expected Raw, got {other:?}"),
        }
        match CellValue::from_i64(i64::MAX) {
            CellValue::Raw(s) => assert_eq!(s, "9223372036854775807"),
            other => panic!("expected Raw, got {other:?}"),
        }
        match CellValue::from_i64(i64::MIN) {
            CellValue::Raw(s) => assert_eq!(s, "-9223372036854775808"),
            other => panic!("expected Raw, got {other:?}"),
        }
    }
}
