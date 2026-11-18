//! Multi-statement writes must run on ONE pooled connection.
//!
//! The pool hands out connections FIFO, so `execute("BEGIN")`, `execute(…)`,
//! `execute("COMMIT")` can each land on a different one — stranding the BEGIN
//! in an open transaction that later writes on that connection vanish into.
//! These tests pin the fix: `execute_batch`, and the single-string count.

mod common;

use db_core::{CellValue, DbConnection, RowBatch};
use std::sync::Arc;
use tokio::sync::mpsc;

async fn first_cell(conn: &dyn DbConnection, sql: &str) -> CellValue {
    let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
    conn.stream(sql, vec![], tx).await.unwrap();
    let mut out = CellValue::Null;
    while let Some(b) = rx.recv().await {
        if let Some(r) = b.rows.first() {
            out = r[0].clone();
        }
        if b.done {
            break;
        }
    }
    out
}

fn int(c: &CellValue) -> i64 {
    match c {
        CellValue::Int(i) => *i,
        other => panic!("expected an int, got {other:?}"),
    }
}

/// Fill the pool with several idle connections, the way the tree, the row
/// count and the grid do when they load in parallel.
async fn grow_pool(conn: &Arc<db_postgres::PgConn>) {
    let mut hs = vec![];
    for _ in 0..4 {
        let c = conn.clone();
        hs.push(tokio::spawn(async move {
            first_cell(&*c, "SELECT pg_sleep(0.2)").await
        }));
    }
    for h in hs {
        h.await.unwrap();
    }
}

async fn idle_in_transaction(conn: &dyn DbConnection) -> i64 {
    int(&first_cell(
        conn,
        "SELECT count(*) FROM pg_stat_activity \
         WHERE state LIKE 'idle in transaction%' AND datname = current_database()",
    )
    .await)
}

#[tokio::test]
async fn batch_commits_on_one_connection_and_strands_nothing() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_pg().await?;
    let conn = fx.conn.clone();
    conn.execute("CREATE TABLE t (id int)", vec![]).await?;
    grow_pool(&conn).await;

    let sum = conn
        .execute_batch(&[
            "INSERT INTO t VALUES (1)".into(),
            "INSERT INTO t VALUES (2), (3)".into(),
        ])
        .await?;
    assert_eq!(sum.rows_affected, 3);
    // Writes after the batch land wherever the pool sends them — and stick.
    for v in 4..=6 {
        conn.execute(&format!("INSERT INTO t VALUES ({v})"), vec![])
            .await?;
    }
    assert_eq!(int(&first_cell(&*conn, "SELECT count(*) FROM t").await), 6);
    assert_eq!(idle_in_transaction(&*conn).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_failing_statement_rolls_the_whole_batch_back() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_pg().await?;
    let conn = fx.conn.clone();
    conn.execute("CREATE TABLE t (id int PRIMARY KEY)", vec![])
        .await?;
    grow_pool(&conn).await;

    let err = conn
        .execute_batch(&[
            "INSERT INTO t VALUES (1)".into(),
            "INSERT INTO t VALUES (1)".into(), // duplicate key
            "INSERT INTO t VALUES (2)".into(),
        ])
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("statement 2 of 3 failed"), "{err}");
    assert!(err.contains("duplicate key"), "{err}");
    assert_eq!(int(&first_cell(&*conn, "SELECT count(*) FROM t").await), 0);
    // The connection went back to the pool clean: no aborted transaction.
    assert_eq!(idle_in_transaction(&*conn).await, 0);
    for _ in 0..8 {
        conn.execute("SELECT 1", vec![]).await?;
    }
    Ok(())
}

#[tokio::test]
async fn single_string_count_times_out_without_leaking_the_timeout() -> anyhow::Result<()> {
    require_docker!();
    let fx = common::start_pg().await?;
    let conn = fx.conn.clone();
    grow_pool(&conn).await;

    // The table-data exact count: SET LOCAL + the query, one string.
    let ok = first_cell(
        &*conn,
        "SET LOCAL statement_timeout = 2500; SELECT count(*) FROM pg_class",
    )
    .await;
    assert!(int(&ok) > 0);
    // The timeout really applies to the query in the same string…
    let slow = first_cell(
        &*conn,
        "SET LOCAL statement_timeout = 100; SELECT pg_sleep(2)",
    )
    .await;
    assert!(
        matches!(&slow, CellValue::Text(m) if m.contains("statement timeout")),
        "{slow:?}"
    );
    // …and ends with it: no open transaction, no timeout on later queries.
    assert_eq!(idle_in_transaction(&*conn).await, 0);
    for _ in 0..8 {
        let t = first_cell(&*conn, "SHOW statement_timeout").await;
        // "0" (no timeout) — the driver infers it as an integer cell.
        assert!(matches!(&t, CellValue::Int(0)), "{t:?}");
    }
    Ok(())
}
