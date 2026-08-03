//! P1 acceptance tests for the JS scripting sandbox.
//!
//! These prove the go/no-go gate from the design doc: a real JS loop with a
//! per-row `await db.query(...)` runs end to end against an injected runner,
//! `console.log` is captured, the "last query + log" result model works, the
//! guards fire, and — critically — a script cannot reach the filesystem or
//! network because those globals were never installed.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use db_script::{run, Limits, QueryResult, QueryRunner};
use serde_json::json;

/// A fake runner that answers `db.query` from an in-memory table, so tests
/// exercise the sandbox without a database. It also records every SQL string
/// and param set it was handed, so we can assert the loop really issued N
/// per-row queries with the right bound params.
#[derive(Default)]
struct FakeDb {
    calls: std::sync::Mutex<Vec<(String, Vec<serde_json::Value>)>>,
    call_count: AtomicUsize,
}

fn row(id: i64, name: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(id));
    m.insert("name".into(), json!(name));
    m
}

#[async_trait]
impl QueryRunner for FakeDb {
    async fn query(
        &self,
        sql: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<QueryResult, String> {
        self.call_count.fetch_add(1, Ordering::Relaxed);
        self.calls
            .lock()
            .unwrap()
            .push((sql.to_string(), params.clone()));

        // "users" query: return three rows. "orders" query (has a param):
        // return one row echoing the bound user_id, so the loop body can be
        // observed to run per user.
        if sql.contains("orders") {
            let uid = params.first().and_then(|v| v.as_i64()).unwrap_or(-1);
            let mut m = serde_json::Map::new();
            m.insert("user_id".into(), json!(uid));
            m.insert("total".into(), json!(uid * 10));
            Ok(QueryResult {
                columns: vec!["user_id".into(), "total".into()],
                rows: vec![m],
            })
        } else {
            Ok(QueryResult {
                columns: vec!["id".into(), "name".into()],
                rows: vec![row(1, "a"), row(2, "b"), row(3, "c")],
            })
        }
    }
}

#[tokio::test]
async fn loops_and_queries_per_row() {
    // The exact shape the user originally wanted: fetch rows, then for each row
    // run another parameterized query. Prove it runs and the params flow.
    let db = Arc::new(FakeDb::default());
    let script = r#"
        const users = await db.query("SELECT id, name FROM users");
        for (const u of users.rows) {
          const orders = await db.query(
            "SELECT * FROM orders WHERE user_id = $1", [u.id]);
          console.log("user", u.id, "->", orders.rows[0].total);
        }
        return users;
    "#;

    let out = run(script, db.clone(), Limits::default())
        .await
        .expect("script runs");

    // 1 users query + 3 per-user order queries = 4.
    assert_eq!(db.call_count.load(Ordering::Relaxed), 4);
    assert_eq!(out.query_count, 4);

    // The three per-row queries bound user_id 1, 2, 3 in order.
    let calls = db.calls.lock().unwrap();
    let order_params: Vec<i64> = calls
        .iter()
        .filter(|(sql, _)| sql.contains("orders"))
        .map(|(_, p)| p[0].as_i64().unwrap())
        .collect();
    assert_eq!(order_params, vec![1, 2, 3]);

    // Returned value → grid data = the users result (3 rows).
    let data = out.data.expect("has grid data");
    assert_eq!(data.columns, vec!["id", "name"]);
    assert_eq!(data.rows.len(), 3);

    // console.log captured, one line per user, formatted with args joined.
    assert_eq!(out.logs.len(), 3);
    assert_eq!(out.logs[0].text, "user 1 -> 10");
    assert_eq!(out.logs[2].text, "user 3 -> 30");
}

#[tokio::test]
async fn falls_back_to_last_query_when_nothing_returned() {
    // "last query + log": a script that returns nothing still fills the grid
    // with its final db.query result.
    let db = Arc::new(FakeDb::default());
    let script = r#"
        await db.query("SELECT id, name FROM users");
        await db.query("SELECT * FROM orders WHERE user_id = $1", [7]);
        // no return
    "#;
    let out = run(script, db, Limits::default()).await.expect("runs");
    let data = out.data.expect("falls back to last query");
    // Last query was the orders one.
    assert_eq!(data.columns, vec!["user_id", "total"]);
    assert_eq!(data.rows[0]["user_id"], json!(7));
}

#[tokio::test]
async fn no_filesystem_or_network_globals() {
    // The sandbox must hand the script nothing but console + db. Node/Deno/
    // browser escape hatches simply do not exist here.
    let db = Arc::new(FakeDb::default());
    for global in [
        "require",
        "process",
        "fetch",
        "XMLHttpRequest",
        "Deno",
        "globalThis.Bun",
        "setTimeout",
        "import",
    ] {
        let script = format!(r#"return typeof ({global}) !== "undefined";"#);
        // `import` is a syntax keyword, so a bare `typeof import` throws a parse
        // error rather than returning — either way, the capability is absent.
        let out = run(&script, db.clone(), Limits::default()).await;
        match out {
            Ok(o) => {
                // Result is non-tabular (a boolean), so data falls back to None
                // here; what matters is the boolean was false. We can't read the
                // boolean directly, so assert via a log instead below.
                assert!(o.data.is_none(), "{global} should not yield grid data");
            }
            Err(_) => { /* parse/throw also acceptable: capability absent */ }
        }
    }

    // Stronger form: have the script itself assert the global is undefined and
    // log the outcome, so we read a concrete signal.
    let script = r#"
        const absent = [];
        for (const g of ["require","process","fetch","XMLHttpRequest","Deno","setTimeout"]) {
          if (typeof globalThis[g] === "undefined") absent.push(g);
        }
        console.log(absent.join(","));
    "#;
    let out = run(script, db, Limits::default()).await.expect("runs");
    assert_eq!(
        out.logs[0].text,
        "require,process,fetch,XMLHttpRequest,Deno,setTimeout"
    );
}

#[tokio::test]
async fn db_is_the_only_capability() {
    // Positive control: db.query DOES work, confirming the absence above is
    // about the dangerous globals, not a broken sandbox.
    let db = Arc::new(FakeDb::default());
    let out = run(
        r#"return await db.query("SELECT id, name FROM users");"#,
        db,
        Limits::default(),
    )
    .await
    .expect("runs");
    assert_eq!(out.data.unwrap().rows.len(), 3);
}

#[tokio::test]
async fn query_limit_is_enforced() {
    // An accidental infinite query loop terminates at the cap rather than
    // running forever.
    let db = Arc::new(FakeDb::default());
    let limits = Limits {
        max_queries: 5,
        ..Default::default()
    };
    let script = r#"
        let n = 0;
        while (true) { await db.query("SELECT 1"); n++; }
    "#;
    let err = run(script, db.clone(), limits).await.unwrap_err();
    // The script throws when the guard trips; message mentions the limit.
    let msg = err.to_string();
    assert!(msg.contains("limit") || msg.contains("query"), "got: {msg}");
    // We issued no more than the cap (+ the one that tripped it).
    assert!(db.call_count.load(Ordering::Relaxed) <= 6);
}

#[tokio::test]
async fn script_throw_surfaces_as_error() {
    let db = Arc::new(FakeDb::default());
    let out = run(r#"throw new Error("boom");"#, db, Limits::default()).await;
    let err = out.unwrap_err();
    assert!(err.to_string().contains("boom"), "got: {err}");
}

#[tokio::test]
async fn query_error_propagates_into_script() {
    // A driver-side failure becomes a catchable JS error the script can handle.
    struct FailingDb;
    #[async_trait]
    impl QueryRunner for FailingDb {
        async fn query(
            &self,
            _sql: &str,
            _params: Vec<serde_json::Value>,
        ) -> Result<QueryResult, String> {
            Err("relation \"nope\" does not exist".into())
        }
    }
    let script = r#"
        try {
          await db.query("SELECT * FROM nope");
          console.log("no error");
        } catch (e) {
          console.log("caught: " + e.message);
        }
    "#;
    let out = run(script, Arc::new(FailingDb), Limits::default())
        .await
        .expect("script itself does not fail — it catches");
    assert!(
        out.logs[0].text.contains("caught") && out.logs[0].text.contains("does not exist"),
        "got: {:?}",
        out.logs
    );
}

#[tokio::test]
async fn wall_clock_timeout_stops_a_pure_cpu_loop() {
    // A `while (true) {}` with NO db.query and NO await never trips the
    // query cap and never yields — only the interrupt-handler timeout can
    // stop it. Use a short timeout so the test is fast.
    let db = Arc::new(FakeDb::default());
    let limits = Limits {
        timeout: std::time::Duration::from_millis(150),
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let err = run("while (true) {}", db, limits).await.unwrap_err();
    // It actually terminated (didn't hang the test), and reports a timeout.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "script should have been interrupted quickly",
    );
    assert!(
        matches!(err, db_script::ScriptError::Timeout(_)),
        "expected Timeout, got: {err:?}",
    );
}

#[tokio::test]
async fn cancellation_stops_a_running_script() {
    // Flip the shared cancel flag shortly after the run starts; the engine's
    // interrupt handler tears the (otherwise infinite) script down.
    let db = Arc::new(FakeDb::default());
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let limits = Limits {
        // Long timeout so the TIMEOUT isn't what stops it — cancellation is.
        timeout: std::time::Duration::from_secs(60),
        cancel: cancel.clone(),
        ..Default::default()
    };
    // Spawn a canceller that flips the flag after a beat.
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        c.store(true, Ordering::Relaxed);
    });
    let err = run("while (true) {}", db, limits).await.unwrap_err();
    assert!(
        matches!(err, db_script::ScriptError::Cancelled),
        "expected Cancelled, got: {err:?}",
    );
}
