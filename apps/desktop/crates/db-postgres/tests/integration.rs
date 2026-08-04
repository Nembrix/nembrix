//! Integration tests against a real Postgres in a testcontainer.

mod common;

use db_core::{DbConnection, RowBatch};
use db_postgres::object_ops;
use tokio::sync::mpsc;

#[tokio::test]
async fn introspect_lists_tables_and_columns() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE widgets (
            id serial PRIMARY KEY,
            name text NOT NULL,
            tags text[] DEFAULT '{}'
        );",
    )
    .execute(f.conn.pool())
    .await?;

    let tree = f.conn.introspect().await?;
    let db = &tree.databases[0];
    assert_eq!(db.name, "testdb");
    let public = db
        .schemas
        .iter()
        .find(|s| s.name == "public")
        .expect("public schema");
    let widgets = public
        .tables
        .iter()
        .find(|t| t.name == "widgets")
        .expect("widgets table");
    assert_eq!(widgets.primary_key, vec!["id"]);
    let cols: Vec<_> = widgets.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(cols.contains(&"id"));
    assert!(cols.contains(&"name"));
    assert!(cols.contains(&"tags"));
    Ok(())
}

#[tokio::test]
async fn introspect_returns_foreign_keys() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE u (id serial PRIMARY KEY, email text NOT NULL);
         CREATE TABLE o (
            id serial PRIMARY KEY,
            user_id integer REFERENCES u(id) ON DELETE CASCADE,
            total bigint
         );",
    )
    .execute(f.conn.pool())
    .await?;
    let tree = f.conn.introspect().await?;
    let public = &tree.databases[0]
        .schemas
        .iter()
        .find(|s| s.name == "public")
        .unwrap();
    let o = public.tables.iter().find(|t| t.name == "o").unwrap();
    assert_eq!(o.foreign_keys.len(), 1);
    let fk = &o.foreign_keys[0];
    assert_eq!(fk.columns, vec!["user_id"]);
    assert_eq!(fk.referenced_schema, "public");
    assert_eq!(fk.referenced_table, "u");
    assert_eq!(fk.referenced_columns, vec!["id"]);
    Ok(())
}

#[tokio::test]
async fn stream_emits_batches_and_finishes() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE k (v int);
         INSERT INTO k SELECT generate_series(1, 50);",
    )
    .execute(f.conn.pool())
    .await?;

    let (tx, mut rx) = mpsc::channel::<RowBatch>(16);
    let _h = f
        .conn
        .stream("SELECT v FROM k ORDER BY v", vec![], tx)
        .await?;
    let mut total = 0usize;
    let mut last_done = false;
    while let Some(batch) = rx.recv().await {
        total += batch.rows.len();
        if batch.done {
            last_done = true;
            break;
        }
    }
    assert!(last_done, "final batch should be marked done");
    assert_eq!(total, 50);
    Ok(())
}

#[tokio::test]
async fn stream_join_returns_orders_per_user() -> anyhow::Result<()> {
    // The set-based equivalent of a per-user "for each user, fetch their orders"
    // loop: a single JOIN streamed through the driver returns one row per
    // (user, order) pair. This is the form that works in the SQL-only editor —
    // there is no app-side loop or `pool` in that path.
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE u (id serial PRIMARY KEY, active boolean NOT NULL);
         CREATE TABLE o (id serial PRIMARY KEY, user_id integer REFERENCES u(id), total bigint);
         INSERT INTO u (active) VALUES (true), (true), (false);
         -- user 1: two orders, user 2: one order, user 3 (inactive): none
         INSERT INTO o (user_id, total) VALUES (1, 10), (1, 20), (2, 30);",
    )
    .execute(f.conn.pool())
    .await?;

    // INNER JOIN over active users: user 1 (2 orders) + user 2 (1 order) = 3 rows.
    // Inactive user 3 and any user with no orders are excluded, as with INNER JOIN.
    let (tx, mut rx) = mpsc::channel::<RowBatch>(16);
    let _h = f
        .conn
        .stream(
            "SELECT u.id AS user_id, o.total \
             FROM u JOIN o ON o.user_id = u.id \
             WHERE u.active = true \
             ORDER BY u.id, o.total",
            vec![],
            tx,
        )
        .await?;
    let mut total_rows = 0usize;
    let mut last_done = false;
    while let Some(batch) = rx.recv().await {
        total_rows += batch.rows.len();
        if batch.done {
            last_done = true;
            break;
        }
    }
    assert!(last_done, "final batch should be marked done");
    assert_eq!(
        total_rows, 3,
        "active users 1 and 2 have 3 orders between them; inactive user 3 is excluded"
    );
    Ok(())
}

