//! Integration test: run a JS script's `db.query(...)` against the REAL Mongo
//! driver, where the argument is a mongo-shell command string
//! (`db.coll.find({…})`) rather than SQL. Proves the scripting seam works for
//! MongoDB — the driver's `stream()` parses the shell command and streams rows,
//! same as the SQL path. Hard timeout so a regression fails fast.

use db_core::DbConnection;
use db_mongo::{MongoConfig, MongoConn};
use db_script::{run, Limits, QueryResult, QueryRunner};
use std::sync::Arc;
use std::time::Duration;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::mongo::Mongo;

/// Adapts a live Mongo `DbConnection` into the script's `QueryRunner`, mirroring
/// the real `ScriptRunner`: stream the (mongo-shell) query and materialize rows.
struct LiveRunner {
    db: Arc<MongoConn>,
}

#[async_trait::async_trait]
impl QueryRunner for LiveRunner {
    async fn query(
        &self,
        query: &str,
        _params: Vec<serde_json::Value>,
    ) -> Result<QueryResult, String> {
        use db_core::{ColMeta, RowBatch};
        let (tx, mut rx) = tokio::sync::mpsc::channel::<RowBatch>(8);
        self.db
            .stream(query, vec![], tx)
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
async fn mongo_db_query_runs_a_shell_command_in_a_script() -> anyhow::Result<()> {
    if !docker_available().await {
        eprintln!("skipping: docker not available");
        return Ok(());
    }
    let container = Mongo::default().start().await?;
    let host = container.get_host().await?.to_string();
    let port = container.get_host_port_ipv4(27017).await?;
    let db = MongoConn::connect(MongoConfig {
        host,
        port,
        user: None,
        password: None,
        database: Some("testdb".into()),
        auth_source: None,
        tls: false,
        app_name: Some("mongo-script-test".into()),
        connect_timeout_ms: Some(10_000),
    })
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Seed two docs so find() returns a real result set.
    db.execute(
        r#"db.users.insertMany([{name:"a",active:true},{name:"b",active:false}])"#,
        vec![],
    )
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    let runner: Arc<dyn QueryRunner> = Arc::new(LiveRunner { db });

    // A script that queries Mongo via a shell command, loops the array result,
    // and returns it — the exact db.query(shellString) seam.
    let script = r#"
        const users = await db.query('db.users.find({active: true})');
        for (const u of users) { console.log("active:", u.name); }
        return users;
    "#;

    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        run(script, runner, Limits::default()),
    )
    .await
    .map_err(|_| anyhow::anyhow!("mongo db.query hung: script did not finish within 20s"))?
    .map_err(|e| anyhow::anyhow!("script error: {e:?}"))?;

    // One active user came back and got iterated + logged.
    let data = outcome.data.expect("script returned a result set");
    assert_eq!(data.rows.len(), 1, "only one active user");
    assert!(
        outcome.logs.iter().any(|l| l.text.contains("active:")),
        "console.log should fire over the array result: {:?}",
        outcome.logs
    );
    Ok(())
}
