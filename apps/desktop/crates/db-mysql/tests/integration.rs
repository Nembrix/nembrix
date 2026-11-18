//! Integration tests against real MySQL 8 and MariaDB 11 testcontainers.
//!
//! Every behaviour test runs on both servers. Skipped at runtime when Docker
//! isn't available (or DBCLIENT_SKIP_DOCKER=1); CI can set
//! DBCLIENT_REQUIRE_DOCKER=1 to enforce.

use db_core::{CellValue, ColMeta, DbConnection, RowBatch};
use db_mysql::{MySqlConfig, MySqlConn, MySqlSsl};
use std::sync::Arc;
use std::time::Duration;
use testcontainers::{runners::AsyncRunner, ContainerAsync, Image};
use testcontainers_modules::{mariadb::Mariadb, mysql::Mysql};
use tokio::sync::mpsc;

async fn docker_available() -> bool {
    if std::env::var("DBCLIENT_SKIP_DOCKER").is_ok() {
        return false;
    }
    tokio::process::Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

macro_rules! require_docker {
    () => {
        if !docker_available().await {
            if std::env::var("DBCLIENT_REQUIRE_DOCKER").is_ok() {
                panic!("Docker required (DBCLIENT_REQUIRE_DOCKER set) but not available");
            }
            eprintln!("skipping: docker not available");
            return Ok(());
        }
    };
}

struct Server<I: Image> {
    config: MySqlConfig,
    #[allow(dead_code)]
    container: ContainerAsync<I>,
}

async fn start<I: Image + Default>() -> anyhow::Result<Server<I>> {
    let container = I::default().start().await?;
    let config = MySqlConfig {
        host: container.get_host().await?.to_string(),
        port: container.get_host_port_ipv4(3306).await?,
        user: "root".into(),
        password: None,
        database: Some("test".into()),
        ssl_mode: MySqlSsl::Disable,
        connect_timeout_ms: Some(10_000),
    };
    Ok(Server { config, container })
}

/// Connect, retrying briefly: the ready log line can beat Docker Desktop's
/// port forward on macOS.
async fn connect(config: &MySqlConfig) -> anyhow::Result<Arc<MySqlConn>> {
    let mut attempt = 0;
    loop {
        match MySqlConn::connect(config.clone()).await {
            Ok(c) => return Ok(c),
            Err(e) if attempt < 40 => {
                let msg = e.to_string();
                if !(msg.contains("refused")
                    || msg.contains("reset")
                    || msg.contains("closed")
                    || msg.contains("timed out")
                    || msg.contains("broken pipe"))
                {
                    anyhow::bail!(msg);
                }
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(e) => anyhow::bail!(e.to_string()),
        }
    }
}

struct Out {
    columns: Vec<ColMeta>,
    rows: Vec<Vec<CellValue>>,
}

async fn query(conn: &MySqlConn, sql: &str, params: Vec<CellValue>) -> Out {
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    conn.stream(sql, params, tx).await.expect("stream");
    let mut out = Out {
        columns: Vec::new(),
        rows: Vec::new(),
    };
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
        CellValue::Text(s) | CellValue::Raw(s) => s.clone(),
        CellValue::Int(i) => i.to_string(),
        CellValue::Float(f) => f.to_string(),
        other => format!("{other:?}"),
    }
}

const SCHEMA: &str = "
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_email (email)
);
CREATE TABLE orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  total DECIMAL(10,2) DEFAULT 0.00,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
CREATE FUNCTION add_one(x INT) RETURNS INT DETERMINISTIC RETURN x + 1;
CREATE TABLE flags (f BIT(3));
INSERT INTO flags VALUES (b'101');
";

