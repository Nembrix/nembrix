//! Integration tests against real SQLite files in a temp directory.

use db_core::{CellValue, ColMeta, DbConnection, DbError, RowBatch};
use db_sqlite::{SqliteConfig, SqliteConn};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const SCHEMA: &str = "
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES authors ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'untitled',
        price NUMERIC,
        cover BLOB,
        meta JSON
    );
    CREATE INDEX books_title_idx ON books (title);
    CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (b, a)) WITHOUT ROWID;
    CREATE VIEW cheap AS SELECT id, title FROM books WHERE price < 10;
    INSERT INTO authors VALUES (1, 'Ann'), (2, 'Bo');
    INSERT INTO books (id, author_id, title, price, cover, meta)
         VALUES (1, 1, 'A', 9.5, X'00ff', '{\"k\": 1}'), (2, 2, 'B', 20, NULL, NULL);
";

/// A database file with the test schema, plus the dir that keeps it alive.
fn fixture() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch(SCHEMA).unwrap();
    (dir, path.to_string_lossy().into_owned())
}

async fn connect(path: &str) -> Arc<SqliteConn> {
    SqliteConn::connect(SqliteConfig { path: path.into() })
        .await
        .unwrap()
}

#[derive(Debug, Default)]
struct Out {
    columns: Vec<ColMeta>,
    rows: Vec<Vec<CellValue>>,
}

async fn query(conn: &SqliteConn, sql: &str, params: Vec<CellValue>) -> Out {
    let (tx, mut rx) = mpsc::channel::<RowBatch>(16);
    conn.stream(sql, params, tx).await.unwrap();
    let mut out = Out::default();
    while let Some(b) = rx.recv().await {
        if let Some(c) = b.columns {
            out.columns = c;
        }
        out.rows.extend(b.rows);
        if b.done {
            break;
        }
    }
    out
}

fn text(c: &CellValue) -> String {
    match c {
        CellValue::Null => "NULL".into(),
        CellValue::Bool(b) => b.to_string(),
        CellValue::Int(i) => i.to_string(),
        CellValue::Float(f) => f.to_string(),
        CellValue::Text(s) | CellValue::Raw(s) => s.clone(),
        CellValue::Document(d) => d.to_string(),
        CellValue::Bytes(b) => format!("{b:?}"),
    }
}

fn connect_err(e: DbError) -> String {
    match e {
        DbError::Connect(m) => m,
        other => panic!("expected a connect error, got {other:?}"),
    }
}

#[tokio::test]
async fn refuses_a_missing_file_instead_of_creating_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("typo.db");
    let err = SqliteConn::connect(SqliteConfig {
        path: path.to_string_lossy().into(),
    })
    .await
    .err()
    .unwrap();
    assert!(connect_err(err).contains("SQLite file not found"));
    assert!(!path.exists(), "connect must not create the file");
}

#[tokio::test]
async fn refuses_a_file_that_is_not_a_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "hello, this is not sqlite ".repeat(40)).unwrap();
    let err = SqliteConn::connect(SqliteConfig {
        path: path.to_string_lossy().into(),
    })
    .await
    .err()
    .unwrap();
    assert!(connect_err(err).contains("file is not a database"));
}

#[tokio::test]
async fn refuses_a_directory_and_an_empty_path() {
    let dir = tempfile::tempdir().unwrap();
    let e = SqliteConn::connect(SqliteConfig {
        path: dir.path().to_string_lossy().into(),
    })
    .await
    .err()
    .unwrap();
    assert!(connect_err(e).contains("not a file"));
    let e = SqliteConn::connect(SqliteConfig { path: "  ".into() })
        .await
        .err()
        .unwrap();
    assert!(connect_err(e).contains("no SQLite file"));
}

