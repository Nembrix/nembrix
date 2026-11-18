//! Turn a Redis reply into a grid table.
//!
//! Replies are shaped by the command that produced them, so the grid shows
//! what a person expects rather than a raw nested array:
//!
//! | reply                                   | columns            |
//! |-----------------------------------------|--------------------|
//! | scalar (`GET`, `INCR`, `TYPE`, …)       | `value`            |
//! | `HGETALL`, `CONFIG GET`, RESP3 maps      | `field`, `value`   |
//! | `… WITHSCORES`                          | `member`, `score`  |
//! | `SCAN` / `SSCAN`                        | `key` / `member`   |
//! | `HSCAN` / `ZSCAN`                       | as `HGETALL` / `WITHSCORES` |
//! | `XRANGE` / `XREVRANGE`                  | `id`, `fields`     |
//! | any other array or set                  | `index`, `value`   |
//!
//! The `*SCAN` cursor isn't lost: it rides in the first column's type label
//! (`next cursor: 42`), so the user can continue the scan.

use crate::parse::Command;
use db_core::{CellValue, ColMeta};
use redis::Value;

pub struct Table {
    pub columns: Vec<ColMeta>,
    pub rows: Vec<Vec<CellValue>>,
}

fn col(name: &str) -> ColMeta {
    ColMeta {
        name: name.to_string(),
        type_name: String::new(),
        nullable: true,
    }
}

fn table(names: &[&str], rows: Vec<Vec<CellValue>>) -> Table {
    Table {
        columns: names.iter().map(|n| col(n)).collect(),
        rows,
    }
}

/// Shape one command's reply. A server error becomes `Err` with its message.
pub fn shape(cmd: &Command, value: Value) -> Result<Table, String> {
    if let Value::ServerError(e) = &value {
        return Err(e.to_string());
    }
    let name = cmd.name();
    match value {
        Value::Map(pairs) => Ok(table(
            &["field", "value"],
            pairs
                .into_iter()
                .map(|(k, v)| vec![cell(k), cell(v)])
                .collect(),
        )),
        Value::Array(items) | Value::Set(items) => Ok(shape_array(cmd, &name, items)),
        Value::Attribute { data, .. } => shape(cmd, *data),
        scalar => Ok(table(&["value"], vec![vec![cell(scalar)]])),
    }
}

fn shape_array(cmd: &Command, name: &str, items: Vec<Value>) -> Table {
    match name {
        "SCAN" | "SSCAN" | "HSCAN" | "ZSCAN" if is_scan_reply(&items) => {
            let mut it = items.into_iter();
            let cursor = scalar_text(it.next().unwrap());
            let Some(Value::Array(found)) = it.next() else {
                unreachable!("checked by is_scan_reply")
            };
            let mut t = match name {
                "HSCAN" => pairs(found, "field", "value", false),
                "ZSCAN" => pairs(found, "member", "score", true),
                "SSCAN" => single(found, "member"),
                _ => single(found, "key"),
            };
            t.columns[0].type_name = format!("next cursor: {cursor}");
            t
        }
        "HGETALL" => pairs(items, "field", "value", false),
        "CONFIG" if cmd.arg_upper(0).as_deref() == Some("GET") => {
            pairs(items, "field", "value", false)
        }
        "HRANDFIELD" if cmd.has_keyword("WITHVALUES") => pairs(items, "field", "value", false),
        _ if cmd.has_keyword("WITHSCORES") && is_flat(&items) => {
            pairs(items, "member", "score", true)
        }
        "XRANGE" | "XREVRANGE" => stream_entries(items),
        _ => table(
            &["index", "value"],
            items
                .into_iter()
                .enumerate()
                .map(|(i, v)| vec![CellValue::from_i64(i as i64), cell(v)])
                .collect(),
        ),
    }
}

/// `[cursor, [items…]]`
fn is_scan_reply(items: &[Value]) -> bool {
    items.len() == 2 && matches!(items[1], Value::Array(_)) && !is_aggregate(&items[0])
}

fn is_aggregate(v: &Value) -> bool {
    matches!(
        v,
        Value::Array(_) | Value::Set(_) | Value::Map(_) | Value::Push { .. }
    )
}

fn is_flat(items: &[Value]) -> bool {
    !items.iter().any(is_aggregate)
}

fn single(items: Vec<Value>, name: &str) -> Table {
    table(&[name], items.into_iter().map(|v| vec![cell(v)]).collect())
}