async fn behaviours(config: &MySqlConfig) -> anyhow::Result<()> {
    let conn = connect(config).await?;
    conn.ping().await?;

    // ── DDL + execute ──
    conn.execute(SCHEMA, vec![]).await?;
    let ins = conn
        .execute(
            "INSERT INTO users (email) VALUES ('a@x.io'), ('b@x.io')",
            vec![],
        )
        .await?;
    assert_eq!(ins.rows_affected, 2);
    assert_eq!(
        ins.last_insert_id,
        Some(1),
        "first id of a multi-row insert"
    );

    // ── introspection ──
    let tree = conn.introspect().await?;
    let sc = &tree.databases[0].schemas[0];
    assert_eq!(sc.name, "test", "the connection's database comes first");
    assert!(tree.databases[0]
        .schemas
        .iter()
        .all(|s| s.name != "mysql" && s.name != "sys"));
    let users = sc.tables.iter().find(|t| t.name == "users").unwrap();
    assert_eq!(users.primary_key, ["id"]);
    let email = users.columns.iter().find(|c| c.name == "email").unwrap();
    assert_eq!(email.type_name, "varchar(100)");
    assert!(!email.nullable);
    let uq = users.indexes.iter().find(|i| i.name == "uq_email").unwrap();
    assert!(uq.is_unique && !uq.is_primary);
    assert!(
        uq.definition.starts_with("UNIQUE INDEX `uq_email`"),
        "{}",
        uq.definition
    );
    let orders = sc.tables.iter().find(|t| t.name == "orders").unwrap();
    let fk = &orders.foreign_keys[0];
    assert_eq!(
        (fk.name.as_str(), fk.referenced_table.as_str()),
        ("fk_orders_user", "users")
    );
    assert_eq!(fk.columns, ["user_id"]);
    assert!(sc.views.iter().any(|v| v.name == "big_orders"));
    let f = sc.functions.iter().find(|f| f.name == "add_one").unwrap();
    // MySQL 8 reports `int`, MariaDB keeps the display width: `int(11)`.
    assert!(
        f.argument_types.len() == 1 && f.argument_types[0].starts_with("int"),
        "{:?}",
        f.argument_types
    );

    // ── value typing ──
    let r = query(
        &conn,
        "SELECT 42 AS i, CAST(18446744073709551615 AS UNSIGNED) AS big, \
                CAST(1.50 AS DECIMAL(5,2)) AS amount, 2.5e0 AS dbl, NULL AS n, \
                'héllo' AS s, JSON_OBJECT('a', 1) AS j, \
                DATE('2024-02-29') AS d, UNHEX('FF00') AS bin",
        vec![],
    )
    .await;
    let row = &r.rows[0];
    assert!(!r.columns.is_empty(), "query failed: {}", text(&row[0]));
    assert!(matches!(row[0], CellValue::Int(42)), "{:?}", row[0]);
    assert!(
        matches!(&row[1], CellValue::Raw(s) if s == "18446744073709551615"),
        "{:?}",
        row[1]
    );
    assert!(matches!(&row[2], CellValue::Raw(s) if s == "1.50"));
    assert!(matches!(row[3], CellValue::Float(f) if f == 2.5));
    assert!(matches!(row[4], CellValue::Null));
    assert_eq!(text(&row[5]), "héllo");
    // MariaDB's JSON is an alias for LONGTEXT, so it arrives as text there.
    match &row[6] {
        CellValue::Document(d) => assert_eq!(d["a"], 1),
        CellValue::Text(s) => assert!(s.contains("\"a\"")),
        other => panic!("json: {other:?}"),
    }
    assert_eq!(text(&row[7]), "2024-02-29");
    assert!(
        matches!(&row[8], CellValue::Bytes(b) if b == &vec![0xff, 0x00]),
        "{:?}",
        row[8]
    );
    // BIT(n) is sent as raw big-endian bits. (Read it from the column itself:
    // MariaDB re-encodes a BIT through a scalar subquery as decimal text while
    // still labelling it BIT, which no client can tell apart from real bits.)
    let bits = query(&conn, "SELECT f FROM flags", vec![]).await;
    assert_eq!(bits.columns[0].type_name, "bit");
    assert!(
        matches!(bits.rows[0][0], CellValue::Int(5)),
        "{:?}",
        bits.rows[0][0]
    );
    assert_eq!(r.columns[0].name, "i");

    // ── bound parameters (prepared statement) ──
    let r = query(
        &conn,
        "SELECT email FROM users WHERE id = ? AND email LIKE ?",
        vec![CellValue::Int(2), CellValue::Text("%x.io".into())],
    )
    .await;
    assert_eq!(text(&r.rows[0][0]), "b@x.io");
    // A value that would be injection if interpolated is just a string.
    let r = query(
        &conn,
        "SELECT ? AS v",
        vec![CellValue::Text("' OR 1=1 --".into())],
    )
    .await;
    assert_eq!(text(&r.rows[0][0]), "' OR 1=1 --");

    // ── multi-statement and DML-only runs ──
    let r = query(
        &conn,
        "UPDATE users SET email = email; SELECT COUNT(*) AS n FROM users",
        vec![],
    )
    .await;
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(text(&r.rows[0][0]), "2");
    let r = query(&conn, "DELETE FROM orders", vec![]).await;
    assert!(r.columns.is_empty() && r.rows.is_empty());

    // ── errors arrive in-band ──
    let r = query(&conn, "SELECT * FROM nope", vec![]).await;
    assert!(r.columns.is_empty());
    let msg = text(&r.rows[0][0]);
    assert!(msg.contains("nope"), "{msg}");
    // The server's message once, not wrapped and repeated.
    assert_eq!(msg.matches("ERROR 1146").count(), 1, "{msg}");

    // ── cancel is server-side ──
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    let started = std::time::Instant::now();
    let handle = conn.stream("SELECT SLEEP(30)", vec![], tx).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    conn.cancel(handle).await?;
    // KILL QUERY makes SLEEP return early (or the statement error out); either
    // way the stream finishes long before 30s.
    loop {
        let b = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await?;
        match b {
            Some(b) if !b.done => continue,
            _ => break,
        }
    }
    assert!(started.elapsed() < Duration::from_secs(10));
    // The pooled connection survives the KILL and is usable again.
    let r = query(&conn, "SELECT 1 AS one", vec![]).await;
    assert_eq!(text(&r.rows[0][0]), "1");
    // Cancelling a finished query is harmless.
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    let h = conn.stream("SELECT 1", vec![], tx).await?;
    while let Some(b) = rx.recv().await {
        if b.done {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = conn.cancel(h).await;
    let r = query(&conn, "SELECT 2 AS two", vec![]).await;
    assert_eq!(text(&r.rows[0][0]), "2");

    // ── execute_batch: one transaction on one connection ──
    conn.execute("CREATE TABLE tx (id INT PRIMARY KEY)", vec![])
        .await?;
    let ok = conn
        .execute_batch(&[
            "INSERT INTO tx VALUES (1)".into(),
            "INSERT INTO tx VALUES (2), (3)".into(),
        ])
        .await?;
    assert_eq!(ok.rows_affected, 3);
    let err = conn
        .execute_batch(&[
            "INSERT INTO tx VALUES (4)".into(),
            "INSERT INTO tx VALUES (1)".into(), // duplicate key
        ])
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("statement 2 of 2 failed"), "{err}");
    let r = query(&conn, "SELECT COUNT(*) FROM tx", vec![]).await;
    assert_eq!(text(&r.rows[0][0]), "3", "the failed batch applied nothing");
    let open_tx = query(
        &conn,
        "SELECT COUNT(*) FROM information_schema.INNODB_TRX",
        vec![],
    )
    .await;
    assert_eq!(text(&open_tx.rows[0][0]), "0", "no transaction left open");

    // ── connect errors the Tauri layer condenses (connections.rs) ──
    let bad = MySqlConn::connect(MySqlConfig {
        password: Some("wrong".into()),
        ..config.clone()
    })
    .await
    .err()
    .expect("wrong password must fail")
    .to_string();
    assert!(
        bad.to_lowercase().contains("access denied for user"),
        "{bad}"
    );
    let nodb = MySqlConn::connect(MySqlConfig {
        database: Some("nope".into()),
        ..config.clone()
    })
    .await
    .err()
    .expect("unknown database must fail")
    .to_string();
    assert!(nodb.to_lowercase().contains("unknown database"), "{nodb}");
    Ok(())
}

#[tokio::test]
async fn mysql_behaviours() -> anyhow::Result<()> {
    require_docker!();
    let s = start::<Mysql>().await?;
    behaviours(&s.config).await
}

#[tokio::test]
async fn mariadb_behaviours() -> anyhow::Result<()> {
    require_docker!();
    let s = start::<Mariadb>().await?;
    behaviours(&s.config).await
}

#[tokio::test]
async fn mysql_tls_ladder() -> anyhow::Result<()> {
    require_docker!();
    // MySQL 8 enables TLS with a self-signed certificate out of the box.
    let s = start::<Mysql>().await?;
    connect(&s.config).await?; // wait until up
    for mode in [MySqlSsl::Prefer, MySqlSsl::Require] {
        let c = MySqlConn::connect(MySqlConfig {
            ssl_mode: mode,
            ..s.config.clone()
        })
        .await?;
        let r = query(&c, "SHOW STATUS LIKE 'Ssl_cipher'", vec![]).await;
        assert!(!text(&r.rows[0][1]).is_empty(), "{mode:?} must encrypt");
    }
    let verify = MySqlConn::connect(MySqlConfig {
        ssl_mode: MySqlSsl::VerifyFull,
        ..s.config.clone()
    })
    .await;
    assert!(
        verify.is_err(),
        "a self-signed certificate must not pass verify-full"
    );
    Ok(())
}

#[tokio::test]
async fn mariadb_prefer_falls_back_when_the_server_has_no_tls() -> anyhow::Result<()> {
    require_docker!();
    let s = start::<Mariadb>().await?;
    connect(&s.config).await?; // wait until up
    let c = MySqlConn::connect(MySqlConfig {
        ssl_mode: MySqlSsl::Prefer,
        ..s.config.clone()
    })
    .await?;
    c.ping().await?;
    let require = MySqlConn::connect(MySqlConfig {
        ssl_mode: MySqlSsl::Require,
        ..s.config.clone()
    })
    .await;
    assert!(require.is_err(), "require must not silently downgrade");
    Ok(())
}
