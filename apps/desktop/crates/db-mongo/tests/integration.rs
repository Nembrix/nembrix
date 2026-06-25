//! Integration tests against a real MongoDB in a testcontainer, plus
//! pure-parser tests that run everywhere (no Docker needed).

mod common;

use db_core::{CellValue, DbConnection, RowBatch};
use db_mongo::parse::{self, Command};
use mongodb::bson::doc;
use tokio::sync::mpsc;

// ───────────────────────── parser (no docker) ─────────────────────────

#[test]
fn parse_find_with_modifiers() {
    let cmd =
        parse::parse("db.users.find({ age: { $gt: 21 } }).sort({ name: 1 }).limit(50).skip(10)")
            .expect("parse");
    match cmd {
        Command::Find { collection, opts } => {
            assert_eq!(collection, "users");
            assert_eq!(opts.filter, doc! { "age": { "$gt": 21 } });
            assert_eq!(opts.sort, Some(doc! { "name": 1 }));
            assert_eq!(opts.limit, Some(50));
            assert_eq!(opts.skip, Some(10));
        }
        other => panic!("expected Find, got {other:?}"),
    }
}

#[test]
fn parse_find_empty_filter() {
    let cmd = parse::parse("db.users.find()").expect("parse");
    match cmd {
        Command::Find { collection, opts } => {
            assert_eq!(collection, "users");
            assert!(opts.filter.is_empty());
        }
        other => panic!("expected Find, got {other:?}"),
    }
}

#[test]
fn parse_aggregate_pipeline() {
    let cmd = parse::parse(
        "db.orders.aggregate([{ $match: { paid: true } }, { $group: { _id: \"$uid\", n: { $sum: 1 } } }])",
    )
    .expect("parse");
    match cmd {
        Command::Aggregate {
            collection,
            pipeline,
        } => {
            assert_eq!(collection, "orders");
            assert_eq!(pipeline.len(), 2);
            assert_eq!(pipeline[0], doc! { "$match": { "paid": true } });
        }
        other => panic!("expected Aggregate, got {other:?}"),
    }
}

#[test]
fn parse_update_many_with_upsert() {
    let cmd = parse::parse(
        "db.users.updateMany({ active: false }, { $set: { archived: true } }, { upsert: true })",
    )
    .expect("parse");
    match cmd {
        Command::UpdateMany {
            collection,
            filter,
            update,
            upsert,
        } => {
            assert_eq!(collection, "users");
            assert_eq!(filter, doc! { "active": false });
            assert_eq!(update, doc! { "$set": { "archived": true } });
            assert!(upsert);
        }
        other => panic!("expected UpdateMany, got {other:?}"),
    }
}

#[test]
fn parse_single_quotes_and_trailing_commas() {
    let cmd = parse::parse("db.users.find({ name: 'ada', },)").expect("parse");
    match cmd {
        Command::Find { opts, .. } => assert_eq!(opts.filter, doc! { "name": "ada" }),
        other => panic!("expected Find, got {other:?}"),
    }
}

#[test]
fn parse_strips_comments() {
    let cmd = parse::parse("// find active users\ndb.users.find({ active: true }) /* inline */")
        .expect("parse");
    assert!(matches!(cmd, Command::Find { .. }));
}

#[test]
fn parse_distinct() {
    let cmd = parse::parse("db.users.distinct(\"country\", { active: true })").expect("parse");
    match cmd {
        Command::Distinct {
            collection,
            field,
            filter,
        } => {
            assert_eq!(collection, "users");
            assert_eq!(field, "country");
            assert_eq!(filter, doc! { "active": true });
        }
        other => panic!("expected Distinct, got {other:?}"),
    }
}

#[test]
fn parse_db_helpers() {
    assert!(matches!(
        parse::parse("db.getCollectionNames()").unwrap(),
        Command::GetCollectionNames
    ));
    assert!(matches!(
        parse::parse("db.runCommand({ ping: 1 })").unwrap(),
        Command::RunCommand { .. }
    ));
}

#[test]
fn parse_rejects_unknown_method() {
    let err = parse::parse("db.users.frobnicate({})").unwrap_err();
    assert!(err.to_string().contains("frobnicate"), "got: {err}");
}

#[test]
fn parse_rejects_non_db_call() {
    assert!(parse::parse("SELECT 1").is_err());
    assert!(parse::parse("db").is_err());
    assert!(parse::parse("db.users").is_err());
}

