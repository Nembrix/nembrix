//! Shared testcontainer fixture: spin up postgres:16-alpine and yield a
//! configured PgConn. Each test gets its own container; teardown is
//! automatic on `Drop`.
//!
//! Skipped at runtime when DOCKER isn't available (or DBCLIENT_SKIP_DOCKER=1)
//! so `cargo test` works on machines without Docker — they simply pass.

use db_core::DbConnection;
use db_postgres::{PgConfig, PgConn, PgSsl};
use std::sync::Arc;
use testcontainers::{runners::AsyncRunner, ContainerAsync};
use testcontainers_modules::postgres::Postgres;
use tokio_postgres::SimpleQueryMessage;

pub struct PgFixture {
    pub conn: Arc<PgConn>,
    #[allow(dead_code)]
    pub container: ContainerAsync<Postgres>,
}

pub async fn docker_available() -> bool {
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

pub async fn start_pg() -> anyhow::Result<PgFixture> {
    let container = Postgres::default()
        .with_db_name("testdb")
        .with_user("test")
        .with_password("test")
        .start()
        .await?;
    let host = container.get_host().await?.to_string();
    let port = container.get_host_port_ipv4(5432).await?;
    let conn = PgConn::connect(PgConfig {
        host,
        port,
        user: "test".into(),
        password: Some("test".into()),
        database: Some("testdb".into()),
        ssl_mode: PgSsl::Disable,
        application_name: Some("nembrix-test".into()),
        statement_timeout_ms: None,
        connect_timeout_ms: None,
    })
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(PgFixture { conn, container })
}

/// Build a `PgConfig` pointed at a running fixture's container, letting a
/// test override the password / ssl mode to exercise connection validation.
/// The seeded container uses user/db/password = test/testdb/test.
#[allow(dead_code)]
pub async fn config_for(
    fixture: &PgFixture,
    password: Option<&str>,
    ssl_mode: PgSsl,
) -> anyhow::Result<PgConfig> {
    let host = fixture.container.get_host().await?.to_string();
    let port = fixture.container.get_host_port_ipv4(5432).await?;
    Ok(PgConfig {
        host,
        port,
        user: "test".into(),
        password: password.map(|p| p.to_string()),
        database: Some("testdb".into()),
        ssl_mode,
        application_name: Some("nembrix-test".into()),
        statement_timeout_ms: None,
        connect_timeout_ms: None,
    })
}

/// Run setup DDL/DML against the fixture. Goes through the driver's own
/// `execute` (simple protocol) so tests don't need sqlx. Multi-statement
/// batches are fine.
#[allow(dead_code)]
pub async fn exec(f: &PgFixture, sql: &str) -> anyhow::Result<()> {
    f.conn
        .execute(sql, vec![])
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

/// Read a single scalar cell (row 0, col 0) from `sql` as text, via the pool's
/// simple-query path. Returns None when the query yields no rows.
#[allow(dead_code)]
pub async fn scalar(f: &PgFixture, sql: &str) -> anyhow::Result<Option<String>> {
    let client = f.conn.pool().get().await?;
    let msgs = client.simple_query(sql).await?;
    for m in msgs {
        if let SimpleQueryMessage::Row(r) = m {
            return Ok(r.get(0).map(|s| s.to_string()));
        }
    }
    Ok(None)
}

/// Convenience: read a scalar and parse it as i64.
#[allow(dead_code)]
pub async fn scalar_i64(f: &PgFixture, sql: &str) -> anyhow::Result<i64> {
    let s = scalar(f, sql).await?.unwrap_or_default();
    Ok(s.parse::<i64>()?)
}

/// Run a statement and return whether it errored (for negative assertions like
/// "the duplicate PK insert should fail").
#[allow(dead_code)]
pub async fn try_exec(f: &PgFixture, sql: &str) -> bool {
    f.conn.execute(sql, vec![]).await.is_err()
}

/// Skip a test when Docker isn't available. Tests stay green on dev
/// machines without Docker; CI sets DBCLIENT_REQUIRE_DOCKER=1 to enforce.
#[macro_export]
macro_rules! require_docker {
    () => {
        if !$crate::common::docker_available().await {
            if std::env::var("DBCLIENT_REQUIRE_DOCKER").is_ok() {
                panic!("Docker required (DBCLIENT_REQUIRE_DOCKER set) but not available");
            }
            eprintln!("skipping: docker not available");
            return Ok(());
        }
    };
}