/// A flat `[k1, v1, k2, v2, …]` reply as two columns. RESP3 servers may send
/// `[[k1, v1], …]` instead; both are accepted. `numeric_value` turns the second
/// column into numbers (sorted-set scores arrive as strings over RESP2).
fn pairs(items: Vec<Value>, k: &str, v: &str, numeric_value: bool) -> Table {
    let val = |x: Value| if numeric_value { number(x) } else { cell(x) };
    let rows = if items
        .iter()
        .all(|i| matches!(i, Value::Array(p) if p.len() == 2))
    {
        items
            .into_iter()
            .map(|i| match i {
                Value::Array(mut p) => {
                    let b = p.pop().unwrap();
                    let a = p.pop().unwrap();
                    vec![cell(a), val(b)]
                }
                _ => unreachable!(),
            })
            .collect()
    } else {
        let mut rows = Vec::with_capacity(items.len() / 2);
        let mut it = items.into_iter();
        while let Some(a) = it.next() {
            rows.push(vec![cell(a), it.next().map(val).unwrap_or(CellValue::Null)]);
        }
        rows
    };
    table(&[k, v], rows)
}

/// `XRANGE` entries: `[[id, [f1, v1, …]], …]` → `id`, `fields` (an object).
fn stream_entries(items: Vec<Value>) -> Table {
    let rows = items
        .into_iter()
        .map(|entry| match entry {
            Value::Array(mut parts) if parts.len() == 2 => {
                let fields = parts.pop().unwrap();
                let id = parts.pop().unwrap();
                let mut obj = serde_json::Map::new();
                if let Value::Array(kv) = fields {
                    let mut it = kv.into_iter();
                    while let (Some(k), Some(v)) = (it.next(), it.next()) {
                        obj.insert(scalar_text(k), to_json(v));
                    }
                }
                vec![
                    cell(id),
                    CellValue::Document(serde_json::Value::Object(obj)),
                ]
            }
            other => vec![CellValue::Null, cell(other)],
        })
        .collect();
    table(&["id", "fields"], rows)
}

/// A reply value as one grid cell. Aggregates become a JSON document.
pub fn cell(v: Value) -> CellValue {
    match v {
        Value::Nil => CellValue::Null,
        Value::Int(i) => CellValue::from_i64(i),
        Value::Double(f) => CellValue::Float(f),
        Value::Boolean(b) => CellValue::Bool(b),
        Value::Okay => CellValue::Text("OK".into()),
        Value::SimpleString(s) => CellValue::Text(s),
        Value::VerbatimString { text, .. } => CellValue::Text(text),
        Value::BulkString(b) => match String::from_utf8(b) {
            Ok(s) => CellValue::Text(s),
            Err(e) => CellValue::Bytes(e.into_bytes()),
        },
        Value::BigNumber(n) => CellValue::Raw(big_text(n)),
        Value::ServerError(e) => CellValue::Text(format!("(error) {e}")),
        Value::Attribute { data, .. } => cell(*data),
        agg => CellValue::Document(to_json(agg)),
    }
}

/// A score-like value as a number when it parses as one.
fn number(v: Value) -> CellValue {
    match &v {
        Value::BulkString(b) => match std::str::from_utf8(b)
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
        {
            Some(f) => CellValue::Float(f),
            None => cell(v),
        },
        _ => cell(v),
    }
}

/// JSON form of a reply, for document cells.
pub fn to_json(v: Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Nil => J::Null,
        Value::Int(i) => J::from(i),
        Value::Double(f) => serde_json::Number::from_f64(f)
            .map(J::Number)
            .unwrap_or_else(|| J::String(f.to_string())),
        Value::Boolean(b) => J::Bool(b),
        Value::Okay => J::String("OK".into()),
        Value::SimpleString(s) => J::String(s),
        Value::VerbatimString { text, .. } => J::String(text),
        Value::BulkString(b) => J::String(String::from_utf8_lossy(&b).into_owned()),
        Value::BigNumber(n) => J::String(big_text(n)),
        Value::Array(items) | Value::Set(items) => {
            J::Array(items.into_iter().map(to_json).collect())
        }
        Value::Push { data, .. } => J::Array(data.into_iter().map(to_json).collect()),
        Value::Map(pairs) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in pairs {
                obj.insert(scalar_text(k), to_json(v));
            }
            J::Object(obj)
        }
        Value::Attribute { data, .. } => to_json(*data),
        Value::ServerError(e) => J::String(format!("(error) {e}")),
        // `Value` is non-exhaustive; show a future variant rather than drop it.
        other => J::String(format!("{other:?}")),
    }
}

