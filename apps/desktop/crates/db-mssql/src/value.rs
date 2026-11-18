//! SQL Server values → grid cells, typed by the TDS column type.
//!
//! Lossless by construction: decimals and every temporal travel as
//! [`CellValue::Raw`] text in SQL Server's own literal form, and an integer
//! past JS's safe range as text too.

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use db_core::{CellValue, ColMeta};
use tiberius::{Column, ColumnData, ColumnType, FromSql};

pub fn col_meta(c: &Column) -> ColMeta {
    ColMeta {
        name: c.name().to_string(),
        type_name: type_name(c.column_type()).to_string(),
        // TDS result metadata carries no reliable nullability for us.
        nullable: true,
    }
}

/// The SQL Server type name for the grid header and the type-aware editors.
/// The `…n` wire types are "nullable, size in the metadata"; their family
/// name is what matters (numeric vs text vs temporal).
pub fn type_name(t: ColumnType) -> &'static str {
    use ColumnType::*;
    match t {
        Null => "null",
        Bit | Bitn => "bit",
        Int1 => "tinyint",
        Int2 => "smallint",
        Int4 | Intn => "int",
        Int8 => "bigint",
        Float4 => "real",
        Float8 | Floatn => "float",
        Money => "money",
        Money4 => "smallmoney",
        Decimaln | Numericn => "decimal",
        Datetime4 => "smalldatetime",
        Datetime | Datetimen => "datetime",
        Daten => "date",
        Timen => "time",
        Datetime2 => "datetime2",
        DatetimeOffsetn => "datetimeoffset",
        Guid => "uniqueidentifier",
        BigVarBin => "varbinary",
        BigBinary => "binary",
        Image => "image",
        BigVarChar => "varchar",
        BigChar => "char",
        NVarchar => "nvarchar",
        NChar => "nchar",
        Text => "text",
        NText => "ntext",
        Xml => "xml",
        Udt => "udt",
        SSVariant => "sql_variant",
    }
}

pub fn to_cell(d: ColumnData<'static>) -> CellValue {
    match d {
        ColumnData::U8(v) => v.map_or(CellValue::Null, |v| CellValue::Int(v.into())),
        ColumnData::I16(v) => v.map_or(CellValue::Null, |v| CellValue::Int(v.into())),
        ColumnData::I32(v) => v.map_or(CellValue::Null, |v| CellValue::Int(v.into())),
        ColumnData::I64(v) => v.map_or(CellValue::Null, CellValue::from_i64),
        // Via the shortest decimal text, so a `real` 0.1 reads 0.1, not
        // 0.10000000149011612.
        ColumnData::F32(v) => v.map_or(CellValue::Null, |v| {
            CellValue::Float(v.to_string().parse().unwrap_or(v as f64))
        }),
        ColumnData::F64(v) => v.map_or(CellValue::Null, CellValue::Float),
        ColumnData::Bit(v) => v.map_or(CellValue::Null, CellValue::Bool),
        ColumnData::String(v) => v.map_or(CellValue::Null, |s| CellValue::Text(s.into_owned())),
        ColumnData::Guid(v) => v.map_or(CellValue::Null, |g| {
            CellValue::Text(g.to_string().to_ascii_uppercase())
        }),
        ColumnData::Binary(v) => v.map_or(CellValue::Null, |b| CellValue::Bytes(b.into_owned())),
        ColumnData::Numeric(v) => v.map_or(CellValue::Null, |n| CellValue::Raw(n.to_string())),
        ColumnData::Xml(v) => v.map_or(CellValue::Null, |x| CellValue::Text(x.to_string())),
        ref d @ (ColumnData::DateTime(_)
        | ColumnData::SmallDateTime(_)
        | ColumnData::DateTime2(_)) => temporal::<NaiveDateTime>(d, "%Y-%m-%d %H:%M:%S%.f"),
        ref d @ ColumnData::Date(_) => temporal::<NaiveDate>(d, "%Y-%m-%d"),
        ref d @ ColumnData::Time(_) => temporal::<NaiveTime>(d, "%H:%M:%S%.f"),
        ref d @ ColumnData::DateTimeOffset(_) => {
            temporal::<DateTime<FixedOffset>>(d, "%Y-%m-%d %H:%M:%S%.f %:z")
        }
    }
}

fn temporal<'a, T>(d: &'a ColumnData<'static>, fmt: &str) -> CellValue
where
    T: FromSql<'a> + FormatWith,
{
    match T::from_sql(d) {
        Ok(Some(v)) => CellValue::Raw(v.format_with(fmt)),
        Ok(None) => CellValue::Null,
        Err(e) => CellValue::Text(format!("<{e}>")),
    }
}

/// chrono's `format` is inherent on each type; this lets [`temporal`] be
/// generic over them.
trait FormatWith {
    fn format_with(&self, fmt: &str) -> String;
}

macro_rules! format_with {
    ($($t:ty),*) => {$(
        impl FormatWith for $t {
            fn format_with(&self, fmt: &str) -> String {
                self.format(fmt).to_string()
            }
        }
    )*};
}
format_with!(NaiveDateTime, NaiveDate, NaiveTime, DateTime<FixedOffset>);

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn integers_past_js_range_stay_exact() {
        match to_cell(ColumnData::I64(Some(i64::MAX))) {
            CellValue::Raw(s) => assert_eq!(s, "9223372036854775807"),
            other => panic!("expected Raw, got {other:?}"),
        }
        assert!(matches!(
            to_cell(ColumnData::I32(Some(7))),
            CellValue::Int(7)
        ));
    }

    #[test]
    fn real_keeps_its_short_decimal_form() {
        match to_cell(ColumnData::F32(Some(0.1))) {
            CellValue::Float(f) => assert_eq!(f, 0.1),
            other => panic!("expected Float, got {other:?}"),
        }
    }

    #[test]
    fn nulls_of_every_kind_are_null() {
        for d in [
            ColumnData::I32(None),
            ColumnData::String(None),
            ColumnData::Binary(None),
            ColumnData::Bit(None),
        ] {
            assert!(matches!(to_cell(d), CellValue::Null));
        }
        assert!(matches!(
            to_cell(ColumnData::String(Some(Cow::Borrowed("x")))),
            CellValue::Text(_)
        ));
    }
}
