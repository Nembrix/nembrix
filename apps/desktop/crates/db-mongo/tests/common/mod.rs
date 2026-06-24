//! Shared testcontainer fixture: spin up a standalone `mongo` container and
//! yield a configured `MongoConn`. Mirrors the db-postgres fixture so the two
//! suites read the same way.
//!
//! Skipped at runtime when Docker isn't available (or DBCLIENT_SKIP_DOCKER=1)
//! so `cargo test` passes on machines without Docker. CI sets
//! DBCLIENT_REQUIRE_DOCKER=1 to enforce.

use db_mongo::{MongoConfig, MongoConn};
use std::sync::Arc;
use testcontainers::{runners::AsyncRunner, ContainerAsync};
use testcontainers_modules::mongo::Mongo;

pub struct MongoFixture {
    pub conn: Arc<MongoConn>,
    #[allow(dead_code)]
    pub container: ContainerAsync<Mongo>,
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

pub async fn start_mongo() -> anyhow::Result<MongoFixture> {
    let container = Mongo::default().start().await?;
    let host = container.get_host().await?.to_string();
    let port = container.get_host_port_ipv4(27017).await?;
    let conn = MongoConn::connect(MongoConfig {
        host,
        port,
        // The standalone test container runs without auth.
        user: None,
        password: None,
        database: Some("testdb".into()),
        auth_source: None,
        tls: false,
        app_name: Some("nembrix-test".into()),
        connect_timeout_ms: Some(10_000),
    })
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(MongoFixture { conn, container })
}

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