#[tokio::test]
async fn introspects_tables_views_keys_and_indexes() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let tree = conn.introspect().await.unwrap();
    assert_eq!(tree.databases.len(), 1);
    assert_eq!(tree.databases[0].name, "test.db");
    let main = &tree.databases[0].schemas[0];
    assert_eq!(main.name, "main");
    let names: Vec<_> = main.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["authors", "books", "pairs"]);
    assert_eq!(main.views.len(), 1);
    assert_eq!(main.views[0].name, "cheap");
    assert_eq!(main.views[0].columns.len(), 2);

    let books = &main.tables[1];
    assert_eq!(books.primary_key, ["id"]);
    let title = books.columns.iter().find(|c| c.name == "title").unwrap();
    assert_eq!(title.type_name, "text");
    assert!(!title.nullable);
    assert_eq!(title.default.as_deref(), Some("'untitled'"));
    // `REFERENCES authors` with no column: resolved to the target's PK.
    let fk = &books.foreign_keys[0];
    assert_eq!(fk.columns, ["author_id"]);
    assert_eq!(fk.referenced_table, "authors");
    assert_eq!(fk.referenced_columns, ["id"]);
    assert_eq!(fk.referenced_schema, "main");
    let idx = books
        .indexes
        .iter()
        .find(|i| i.name == "books_title_idx")
        .unwrap();
    assert_eq!(idx.columns, ["title"]);
    assert!(idx.definition.starts_with("CREATE INDEX"));

    // A UNIQUE constraint's auto-index, described from its columns.
    let authors = &main.tables[0];
    let uq = authors.indexes.iter().find(|i| i.is_unique).unwrap();
    assert_eq!(uq.columns, ["name"]);
    assert_eq!(uq.definition, "UNIQUE (name)");

    // A composite PK keeps its declared order, not the column order.
    let pairs = &main.tables[2];
    assert_eq!(pairs.primary_key, ["b", "a"]);
    assert!(pairs.indexes.iter().any(|i| i.is_primary));
}

#[tokio::test]
async fn attached_databases_show_up_as_schemas() {
    let (dir, path) = fixture();
    let other = dir.path().join("other.db");
    rusqlite::Connection::open(&other)
        .unwrap()
        .execute_batch("CREATE TABLE t (x)")
        .unwrap();
    let conn = connect(&path).await;
    // Sequential calls reuse the one idle connection, which carries the ATTACH.
    let sql = format!(
        "ATTACH DATABASE '{}' AS other",
        other.to_string_lossy().replace('\'', "''")
    );
    conn.execute(&sql, vec![]).await.unwrap();
    let tree = conn.introspect().await.unwrap();
    let schemas: Vec<_> = tree.databases[0]
        .schemas
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(schemas, ["main", "other"]);
}

#[tokio::test]
async fn cells_follow_the_stored_value_and_columns_the_declaration() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let out = query(
        &conn,
        "SELECT id, title, price, cover, meta, 1 + 1 AS two FROM books ORDER BY id",
        vec![],
    )
    .await;
    let types: Vec<_> = out.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(types, ["integer", "text", "numeric", "blob", "json", ""]);
    let a = &out.rows[0];
    assert!(matches!(a[0], CellValue::Int(1)));
    assert!(matches!(&a[1], CellValue::Text(s) if s == "A"));
    assert!(matches!(a[2], CellValue::Float(f) if f == 9.5));
    assert!(matches!(&a[3], CellValue::Bytes(b) if b == &[0, 255]));
    assert!(matches!(&a[4], CellValue::Text(s) if s == "{\"k\": 1}"));
    assert!(matches!(a[5], CellValue::Int(2)));
    // NUMERIC affinity stores 20 as an integer.
    assert!(matches!(out.rows[1][2], CellValue::Int(20)));
    assert!(matches!(out.rows[1][3], CellValue::Null));
}

#[tokio::test]
async fn params_are_bound_not_interpolated() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let evil = "x'); DROP TABLE books; --";
    let out = query(
        &conn,
        "SELECT ?, ?2 + 1, typeof(?3)",
        vec![
            CellValue::Text(evil.into()),
            CellValue::Int(41),
            CellValue::Bytes(vec![1]),
        ],
    )
    .await;
    assert_eq!(text(&out.rows[0][0]), evil);
    assert_eq!(text(&out.rows[0][1]), "42");
    assert_eq!(text(&out.rows[0][2]), "blob");
    let out = query(&conn, "SELECT count(*) FROM books", vec![]).await;
    assert_eq!(text(&out.rows[0][0]), "2");
}

#[tokio::test]
async fn multi_statement_runs_and_streams_large_results() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    // DML then a SELECT: the rows come back under the SELECT's columns.
    let out = query(
        &conn,
        "INSERT INTO authors (name) VALUES ('Cy'); SELECT name FROM authors ORDER BY id;",
        vec![],
    )
    .await;
    assert_eq!(out.columns[0].name, "name");
    assert_eq!(out.rows.len(), 3);

    // DML only: no columns at all.
    let out = query(&conn, "UPDATE books SET price = price + 1;", vec![]).await;
    assert!(out.columns.is_empty() && out.rows.is_empty());

    // More rows than one batch.
    let out = query(
        &conn,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) SELECT i FROM n",
        vec![],
    )
    .await;
    assert_eq!(out.rows.len(), 1000);
    assert_eq!(text(&out.rows[999][0]), "1000");
}

