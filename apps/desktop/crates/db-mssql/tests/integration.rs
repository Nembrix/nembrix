//! Integration tests against a real SQL Server 2022 testcontainer.
//!
//! Skipped at runtime when Docker isn't available (or DBCLIENT_SKIP_DOCKER=1);
//! CI can set DBCLIENT_REQUIRE_DOCKER=1 to enforce. The image is amd64-only:
//! on Apple Silicon it runs under Docker Desktop's Rosetta emulation.

use db_core::{CellValue, ColMeta, DbConnection, RowBatch};
use db_mssql::{MssqlConfig, MssqlConn, MssqlSsl};
use std::sync::Arc;
use std::time::Duration;
use testcontainers::{runners::AsyncRunner, ContainerAsync};
use testcontainers_modules::mssql_server::MssqlServer;
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

struct Server {
    config: MssqlConfig,
    #[allow(dead_code)]
    container: ContainerAsync<MssqlServer>,
}

async fn start() -> anyhow::Result<Server> {
    let container = MssqlServer::default().with_accept_eula().start().await?;
    let config = MssqlConfig {
        host: container.get_host().await?.to_string(),
        port: container.get_host_port_ipv4(1433).await?,
        user: "sa".into(),
        password: Some(MssqlServer::DEFAULT_SA_PASSWORD.into()),
        database: None,
        ssl_mode: MssqlSsl::Disable,
        connect_timeout_ms: Some(10_000),
    };
    Ok(Server { config, container })
}

/// Connect, retrying briefly: the ready log line can beat Docker Desktop's
/// port forward on macOS, and the login can fail while recovery finishes.
async fn connect(config: &MssqlConfig) -> anyhow::Result<Arc<MssqlConn>> {
    let mut attempt = 0;
    loop {
        match MssqlConn::connect(config.clone()).await {
            Ok(c) => return Ok(c),
            Err(e) if attempt < 80 => {
                let msg = e.to_string().to_lowercase();
                if !(msg.contains("refused")
                    || msg.contains("reset")
                    || msg.contains("closed")
                    || msg.contains("timed out")
                    || msg.contains("broken pipe")
                    || msg.contains("eof")
                    || msg.contains("login failed"))
                {
                    anyhow::bail!(msg);
                }
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) => anyhow::bail!(e.to_string()),
        }
    }
}

struct Out {
    columns: Vec<ColMeta>,
    rows: Vec<Vec<CellValue>>,
}

async fn query(conn: &MssqlConn, sql: &str, params: Vec<CellValue>) -> Out {
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

/// A test database, then a connection that opens in it.
async fn test_db(config: &MssqlConfig) -> anyhow::Result<(MssqlConfig, Arc<MssqlConn>)> {
    let admin = connect(config).await?;
    admin
        .execute("IF DB_ID('test') IS NULL CREATE DATABASE test", vec![])
        .await?;
    let cfg = MssqlConfig {
        database: Some("test".into()),
        ..config.clone()
    };
    let conn = connect(&cfg).await?;
    Ok((cfg, conn))
}

// CREATE VIEW / FUNCTION must each start their own batch.
const SCHEMA: &[&str] = &[
    "CREATE TABLE users (
       id INT IDENTITY PRIMARY KEY,
       email NVARCHAR(100) NOT NULL,
       CONSTRAINT uq_email UNIQUE (email)
     );
     CREATE TABLE orders (
       id BIGINT IDENTITY PRIMARY KEY,
       user_id INT NOT NULL,
       total DECIMAL(10,2) DEFAULT 0.00,
       CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
     );",
    "CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100",
    "CREATE FUNCTION add_one(@x INT) RETURNS INT AS BEGIN RETURN @x + 1 END",
];