/// Plain text of a scalar reply (cursor, hash field, stream id).
pub fn scalar_text(v: Value) -> String {
    match v {
        Value::BulkString(b) => String::from_utf8_lossy(&b).into_owned(),
        Value::SimpleString(s) => s,
        Value::Int(i) => i.to_string(),
        Value::Okay => "OK".into(),
        other => to_json(other).to_string(),
    }
}

/// RESP3 big number. Without redis' `num-bigint` feature (we don't enable it)
/// the payload is the decimal digits as bytes.
fn big_text(n: Vec<u8>) -> String {
    String::from_utf8_lossy(&n).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_script;

    fn bulk(s: &str) -> Value {
        Value::BulkString(s.as_bytes().to_vec())
    }

    fn run(cmd: &str, v: Value) -> Table {
        shape(&parse_script(cmd).unwrap()[0], v).unwrap()
    }

    fn names(t: &Table) -> Vec<&str> {
        t.columns.iter().map(|c| c.name.as_str()).collect()
    }

    fn text(c: &CellValue) -> String {
        match c {
            CellValue::Text(s) => s.clone(),
            CellValue::Float(f) => f.to_string(),
            CellValue::Int(i) => i.to_string(),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn scalar_is_one_value_cell() {
        let t = run("GET k", bulk("v"));
        assert_eq!(names(&t), ["value"]);
        assert_eq!(text(&t.rows[0][0]), "v");
        assert!(matches!(
            run("GET missing", Value::Nil).rows[0][0],
            CellValue::Null
        ));
    }

    #[test]
    fn hgetall_is_field_value_pairs() {
        let t = run(
            "HGETALL h",
            Value::Array(vec![bulk("a"), bulk("1"), bulk("b"), bulk("2")]),
        );
        assert_eq!(names(&t), ["field", "value"]);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(text(&t.rows[1][0]), "b");
    }

    #[test]
    fn withscores_parses_scores_as_numbers() {
        let t = run(
            "ZRANGE board 0 -1 WITHSCORES",
            Value::Array(vec![bulk("ann"), bulk("1.5"), bulk("bob"), bulk("3")]),
        );
        assert_eq!(names(&t), ["member", "score"]);
        assert!(matches!(t.rows[0][1], CellValue::Float(f) if f == 1.5));
    }

    #[test]
    fn resp3_nested_pairs_are_accepted() {
        let t = run(
            "ZRANGE board 0 -1 WITHSCORES",
            Value::Array(vec![Value::Array(vec![bulk("ann"), Value::Double(2.0)])]),
        );
        assert_eq!(t.rows.len(), 1);
    }

    #[test]
    fn scan_shows_items_and_keeps_the_cursor() {
        let t = run(
            "SCAN 0 COUNT 10",
            Value::Array(vec![bulk("17"), Value::Array(vec![bulk("a"), bulk("b")])]),
        );
        assert_eq!(names(&t), ["key"]);
        assert_eq!(t.columns[0].type_name, "next cursor: 17");
        assert_eq!(t.rows.len(), 2);

        let h = run(
            "HSCAN h 0",
            Value::Array(vec![bulk("0"), Value::Array(vec![bulk("f"), bulk("v")])]),
        );
        assert_eq!(names(&h), ["field", "value"]);
    }

    #[test]
    fn xrange_is_id_and_field_object() {
        let t = run(
            "XRANGE s - +",
            Value::Array(vec![Value::Array(vec![
                bulk("1-0"),
                Value::Array(vec![bulk("temp"), bulk("21")]),
            ])]),
        );
        assert_eq!(names(&t), ["id", "fields"]);
        match &t.rows[0][1] {
            CellValue::Document(d) => assert_eq!(d["temp"], "21"),
            other => panic!("expected document, got {other:?}"),
        }
    }

    #[test]
    fn other_arrays_are_indexed() {
        let t = run("LRANGE l 0 -1", Value::Array(vec![bulk("x"), bulk("y")]));
        assert_eq!(names(&t), ["index", "value"]);
        assert!(matches!(t.rows[1][0], CellValue::Int(1)));
    }

    #[test]
    fn resp3_map_is_field_value() {
        let t = run("HGETALL h", Value::Map(vec![(bulk("a"), Value::Int(1))]));
        assert_eq!(names(&t), ["field", "value"]);
    }

    #[test]
    fn binary_values_stay_bytes() {
        let t = run("GET bin", Value::BulkString(vec![0xff, 0x00]));
        assert!(matches!(&t.rows[0][0], CellValue::Bytes(b) if b == &vec![0xff, 0x00]));
    }
}
