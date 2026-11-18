//! MySQL values → grid cells, typed by the column's MySQL type.
//!
//! Over the text protocol every non-NULL value arrives as bytes; the column
//! metadata says what they mean. The binary protocol (parameterised queries)
//! delivers typed [`Value`]s, handled too. Lossless by construction: anything
//! that doesn't fit a JS number exactly travels as [`CellValue::Raw`] text.

use db_core::{CellValue, ColMeta};
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::{Column, Value};

/// `character_set` 63 is MySQL's `binary` collation: the bytes are not text.
const BINARY_CHARSET: u16 = 63;

pub fn col_meta(c: &Column) -> ColMeta {
    ColMeta {
        name: c.name_str().into_owned(),
        type_name: type_name(c).to_string(),
        nullable: !c.flags().contains(ColumnFlags::NOT_NULL_FLAG),
    }
}

/// A readable MySQL type name for the grid header.
pub fn type_name(c: &Column) -> &'static str {
    use ColumnType::*;
    let binary = c.character_set() == BINARY_CHARSET;
    match c.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        MYSQL_TYPE_STRING => {
            if binary {
                "binary"
            } else {
                "char"
            }
        }
        _ => "unknown",
    }
}

pub fn to_cell(v: Value, c: &Column) -> CellValue {
    match v {
        Value::NULL => CellValue::Null,
        Value::Bytes(b) => bytes_cell(b, c),
        Value::Int(i) => CellValue::from_i64(i),
        Value::UInt(u) => from_u64(u),
        Value::Float(f) => CellValue::Float(f as f64),
        Value::Double(f) => CellValue::Float(f),
        // Binary-protocol temporals: render in MySQL's own text form so the
        // grid shows the same thing either protocol would.
        Value::Date(y, mo, d, h, mi, s, us) => {
            let date = format!("{y:04}-{mo:02}-{d:02}");
            CellValue::Raw(match (c.column_type(), h, mi, s, us) {
                (ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE, ..) => date,
                (_, _, _, _, 0) => format!("{date} {h:02}:{mi:02}:{s:02}"),
                _ => format!("{date} {h:02}:{mi:02}:{s:02}.{us:06}"),
            })
        }
        Value::Time(neg, days, h, mi, s, us) => {
            let hours = days * 24 + h as u32;
            let sign = if neg { "-" } else { "" };
            CellValue::Raw(if us == 0 {
                format!("{sign}{hours:02}:{mi:02}:{s:02}")
            } else {
                format!("{sign}{hours:02}:{mi:02}:{s:02}.{us:06}")
            })
        }
    }
}

fn from_u64(u: u64) -> CellValue {
    match i64::try_from(u) {
        Ok(i) => CellValue::from_i64(i),
        Err(_) => CellValue::Raw(u.to_string()),
    }
}

/// A text-protocol value: bytes, typed by the column.
fn bytes_cell(b: Vec<u8>, c: &Column) -> CellValue {
    use ColumnType::*;
    let unsigned = c.flags().contains(ColumnFlags::UNSIGNED_FLAG);
    let text = || String::from_utf8_lossy(&b).into_owned();
    match c.column_type() {
        MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_INT24 | MYSQL_TYPE_LONG
        | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_YEAR => {
            let s = text();
            let parsed = if unsigned {
                s.parse::<u64>().ok().map(from_u64)
            } else {
                s.parse::<i64>().ok().map(CellValue::from_i64)
            };
            parsed.unwrap_or(CellValue::Raw(s))
        }
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => {
            let s = text();
            s.parse::<f64>()
                .map(CellValue::Float)
                .unwrap_or(CellValue::Raw(s))
        }
        // Exact decimals and temporals keep their server text.
        MYSQL_TYPE_DECIMAL
        | MYSQL_TYPE_NEWDECIMAL
        | MYSQL_TYPE_DATE
        | MYSQL_TYPE_NEWDATE
        | MYSQL_TYPE_TIME
        | MYSQL_TYPE_TIME2
        | MYSQL_TYPE_DATETIME
        | MYSQL_TYPE_DATETIME2
        | MYSQL_TYPE_TIMESTAMP
        | MYSQL_TYPE_TIMESTAMP2 => CellValue::Raw(text()),
        // BIT(n) arrives as n bits, big-endian.
        MYSQL_TYPE_BIT => {
            let n = b.iter().fold(0u64, |acc, byte| (acc << 8) | *byte as u64);
            from_u64(n)
        }
        MYSQL_TYPE_JSON => {
            let s = text();
            serde_json::from_str(&s)
                .map(CellValue::Document)
                .unwrap_or(CellValue::Text(s))
        }
        MYSQL_TYPE_GEOMETRY => CellValue::Bytes(b),
        _ if c.character_set() == BINARY_CHARSET => CellValue::Bytes(b),
        _ => match String::from_utf8(b) {
            Ok(s) => CellValue::Text(s),
            Err(e) => CellValue::Bytes(e.into_bytes()),
        },
    }
}