#[test]
fn read_vs_write_classification() {
    assert!(parse::parse("db.u.find({})").unwrap().is_read());
    assert!(parse::parse("db.u.countDocuments({})").unwrap().is_read());
    assert!(!parse::parse("db.u.insertOne({a:1})").unwrap().is_read());
    assert!(!parse::parse("db.u.deleteMany({})").unwrap().is_read());
}

// ───────────────────────── driver (docker) ─────────────────────────

/// Drain a stream channel into (rows, saw_done).
async fn drain(mut rx: mpsc::Receiver<RowBatch>) -> (Vec<Vec<CellValue>>, bool) {
    let mut rows = Vec::new();
    let mut done = false;
    while let Some(b) = rx.recv().await {
        rows.extend(b.rows);
        if b.done {
            done = true;
            break;
        }
    }
    (rows, done)
}

#[tokio::test]
async fn ping_works() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_mongo().await?;
    f.conn.ping().await.map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

#[tokio::test]
async fn insert_then_find_streams_documents() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_mongo().await?;

    f.conn
        .execute(
            r#"db.people.insertMany([{ name: "ada", age: 36 }, { name: "alan", age: 41 }])"#,
            vec![],
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let (tx, rx) = mpsc::channel::<RowBatch>(16);
    f.conn
        .stream("db.people.find({}).sort({ age: 1 })", vec![], tx)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let (rows, done) = drain(rx).await;
    assert!(done, "stream should finish");
    assert_eq!(rows.len(), 2);
    Ok(())
}

#[tokio::test]
async fn find_filter_and_count() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_mongo().await?;
    f.conn
        .execute(
            r#"db.nums.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }])"#,
            vec![],
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let (tx, rx) = mpsc::channel::<RowBatch>(8);
    f.conn
        .stream("db.nums.countDocuments({ v: { $gte: 3 } })", vec![], tx)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let (rows, done) = drain(rx).await;
    assert!(done);
    assert_eq!(rows.len(), 1);
    assert!(
        matches!(rows[0][0], CellValue::Int(2)),
        "got: {:?}",
        rows[0][0]
    );
    Ok(())
}

#[tokio::test]
async fn update_and_delete_report_affected() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_mongo().await?;
    f.conn
        .execute(r#"db.t.insertMany([{ a: 1 }, { a: 1 }, { a: 2 }])"#, vec![])
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let upd = f
        .conn
        .execute(r#"db.t.updateMany({ a: 1 }, { $set: { a: 9 } })"#, vec![])
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    assert_eq!(upd.rows_affected, 2);

    let del = f
        .conn
        .execute(r#"db.t.deleteMany({ a: 9 })"#, vec![])
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    assert_eq!(del.rows_affected, 2);
    Ok(())
}

#[tokio::test]
async fn introspect_lists_collections_and_infers_columns() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_mongo().await?;
    f.conn
        .execute(
            r#"db.widgets.insertMany([{ name: "a", qty: 1 }, { name: "b", qty: 2, tag: "x" }])"#,
            vec![],
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let tree = f
        .conn
        .introspect()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let db = tree
        .databases
        .iter()
        .find(|d| d.name == "testdb")
        .expect("testdb present");
    let schema = &db.schemas[0];
    let widgets = schema
        .tables
        .iter()
        .find(|t| t.name == "widgets")
        .expect("widgets collection");

    // _id pinned first, then inferred fields.
    assert_eq!(widgets.columns[0].name, "_id");
    assert_eq!(widgets.primary_key, vec!["_id"]);
    let names: Vec<_> = widgets.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"name"));
    assert!(names.contains(&"qty"));
    assert!(names.contains(&"tag"));
    // `tag` appeared in only one of two docs → nullable.
    let tag = widgets.columns.iter().find(|c| c.name == "tag").unwrap();
    assert!(tag.nullable);
    // `_id` index reported as the primary index.
    assert!(widgets.indexes.iter().any(|i| i.is_primary));
    Ok(())
}

#[tokio::test]
async fn cancel_stops_a_stream() -> anyhow::Result<()> {
    require_docker!();
    let f = common::start_mongo().await?;
    // A $where with an infinite-ish sleep keeps the cursor busy server-side.
    // Even if it returns quickly, cancel() must not error on a known handle.
    f.conn
        .execute(
            r#"db.big.insertMany([{ a: 1 }, { a: 2 }, { a: 3 }])"#,
            vec![],
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let (tx, _rx) = mpsc::channel::<RowBatch>(1);
    let handle = f
        .conn
        .stream("db.big.find({})", vec![], tx)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    // Cancelling a known handle succeeds; cancelling it twice is UnknownHandle.
    f.conn
        .cancel(handle)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    assert!(f.conn.cancel(handle).await.is_err());
    Ok(())
}