#[tokio::test]
async fn mssql_behaviours() -> anyhow::Result<()> {
    require_docker!();
    let s = start().await?;
    let (cfg, conn) = test_db(&s.config).await?;
    conn.ping().await?;

    // ── DDL + execute ──
    for stmt in SCHEMA {
        conn.execute(stmt, vec![]).await?;
    }
    let ins = conn
        .execute(
            "INSERT INTO users (email) VALUES (N'a@x.io'), (N'b@x.io')",
            vec![],
        )
        .await?;
    assert_eq!(ins.rows_affected, 2);

    // ── introspection ──
    let tree = conn.introspect().await?;
    assert_eq!(tree.databases[0].name, "test");
    let sc = &tree.databases[0].schemas[0];
    assert_eq!(sc.name, "dbo", "the user's default schema comes first");
    assert!(tree.databases[0]
        .schemas
        .iter()
        .all(|s| s.name != "sys" && s.name != "db_owner"));
    let users = sc.tables.iter().find(|t| t.name == "users").unwrap();
    assert_eq!(users.primary_key, ["id"]);
    let id = users.columns.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(id.default.as_deref(), Some("IDENTITY"));
    let email = users.columns.iter().find(|c| c.name == "email").unwrap();
    assert_eq!(email.type_name, "nvarchar(100)");
    assert!(!email.nullable);
    let uq = users.indexes.iter().find(|i| i.name == "uq_email").unwrap();
    assert!(uq.is_unique && !uq.is_primary);
    assert_eq!(uq.columns, ["email"]);
    assert_eq!(
        uq.definition,
        "UNIQUE NONCLUSTERED INDEX [uq_email] ON [dbo].[users] ([email])"
    );
    let orders = sc.tables.iter().find(|t| t.name == "orders").unwrap();
    let total = orders.columns.iter().find(|c| c.name == "total").unwrap();
    assert_eq!(total.type_name, "decimal(10,2)");
    assert_eq!(total.default.as_deref(), Some("((0.00))"));
    let fk = &orders.foreign_keys[0];
    assert_eq!(
        (fk.name.as_str(), fk.referenced_table.as_str()),
        ("fk_orders_user", "users")
    );
    assert_eq!(fk.columns, ["user_id"]);
    assert_eq!(fk.referenced_columns, ["id"]);
    assert!(sc.views.iter().any(|v| v.name == "big_orders"));
    let f = sc.functions.iter().find(|f| f.name == "add_one").unwrap();
    assert_eq!(f.argument_types, ["int"]);
    assert_eq!(f.return_type, "int");

    // ── value typing ──
    let r = query(
        &conn,
        "SELECT 42 AS i, CAST(9223372036854775807 AS BIGINT) AS big, \
                CAST(1.50 AS DECIMAL(5,2)) AS amount, CAST(2.5 AS FLOAT) AS dbl, NULL AS n, \
                N'héllo' AS s, CAST('2024-02-29' AS DATE) AS d, 0xFF00 AS bin, \
                CAST(1 AS BIT) AS b, CAST('2024-02-29 13:45:10.123' AS DATETIME2(3)) AS dt, \
                CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS UNIQUEIDENTIFIER) AS g",
        vec![],
    )
    .await;
    let row = &r.rows[0];
    assert!(!r.columns.is_empty(), "query failed: {}", text(&row[0]));
    assert_eq!(r.columns[0].name, "i");
    assert!(matches!(row[0], CellValue::Int(42)), "{:?}", row[0]);
    assert!(
        matches!(&row[1], CellValue::Raw(s) if s == "9223372036854775807"),
        "{:?}",
        row[1]
    );
    assert!(
        matches!(&row[2], CellValue::Raw(s) if s == "1.50"),
        "{:?}",
        row[2]
    );
    assert!(matches!(row[3], CellValue::Float(f) if f == 2.5));
    assert!(matches!(row[4], CellValue::Null));
    assert_eq!(text(&row[5]), "héllo");
    assert_eq!(text(&row[6]), "2024-02-29");
    assert!(
        matches!(&row[7], CellValue::Bytes(b) if b == &vec![0xff, 0x00]),
        "{:?}",
        row[7]
    );
    assert!(matches!(row[8], CellValue::Bool(true)));
    assert_eq!(r.columns[8].type_name, "bit");
    assert_eq!(text(&row[9]), "2024-02-29 13:45:10.123");
    assert_eq!(text(&row[10]), "6F9619FF-8B86-D011-B42D-00C04FC964FF");

    // ── bound parameters (sp_executesql) ──
    let r = query(
        &conn,
        "SELECT email FROM users WHERE id = @P1 AND email LIKE @P2",
        vec![CellValue::Int(2), CellValue::Text("%x.io".into())],
    )
    .await;
    assert_eq!(text(&r.rows[0][0]), "b@x.io");
    // A value that would be injection if interpolated is just a string.
    let r = query(
        &conn,
        "SELECT @P1 AS v",
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
    assert_eq!(msg, "Invalid object name 'nope'. (error 208)");

    // ── a transaction opened in the editor continues on the next query ──
    query(
        &conn,
        "BEGIN TRANSACTION; INSERT INTO users (email) VALUES (N't@x.io')",
        vec![],
    )
    .await;
    let r = query(&conn, "SELECT COUNT(*) FROM users", vec![]).await;
    assert_eq!(text(&r.rows[0][0]), "3", "same connection sees its insert");
    let r = query(&conn, "ROLLBACK", vec![]).await;
    assert!(
        r.rows.is_empty(),
        "ROLLBACK found its transaction: {:?}",
        r.rows
    );
    let r = query(&conn, "SELECT COUNT(*) FROM users", vec![]).await;
    assert_eq!(text(&r.rows[0][0]), "2");

    // ── cancel ──
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    let started = std::time::Instant::now();
    let handle = conn
        .stream("WAITFOR DELAY '00:00:30'; SELECT 1", vec![], tx)
        .await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    conn.cancel(handle).await?;
    let last = loop {
        let b = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await?;
        match b {
            Some(b) if !b.done => continue,
            other => break other,
        }
    };
    assert!(started.elapsed() < Duration::from_secs(15));
    let last = last.expect("a final batch");
    assert_eq!(text(&last.rows[0][0]), "query cancelled");
    // The connection survives the attention and is usable again.
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
    assert!(err.contains("PRIMARY KEY"), "{err}");
    let r = query(&conn, "SELECT COUNT(*) FROM tx", vec![]).await;
    assert_eq!(text(&r.rows[0][0]), "3", "the failed batch applied nothing");
    // DDL is transactional too.
    conn.execute_batch(&["CREATE TABLE ddl_tx (id INT)".into(), "SELECT 1/0".into()])
        .await
        .unwrap_err();
    let r = query(&conn, "SELECT OBJECT_ID('ddl_tx')", vec![]).await;
    assert!(
        matches!(r.rows[0][0], CellValue::Null),
        "{:?}",
        r.rows[0][0]
    );

    // ── connect errors the Tauri layer condenses (connections.rs) ──
    let bad = MssqlConn::connect(MssqlConfig {
        password: Some("wrong".into()),
        ..cfg.clone()
    })
    .await
    .err()
    .expect("wrong password must fail")
    .to_string();
    assert!(
        bad.to_lowercase().contains("login failed for user"),
        "{bad}"
    );
    let nodb = MssqlConn::connect(MssqlConfig {
        database: Some("nope".into()),
        ..cfg.clone()
    })
    .await
    .err()
    .expect("unknown database must fail")
    .to_string();
    assert!(
        nodb.to_lowercase().contains("cannot open database"),
        "{nodb}"
    );

    // ── the TLS ladder ──
    // SQL Server encrypts with a self-signed certificate out of the box.
    let encrypted = "SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID";
    for (mode, want) in [
        (MssqlSsl::Disable, "FALSE"),
        (MssqlSsl::Prefer, "TRUE"),
        (MssqlSsl::Require, "TRUE"),
    ] {
        let c = MssqlConn::connect(MssqlConfig {
            ssl_mode: mode,
            ..cfg.clone()
        })
        .await?;
        let r = query(&c, encrypted, vec![]).await;
        assert_eq!(text(&r.rows[0][0]), want, "{mode:?}");
    }
    let verify = MssqlConn::connect(MssqlConfig {
        ssl_mode: MssqlSsl::VerifyFull,
        ..cfg.clone()
    })
    .await;
    assert!(
        verify.is_err(),
        "a self-signed certificate must not pass verify-full"
    );
    Ok(())
}