#[tokio::test]
async fn stream_left_join_keeps_users_without_orders() -> anyhow::Result<()> {
    // Contrast with the INNER JOIN above: a LEFT JOIN keeps every active user,
    // even one with zero orders (its order columns come back NULL). This is the
    // form to use when "for each user" must include users that have no orders.
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE u (id serial PRIMARY KEY, active boolean NOT NULL);
         CREATE TABLE o (id serial PRIMARY KEY, user_id integer REFERENCES u(id), total bigint);
         INSERT INTO u (active) VALUES (true), (true);
         -- user 1 has one order, user 2 has none
         INSERT INTO o (user_id, total) VALUES (1, 10);",
    )
    .execute(f.conn.pool())
    .await?;

    let (tx, mut rx) = mpsc::channel::<RowBatch>(16);
    let _h = f
        .conn
        .stream(
            "SELECT u.id AS user_id, o.total \
             FROM u LEFT JOIN o ON o.user_id = u.id \
             WHERE u.active = true \
             ORDER BY u.id",
            vec![],
            tx,
        )
        .await?;
    let mut total_rows = 0usize;
    let mut last_done = false;
    while let Some(batch) = rx.recv().await {
        total_rows += batch.rows.len();
        if batch.done {
            last_done = true;
            break;
        }
    }
    assert!(last_done, "final batch should be marked done");
    assert_eq!(
        total_rows, 2,
        "LEFT JOIN keeps user 2 despite having no orders: 2 rows total"
    );
    Ok(())
}

#[tokio::test]
async fn cancel_stops_a_long_query() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    let (tx, mut rx) = mpsc::channel::<RowBatch>(4);
    let handle = f.conn.stream("SELECT pg_sleep(10)", vec![], tx).await?;
    // Give the server a moment to register the backend PID.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    f.conn.cancel(handle).await?;
    // Driver should surface an error row + done within a short window.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut saw_done = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
            Ok(Some(b)) if b.done => {
                saw_done = true;
                break;
            }
            Ok(Some(_)) => continue,
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(saw_done, "cancel should drive the stream to done within 3s");
    Ok(())
}

#[tokio::test]
async fn object_ops_duplicate_table_with_and_without_data() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE src (id int PRIMARY KEY, name text);
         INSERT INTO src VALUES (1, 'a'), (2, 'b');",
    )
    .execute(f.conn.pool())
    .await?;

    let with_data =
        object_ops::preview_duplicate_table("public", "src", "public", "dup_data", true)?;
    object_ops::apply(f.conn.pool(), &with_data, None).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM dup_data")
        .fetch_one(f.conn.pool())
        .await?;
    assert_eq!(n, 2);

    let schema_only =
        object_ops::preview_duplicate_table("public", "src", "public", "dup_schema", false)?;
    object_ops::apply(f.conn.pool(), &schema_only, None).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM dup_schema")
        .fetch_one(f.conn.pool())
        .await?;
    assert_eq!(n, 0);
    // LIKE … INCLUDING ALL copies the PK constraint — verify by trying to
    // insert a duplicate id.
    sqlx::query("INSERT INTO dup_schema VALUES (1, 'a')")
        .execute(f.conn.pool())
        .await?;
    let dup_pk = sqlx::query("INSERT INTO dup_schema VALUES (1, 'b')")
        .execute(f.conn.pool())
        .await;
    assert!(dup_pk.is_err(), "PK constraint should have been copied");
    Ok(())
}

