//! Shared testcontainer fixture: spin up a standalone `redis` container and
//! yield a configured `RedisConn`. Mirrors the db-mongo fixture.
//!
//! Skipped at runtime when Docker isn't available (or DBCLIENT_SKIP_DOCKER=1)
//! so `cargo test` passes on machines without Docker. CI sets
//! DBCLIENT_REQUIRE_DOCKER=1 to enforce.

use db_redis::{RedisConfig, RedisConn};
use std::sync::Arc;
use testcontainers::{runners::AsyncRunner, ContainerAsync, ImageExt};
use testcontainers_modules::redis::{Redis, REDIS_PORT};

pub struct RedisFixture {
    pub conn: Arc<RedisConn>,
    pub config: RedisConfig,
    #[allow(dead_code)]
    pub container: ContainerAsync<Redis>,
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

/// Start Redis; with `password`, the server requires it (`--requirepass`).
pub async fn start_redis(password: Option<&str>) -> anyhow::Result<RedisFixture> {
    let image = match password {
        Some(pw) => Redis::default().with_cmd(["redis-server", "--requirepass", pw]),
        None => Redis::default().with_cmd(["redis-server"]),
    };
    let container = image.start().await?;
    let config = RedisConfig {
        host: container.get_host().await?.to_string(),
        port: container.get_host_port_ipv4(REDIS_PORT).await?,
        user: None,
        password: password.map(str::to_string),
        db: 0,
        tls: false,
        connect_timeout_ms: Some(10_000),
    };
    // The container logs "ready" before Docker Desktop's port forward accepts
    // connections, so a first connect can be refused. Retry briefly.
    let mut attempt = 0;
    let conn = loop {
        match RedisConn::connect(config.clone()).await {
            Ok(c) => break c,
            Err(e) if attempt < 20 && e.to_string().contains("refused") => {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            Err(e) => return Err(anyhow::anyhow!("{e}")),
        }
    };
    Ok(RedisFixture {
        conn,
        config,
        container,
    })
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
