//! Integration test: run `db.query` through the REAL Postgres driver, not the
//! in-memory fake. The fake runner returns instantly and never spawns Tokio
//! tasks, so it can't catch the executor-interaction bug where the script's
//! runtime doesn't drive the driver's `tokio::spawn`ed streaming — which hangs
//! a live `await db.query(...)` forever. Each test has a hard timeout so a
//! regression fails fast instead of blocking the suite.

use db_core::DbConnection;
use db_postgres::{PgConfig, PgConn, PgSsl};
use db_script::{run, Limits, QueryResult, QueryRunner};
use std::sync::Arc;
use std::time::Duration;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

/// Adapts a live `DbConnection` into the script's `QueryRunner`, mirroring the
/// real `ScriptRunner` in src-tauri: stream the query and materialize the rows.
struct LiveRunner {
    db: Arc<PgConn>,
}

#[async_trait::async_trait]
impl QueryRunner for LiveRunner {
    async fn query(
        &self,
        sql: &str,
        _params: Vec<serde_json::Value>,
    ) -> Result<QueryResult, String> {
        use db_core::{ColMeta, RowBatch};
        let (tx, mut rx) = tokio::sync::mpsc::channel::<RowBatch>(8);
        self.db
            .stream(sql, vec![], tx)
            .await
            .map_err(|e| e.to_string())?;
        let mut columns: Vec<String> = Vec::new();
        let mut rows = Vec::new();
        while let Some(batch) = rx.recv().await {
            if let Some(cols) = batch.columns {
                columns = cols.iter().map(|c: &ColMeta| c.name.clone()).collect();
            }
            for row in batch.rows {
                let mut obj = serde_json::Map::new();
                for (i, cell) in row.into_iter().enumerate() {
                    let key = columns.get(i).cloned().unwrap_or_else(|| format!("col{i}"));
                    obj.insert(key, serde_json::to_value(format!("{cell:?}")).unwrap());
                }
                rows.push(obj);
            }
            if batch.done {
                break;
            }
        }
        Ok(QueryResult { columns, rows })
    }
}

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

#[tokio::test]
async fn db_query_through_real_driver_does_not_hang() -> anyhow::Result<()> {
    if !docker_available().await {
        eprintln!("skipping: docker not available");
        return Ok(());
    }
    let container = Postgres::default()
        .with_db_name("testdb")
        .with_user("test")
        .with_password("test")
        .start()
        .await?;
    let host = container.get_host().await?.to_string();
    let port = container.get_host_port_ipv4(5432).await?;
    let db = PgConn::connect(PgConfig {
        host,
        port,
        user: "test".into(),
        password: Some("test".into()),
        database: Some("testdb".into()),
        ssl_mode: PgSsl::Disable,
        application_name: Some("script-real-driver-test".into()),
        statement_timeout_ms: None,
        connect_timeout_ms: None,
    })
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Seed a tiny table so `SELECT *` returns a real result set.
    db.execute(
        "CREATE TABLE test_table (id int); INSERT INTO test_table VALUES (1),(2);",
        vec![],
    )
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    let runner: Arc<dyn QueryRunner> = Arc::new(LiveRunner { db });

    // The exact script the user reported hanging.
    let script = r#"
        const result = await db.query('SELECT * FROM test_table;');
        console.log(result, 'dfpodpfo');
        return result;
    "#;

    // Hard timeout: if the executor bug is present, `run` never returns, so
    // this fails fast instead of hanging the whole suite.
    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        run(script, runner, Limits::default()),
    )
    .await
    .map_err(|_| anyhow::anyhow!("db.query hung: script did not finish within 20s"))?
    .map_err(|e| anyhow::anyhow!("script error: {e:?}"))?;

    // Two rows came back, and the console.log fired.
    let data = outcome.data.expect("script returned a result set");
    assert_eq!(
        data.rows.len(),
        2,
        "SELECT * FROM test_table should return 2 rows"
    );
    assert!(
        outcome.logs.iter().any(|l| l.text.contains("dfpodpfo")),
        "console.log output should be captured"
    );
    Ok(())
}
