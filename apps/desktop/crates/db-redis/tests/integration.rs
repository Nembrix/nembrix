//! Integration tests against a real Redis in a testcontainer.

mod common;

use db_core::{CellValue, ColMeta, DbConnection, RowBatch};
use db_redis::{RedisConfig, RedisConn};
use std::time::Duration;
use tokio::sync::mpsc;

struct Result_ {
    columns: Vec<ColMeta>,
    rows: Vec<Vec<CellValue>>,
}

async fn query(conn: &RedisConn, q: &str) -> Result_ {
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    conn.stream(q, vec![], tx).await.expect("stream");
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    while let Some(b) = rx.recv().await {
        if let Some(c) = b.columns {
            columns = c;
        }
        rows.extend(b.rows);
        if b.done {
            break;
        }
    }
    Result_ { columns, rows }
}

fn names(r: &Result_) -> Vec<&str> {
    r.columns.iter().map(|c| c.name.as_str()).collect()
}

fn text(c: &CellValue) -> String {
    match c {
        CellValue::Text(s) => s.clone(),
        CellValue::Int(i) => i.to_string(),
        CellValue::Float(f) => f.to_string(),
        other => format!("{other:?}"),
    }
}

const SEED: &str = "\
SET user:1 alice
HSET session:1 user alice ttl 60
RPUSH queue a b c
SADD tags red green
ZADD board 1.5 ann 3 bob
XADD events 1-0 temp 21";

#[tokio::test]
async fn ping_and_seed() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    fx.conn.ping().await?;
    let summary = fx.conn.execute(SEED, vec![]).await?;
    assert_eq!(summary.rows_affected, 6, "one per command");
    let del = fx.conn.execute("DEL user:1 nope", vec![]).await?;
    assert_eq!(
        del.rows_affected, 1,
        "a lone integer reply is reported as-is"
    );
    Ok(())
}

#[tokio::test]
async fn introspect_lists_keys_with_their_type() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    fx.conn.execute(SEED, vec![]).await?;
    let tree = fx.conn.introspect().await?;
    assert_eq!(tree.databases[0].name, "db0");
    let tables = &tree.databases[0].schemas[0].tables;
    let by_name: std::collections::HashMap<_, _> =
        tables.iter().map(|t| (t.name.as_str(), t)).collect();
    assert_eq!(tables.len(), 6);
    for (key, ty, cols) in [
        ("user:1", "string", vec!["value"]),
        ("session:1", "hash", vec!["field", "value"]),
        ("queue", "list", vec!["index", "value"]),
        ("tags", "set", vec!["member"]),
        ("board", "zset", vec!["member", "score"]),
        ("events", "stream", vec!["id", "fields"]),
    ] {
        let t = by_name[key];
        assert_eq!(t.columns[0].type_name, ty, "{key}");
        let got: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(got, cols, "{key}");
    }
    // Sorted for a stable tree.
    let order: Vec<_> = tables.iter().map(|t| t.name.as_str()).collect();
    let mut sorted = order.clone();
    sorted.sort();
    assert_eq!(order, sorted);
    Ok(())
}

#[tokio::test]
async fn browse_commands_produce_the_introspected_columns() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    fx.conn.execute(SEED, vec![]).await?;

    let r = query(&fx.conn, "GET user:1").await;
    assert_eq!(names(&r), ["value"]);
    assert_eq!(text(&r.rows[0][0]), "alice");

    let r = query(&fx.conn, "HSCAN session:1 0 COUNT 100").await;
    assert_eq!(names(&r), ["field", "value"]);
    assert_eq!(r.rows.len(), 2);

    let r = query(&fx.conn, "LRANGE queue 0 99").await;
    assert_eq!(names(&r), ["index", "value"]);
    assert_eq!(text(&r.rows[2][1]), "c");

    let r = query(&fx.conn, "SSCAN tags 0 COUNT 100").await;
    assert_eq!(names(&r), ["member"]);
    assert_eq!(r.rows.len(), 2);

    let r = query(&fx.conn, "ZRANGE board 0 99 WITHSCORES").await;
    assert_eq!(names(&r), ["member", "score"]);
    assert!(matches!(r.rows[0][1], CellValue::Float(f) if f == 1.5));

    let r = query(&fx.conn, "XRANGE events - + COUNT 100").await;
    assert_eq!(names(&r), ["id", "fields"]);
    assert_eq!(text(&r.rows[0][0]), "1-0");
    Ok(())
}

#[tokio::test]
async fn server_errors_arrive_in_band() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    fx.conn.execute("RPUSH queue a", vec![]).await?;
    let r = query(&fx.conn, "GET queue").await;
    assert!(r.columns.is_empty(), "error batch carries no columns");
    assert!(
        text(&r.rows[0][0]).contains("WRONGTYPE"),
        "{}",
        text(&r.rows[0][0])
    );
    Ok(())
}

#[tokio::test]
async fn several_commands_give_one_row_each_and_continue_past_errors() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    let r = query(&fx.conn, "SET a 1\nINCR a\nNOSUCHCMD\nGET a").await;
    assert_eq!(names(&r), ["#", "command", "result"]);
    assert_eq!(r.rows.len(), 4);
    assert_eq!(text(&r.rows[1][2]), "2");
    assert!(text(&r.rows[2][2]).starts_with("(error)"));
    assert_eq!(text(&r.rows[3][2]), "2");
    Ok(())
}

#[tokio::test]
async fn parse_errors_and_modal_commands_are_rejected_up_front() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    let (tx, _rx) = mpsc::channel::<RowBatch>(8);
    assert!(fx
        .conn
        .stream("SET k \"open", vec![], tx.clone())
        .await
        .is_err());
    assert!(fx.conn.stream("SUBSCRIBE news", vec![], tx).await.is_err());
    Ok(())
}

#[tokio::test]
async fn select_is_local_to_one_query() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    let r = query(&fx.conn, "SELECT 5\nSET only-in-5 x").await;
    assert_eq!(r.rows.len(), 2);
    // The connection's own database (0) is untouched.
    let tree = fx.conn.introspect().await?;
    assert!(tree.databases[0].schemas[0].tables.is_empty());
    Ok(())
}

#[tokio::test]
async fn blocking_command_neither_stalls_others_nor_survives_cancel() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(None).await?;
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    let handle = fx.conn.stream("BLPOP never 0", vec![], tx).await?;

    // The blocked query has its own connection: the shared one still answers.
    tokio::time::timeout(Duration::from_secs(2), fx.conn.ping())
        .await
        .expect("ping must not wait behind BLPOP")?;

    fx.conn.cancel(handle).await?;
    // The aborted task drops its sender: the stream ends without a batch.
    let next = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await?;
    assert!(next.is_none());
    Ok(())
}

#[tokio::test]
async fn password_auth_with_url_special_characters() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_redis(Some("p@ss:w/rd%")).await?;
    fx.conn.ping().await?;

    let wrong = RedisConn::connect(RedisConfig {
        password: Some("wrong".into()),
        ..fx.config.clone()
    })
    .await;
    let err = wrong
        .err()
        .expect("a wrong password must fail at connect")
        .to_string();
    // The Tauri layer's short "Authentication failed" message keys on this.
    assert!(
        err.to_lowercase().contains("authentication failed"),
        "{err}"
    );

    let missing = RedisConn::connect(RedisConfig {
        password: None,
        ..fx.config.clone()
    })
    .await;
    let err = missing
        .err()
        .expect("no password must fail at connect")
        .to_string();
    assert!(err.to_lowercase().contains("noauth"), "{err}");
    Ok(())
}