#[tokio::test]
async fn errors_arrive_in_band_once() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let out = query(&conn, "SELECT * FROM nope", vec![]).await;
    assert!(out.columns.is_empty());
    assert_eq!(out.rows.len(), 1);
    assert_eq!(text(&out.rows[0][0]), "no such table: nope");
}

#[tokio::test]
async fn execute_reports_changes_and_rowid() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let s = conn
        .execute(
            "INSERT INTO authors (name) VALUES (?)",
            vec![CellValue::Text("Di".into())],
        )
        .await
        .unwrap();
    assert_eq!(s.rows_affected, 1);
    assert_eq!(s.last_insert_id, Some(3));
    let s = conn
        .execute("UPDATE books SET price = 1", vec![])
        .await
        .unwrap();
    assert_eq!(s.rows_affected, 2);
}

#[tokio::test]
async fn foreign_keys_are_enforced_and_cascade() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let e = conn
        .execute("INSERT INTO books (author_id) VALUES (99)", vec![])
        .await
        .unwrap_err();
    assert!(e.to_string().contains("FOREIGN KEY constraint failed"));
    conn.execute("DELETE FROM authors WHERE id = 1", vec![])
        .await
        .unwrap();
    let out = query(&conn, "SELECT count(*) FROM books", vec![]).await;
    assert_eq!(text(&out.rows[0][0]), "1");
}

#[tokio::test]
async fn execute_batch_is_all_or_nothing() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let ok = conn
        .execute_batch(&[
            "INSERT INTO authors (name) VALUES ('X')".into(),
            "UPDATE books SET title = 'Z'".into(),
        ])
        .await
        .unwrap();
    assert_eq!(ok.rows_affected, 3);

    let err = conn
        .execute_batch(&[
            "INSERT INTO authors (name) VALUES ('Y')".into(),
            "INSERT INTO authors (name) VALUES ('Ann')".into(), // UNIQUE
        ])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("statement 2 of 2 failed"), "{err}");
    let out = query(
        &conn,
        "SELECT count(*) FROM authors WHERE name = 'Y'",
        vec![],
    )
    .await;
    assert_eq!(text(&out.rows[0][0]), "0");

    // Nothing left holding the write lock: another connection can write.
    let other = rusqlite::Connection::open(Path::new(&path)).unwrap();
    other
        .execute("INSERT INTO authors (name) VALUES ('W')", [])
        .unwrap();
}

#[tokio::test]
async fn a_transaction_begun_in_the_editor_is_committed_by_a_later_run() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    query(&conn, "BEGIN", vec![]).await;
    query(&conn, "INSERT INTO authors (name) VALUES ('T')", vec![]).await;
    // Other runs in between (the grid, the tree) don't strand it either.
    conn.introspect().await.unwrap();
    query(&conn, "COMMIT", vec![]).await;

    let other = rusqlite::Connection::open(Path::new(&path)).unwrap();
    let n: i64 = other
        .query_row("SELECT count(*) FROM authors WHERE name = 'T'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn cancel_interrupts_a_running_query() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let (tx, mut rx) = mpsc::channel::<RowBatch>(16);
    let started = Instant::now();
    let h = conn
        .stream(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) \
             SELECT count(*) FROM n",
            vec![],
            tx,
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    conn.cancel(h).await.unwrap();
    let mut last = None;
    while let Some(b) = rx.recv().await {
        let done = b.done;
        last = Some(b);
        if done {
            break;
        }
    }
    let last = last.unwrap();
    assert_eq!(text(&last.rows[0][0]), "query cancelled");
    assert!(started.elapsed() < Duration::from_secs(5));

    // The pool is still usable, and cancelling a finished query is harmless.
    let out = query(&conn, "SELECT 1", vec![]).await;
    assert_eq!(text(&out.rows[0][0]), "1");
    let _ = conn.cancel(h).await;
}

#[tokio::test]
async fn untrusted_schema_and_foreign_keys_are_set_on_every_connection() {
    let (_dir, path) = fixture();
    let conn = connect(&path).await;
    let out = query(&conn, "PRAGMA trusted_schema; PRAGMA foreign_keys;", vec![]).await;
    assert_eq!(out.rows.len(), 2);
    assert_eq!(text(&out.rows[0][0]), "0");
    assert_eq!(text(&out.rows[1][0]), "1");
}
