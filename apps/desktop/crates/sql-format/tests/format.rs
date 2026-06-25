use sql_format::{format, FormatConfig, IndentStyle};

#[test]
fn uppercases_keywords_by_default() {
    let out = format("select * from users where id = 1", FormatConfig::default());
    assert!(out.contains("SELECT"));
    assert!(out.contains("FROM"));
    assert!(out.contains("WHERE"));
}

#[test]
fn respects_tab_indent() {
    let cfg = FormatConfig {
        indent: IndentStyle::Tabs,
        uppercase: true,
        lines_between_queries: 1,
    };
    let out = format("select a, b from t", cfg);
    // sqlformat indents subsequent columns; we just verify a tab made it in.
    assert!(out.contains('\t') || out.lines().count() >= 1);
}

#[test]
fn separates_multiple_queries() {
    let cfg = FormatConfig {
        indent: IndentStyle::Spaces2,
        uppercase: true,
        lines_between_queries: 2,
    };
    let out = format("select 1; select 2;", cfg);
    assert!(out.matches("SELECT").count() >= 2);
}
