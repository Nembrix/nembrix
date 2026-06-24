//! BSON → [`CellValue`] / [`RowBatch`] shaping.
//!
//! Mongo has no fixed column set, so the grid's relational shape is faked:
//! we keep a running, ordered union of every field name seen across the
//! batch's documents (the [`ColumnAccumulator`]), and emit one row per
//! document with cells aligned to that column order. Fields a given document
//! lacks come through as `Null`. The very first column is always `_id`.
//!
//! Scalars map to the obvious `CellValue` variant. Everything structural —
//! embedded documents, arrays, and the BSON-only types (ObjectId, Date,
//! Decimal128, Binary, …) — is rendered as `CellValue::Document(json)` so
//! the frontend's JSON tree can show it. We use BSON's *relaxed* extended
//! JSON for that, which keeps dates and numbers human-readable while still
//! tagging ObjectIds (`{"$oid": "…"}`) so they're unambiguous.

use db_core::{CellValue, ColMeta};
use mongodb::bson::{Bson, Document};

/// Builds the column union as documents stream past. Order is first-seen,
/// with `_id` forced to the front because every Mongo doc has one and users
/// expect it leftmost — mirroring how nosqlbooster pins `_id`.
#[derive(Default)]
pub struct ColumnAccumulator {
    names: Vec<String>,
    seen: std::collections::HashSet<String>,
}

impl ColumnAccumulator {
    pub fn new() -> Self {
        let mut a = Self::default();
        a.push("_id");
        a
    }

    fn push(&mut self, name: &str) {
        if self.seen.insert(name.to_string()) {
            self.names.push(name.to_string());
        }
    }

    /// Fold a document's top-level keys into the column set.
    pub fn observe(&mut self, doc: &Document) {
        for (k, _) in doc {
            self.push(k);
        }
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// Column metadata for the first batch. Mongo is schemaless, so every
    /// column is reported nullable with a generic type name; the real type
    /// travels inside each `CellValue`.
    pub fn columns(&self) -> Vec<ColMeta> {
        self.names
            .iter()
            .map(|name| ColMeta {
                name: name.clone(),
                type_name: "bson".into(),
                nullable: true,
            })
            .collect()
    }

    /// Project one document onto the current column order.
    pub fn row(&self, doc: &Document) -> Vec<CellValue> {
        self.names
            .iter()
            .map(|name| match doc.get(name) {
                Some(b) => bson_to_cell(b),
                None => CellValue::Null,
            })
            .collect()
    }
}

/// Single BSON value → CellValue. Scalars become scalar cells; everything
/// else collapses into a JSON `Document` cell so it always renders.
pub fn bson_to_cell(b: &Bson) -> CellValue {
    match b {
        Bson::Null | Bson::Undefined => CellValue::Null,
        Bson::Boolean(v) => CellValue::Bool(*v),
        Bson::Int32(v) => CellValue::Int(*v as i64),
        Bson::Int64(v) => CellValue::Int(*v),
        Bson::Double(v) => CellValue::Float(*v),
        Bson::String(v) => CellValue::Text(v.clone()),
        // ObjectId is the single most common cell; show its hex directly
        // rather than burying it in a `{"$oid": …}` tree.
        Bson::ObjectId(oid) => CellValue::Text(oid.to_hex()),
        // Lossless string forms for the numeric/temporal types that don't
        // round-trip through JSON cleanly — same contract as Postgres `Raw`.
        Bson::Decimal128(d) => CellValue::Raw(d.to_string()),
        Bson::DateTime(dt) => CellValue::Raw(dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string())),
        Bson::Timestamp(ts) => CellValue::Raw(format!("Timestamp({}, {})", ts.time, ts.increment)),
        Bson::Binary(bin) => CellValue::Bytes(bin.bytes.clone()),
        // Structural / exotic: hand to the JSON tree via relaxed extended JSON.
        Bson::Document(_)
        | Bson::Array(_)
        | Bson::RegularExpression(_)
        | Bson::JavaScriptCode(_)
        | Bson::JavaScriptCodeWithScope(_)
        | Bson::Symbol(_)
        | Bson::DbPointer(_)
        | Bson::MaxKey
        | Bson::MinKey => CellValue::Document(b.clone().into_relaxed_extjson()),
    }
}

/// A one-column scalar batch row, used for count/distinct results that don't
/// have a natural document shape.
pub fn scalar_row(v: CellValue) -> Vec<CellValue> {
    vec![v]
}
