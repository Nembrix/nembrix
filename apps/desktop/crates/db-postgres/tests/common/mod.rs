//! Shared testcontainer fixture: spin up postgres:16-alpine and yield a
//! configured PgConn. Each test gets its own container; teardown is
//! automatic on `Drop`.
//!
//! Skipped at runtime when DOCKER isn't available (or DBCLIENT_SKIP_DOCKER=1)
//! so `cargo test` works on machines without Docker — they simply pass.

use db_postgres::{PgConfig, PgConn, PgSsl};
use std::sync::Arc;
use testcontainers::{runners::AsyncRunner, ContainerAsync};
use testcontainers_modules::postgres::Postgres;

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
    })
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(PgFixture { conn, container })
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
