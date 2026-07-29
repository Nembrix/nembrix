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