#[tokio::test]
async fn object_ops_rename_table_round_trip() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query("CREATE TABLE old_name (v int);")
        .execute(f.conn.pool())
        .await?;
    let p = object_ops::preview_rename_table("public", "old_name", "new_name")?;
    object_ops::apply(f.conn.pool(), &p, None).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='new_name')",
    )
    .fetch_one(f.conn.pool())
    .await?;
    assert!(exists);
    Ok(())
}

#[tokio::test]
async fn object_ops_qi_quotes_and_rejects_invalid() {
    assert_eq!(object_ops::qi("users").unwrap(), "\"users\"");
    assert_eq!(object_ops::qi("a\"b").unwrap(), "\"a\"\"b\"");
    assert!(object_ops::qi("").is_err());
    assert!(object_ops::qi("a\0b").is_err());
}

// ---- JS scripting mode (P2): db.query against the real driver ----

use db_core::{CellValue, DynConn};
use db_script::{QueryResult, QueryRunner};
use std::sync::Arc;

/// Test-local mirror of the production `ScriptRunner` (which lives in the Tauri
/// crate). Drains a real `DbConnection::stream` into a `QueryResult` and maps
/// the driver's in-band error batch to `Err`.
struct PgScriptRunner {
    db: DynConn,
}

#[async_trait::async_trait]
impl QueryRunner for PgScriptRunner {
    async fn query(
        &self,
        sql: &str,
        _params: Vec<serde_json::Value>,
    ) -> Result<QueryResult, String> {
        let (tx, mut rx) = mpsc::channel::<RowBatch>(8);
        self.db
            .stream(sql, vec![], tx)
            .await
            .map_err(|e| e.to_string())?;
        let mut columns: Vec<String> = Vec::new();
        let mut got_columns = false;
        let mut rows = Vec::new();
        while let Some(batch) = rx.recv().await {
            if batch.done
                && !got_columns
                && batch.columns.is_none()
                && batch.rows.len() == 1
                && batch.rows[0].len() == 1
                && matches!(batch.rows[0][0], CellValue::Text(_))
            {
                if let CellValue::Text(msg) = &batch.rows[0][0] {
                    return Err(msg.clone());
                }
            }
            if let Some(cols) = batch.columns {
                columns = cols.into_iter().map(|c| c.name).collect();
                got_columns = true;
            }
            for row in batch.rows {
                let mut obj = serde_json::Map::new();
                for (i, cell) in row.into_iter().enumerate() {
                    let key = columns.get(i).cloned().unwrap_or_else(|| format!("col{i}"));
                    let v = match cell {
                        CellValue::Null => serde_json::Value::Null,
                        CellValue::Bool(b) => serde_json::Value::Bool(b),
                        CellValue::Int(n) => serde_json::Value::from(n),
                        CellValue::Text(s) | CellValue::Raw(s) => serde_json::Value::String(s),
                        CellValue::Document(d) => d,
                        CellValue::Float(f) => serde_json::json!(f),
                        CellValue::Bytes(_) => serde_json::Value::Null,
                    };
                    obj.insert(key, v);
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

#[tokio::test]
async fn script_loops_over_real_rows() -> anyhow::Result<()> {
    // The end-to-end proof: a JS script fetches users, then runs a per-user
    // query in a loop, all against a real Postgres connection through the same
    // streaming path the SQL editor uses.
    require_docker!();
    let f = common::start_pg().await?;
    sqlx::query(
        "CREATE TABLE u (id serial PRIMARY KEY, name text);
         CREATE TABLE o (id serial PRIMARY KEY, user_id integer, total bigint);
         INSERT INTO u (name) VALUES ('ann'), ('bob'), ('cy');
         INSERT INTO o (user_id, total) VALUES (1, 100), (1, 50), (2, 30);",
    )
    .execute(f.conn.pool())
    .await?;

    let runner: Arc<dyn QueryRunner> = Arc::new(PgScriptRunner { db: f.conn.clone() });

    // For each user, sum their orders via a per-row query, logging the total.
    let script = r#"
        const users = await db.query("SELECT id, name FROM u ORDER BY id");
        for (const user of users.rows) {
          const agg = await db.query(
            "SELECT COALESCE(SUM(total),0)::int8 AS s FROM o WHERE user_id = " + user.id);
          console.log(user.name + "=" + agg.rows[0].s);
        }
        return users;
    "#;

    let out = db_script::run(script, runner, db_script::Limits::default())
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // 1 users query + 3 per-user aggregates.
    assert_eq!(out.query_count, 4);
    // Grid data = the returned users result: 3 rows.
    let data = out.data.expect("grid data");
    assert_eq!(data.rows.len(), 3);
    assert_eq!(data.rows[0]["name"], serde_json::json!("ann"));
    // Logged per-user order sums: ann=150, bob=30, cy=0.
    let logs: Vec<&str> = out.logs.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(logs, vec!["ann=150", "bob=30", "cy=0"]);
    Ok(())
}

#[tokio::test]
async fn script_surfaces_real_query_error() -> anyhow::Result<()> {
    // A bad SQL statement inside the script becomes a catchable JS error
    // carrying the Postgres message.
    require_docker!();
    let f = common::start_pg().await?;
    let runner: Arc<dyn QueryRunner> = Arc::new(PgScriptRunner { db: f.conn.clone() });
    let script = r#"
        try {
          await db.query("SELECT * FROM does_not_exist");
          console.log("no error");
        } catch (e) {
          console.log("caught");
        }
    "#;
    let out = db_script::run(script, runner, db_script::Limits::default())
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    assert_eq!(out.logs[0].text, "caught");
    Ok(())
}

#[tokio::test]
async fn connect_succeeds_with_correct_password() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    let cfg = common::config_for(&f, Some("test"), db_postgres::PgSsl::Disable).await?;
    let err = db_postgres::PgConn::connect(cfg).await.err();
    assert!(err.is_none(), "correct creds should connect: {err:?}");
    Ok(())
}

#[tokio::test]
async fn connect_fails_with_wrong_password() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_pg().await?;
    let cfg = common::config_for(&f, Some("definitely-wrong"), db_postgres::PgSsl::Disable).await?;
    assert!(
        db_postgres::PgConn::connect(cfg).await.is_err(),
        "wrong password must fail"
    );
    Ok(())
}

#[tokio::test]
async fn connect_with_prefer_falls_back_when_server_has_no_tls() -> anyhow::Result<()> {
    require_docker!();
    // The testcontainer Postgres has TLS off. `prefer` must still connect by
    // falling back to plaintext — the exact ssl-mode behaviour users rely on
    // against non-TLS servers.
    let f = common::start_pg().await?;
    let cfg = common::config_for(&f, Some("test"), db_postgres::PgSsl::Prefer).await?;
    assert!(
        db_postgres::PgConn::connect(cfg).await.is_ok(),
        "prefer should fall back to plaintext on a no-TLS server"
    );
    Ok(())
}

#[tokio::test]
async fn parameterised_query_runs_end_to_end() -> anyhow::Result<()> {
    require_docker!();
    // Exercises the driver's stream() with bound params (unnamed prepared
    // statements — the pooler fix). Insert then count.
    let f = common::start_pg().await?;
    sqlx::query("CREATE TABLE t (id int, name text)")
        .execute(f.conn.pool())
        .await?;
    let (tx, mut rx) = mpsc::channel(8);
    f.conn
        .stream(
            "INSERT INTO t (id, name) VALUES ($1, $2)",
            vec![
                db_core::CellValue::Int(1),
                db_core::CellValue::Text("a".into()),
            ],
            tx,
        )
        .await?;
    while rx.recv().await.is_some() {}
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM t")
        .fetch_one(f.conn.pool())
        .await?;
    assert_eq!(n, 1);
    Ok(())
}
