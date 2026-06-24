//! Thin wrapper around `sqlformat` with Postgres-friendly defaults.

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlformat::{FormatOptions, Indent, QueryParams};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub enum IndentStyle {
    Spaces2,
    Spaces4,
    Tabs,
}

impl IndentStyle {
    fn to_sqlformat(self) -> Indent {
        match self {
            IndentStyle::Spaces2 => Indent::Spaces(2),
            IndentStyle::Spaces4 => Indent::Spaces(4),
            IndentStyle::Tabs => Indent::Tabs,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct FormatConfig {
    pub indent: IndentStyle,
    pub uppercase: bool,
    pub lines_between_queries: u8,
}

impl Default for FormatConfig {
    fn default() -> Self {
        Self {
            indent: IndentStyle::Spaces2,
            uppercase: true,
            lines_between_queries: 2,
        }
    }
}

pub fn format(sql: &str, cfg: FormatConfig) -> String {
    let opts = FormatOptions {
        indent: cfg.indent.to_sqlformat(),
        uppercase: cfg.uppercase,
        lines_between_queries: cfg.lines_between_queries,
    };
    sqlformat::format(sql, &QueryParams::None, opts)
}
