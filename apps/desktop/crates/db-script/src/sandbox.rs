//! The QuickJS sandbox: build a runtime, install exactly `console` and `db`,
//! run the user's script, and read back the result.
//!
//! ## The async bridge (the risky part)
//!
//! `db.query` is an async host function. When a script `await`s it, the JS
//! engine must suspend while a real query runs on Tokio, then resume with the
//! result. rquickjs's `futures` feature makes this work: an `Async`-wrapped
//! closure that returns a Rust future is exposed to JS as a function returning
//! a Promise, and [`AsyncRuntime::idle`] drives both the Rust futures and the
//! JS microtask queue to completion. We evaluate the script as a module so
//! top-level `await` and `return`-like semantics are available, wrapping the
//! user's source in an async IIFE that resolves to their return value.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};

use rquickjs::{prelude::Async, AsyncContext, AsyncRuntime, CatchResultExt, Function, Object};

use crate::{Limits, LogLevel, LogLine, QueryResult, QueryRunner, ScriptError, ScriptOutcome};

/// Shared mutable state the host functions write into during a run.
struct Bridge {
    runner: Arc<dyn QueryRunner>,
    logs: Mutex<Vec<LogLine>>,
    /// Last query result, kept so a script that returns nothing still yields
    /// grid data (the "last query" half of "last query + log").
    last_result: Mutex<Option<QueryResult>>,
    query_count: AtomicU32,
    total_rows: AtomicU32,
    limits: Limits,
}

/// Why the interrupt handler tore the script down — used to turn the
/// generic "interrupted" JS exception into a precise ScriptError.
#[derive(Clone, Copy)]
enum StopReason {
    Timeout,
    Cancelled,
}

pub(crate) async fn execute(
    source: &str,
    runner: Arc<dyn QueryRunner>,
    limits: Limits,
) -> Result<ScriptOutcome, ScriptError> {
    let bridge = Arc::new(Bridge {
        runner,
        logs: Mutex::new(Vec::new()),
        last_result: Mutex::new(None),
        query_count: AtomicU32::new(0),
        total_rows: AtomicU32::new(0),
        limits,
    });

    let rt = AsyncRuntime::new().map_err(engine)?;

    // Wall-clock timeout + cooperative cancellation, both enforced through
    // rquickjs's interrupt handler: it's called regularly while JS executes,
    // and returning `true` raises an uncatchable exception that unwinds the
    // engine. This is the ONLY thing that stops a pure `while (true) {}` — a
    // tokio timeout on the caller can't, because the engine thread never
    // yields. We record WHY it fired (deadline vs cancel) in a shared cell so
    // the generic "interrupted" JS error can be reclassified below.
    let deadline = std::time::Instant::now() + bridge.limits.timeout;
    let cancel = bridge.limits.cancel.clone();
    let stop_reason: Arc<Mutex<Option<StopReason>>> = Arc::new(Mutex::new(None));
    let sr = stop_reason.clone();
    rt.set_interrupt_handler(Some(Box::new(move || {
        if cancel.load(Ordering::Relaxed) {
            *sr.lock().unwrap() = Some(StopReason::Cancelled);
            return true;
        }
        if std::time::Instant::now() >= deadline {
            *sr.lock().unwrap() = Some(StopReason::Timeout);
            return true;
        }
        false
    })))
    .await;

    let ctx = AsyncContext::full(&rt).await.map_err(engine)?;

    // Wrap the user's source in an async IIFE so top-level `return` works and
    // the whole thing resolves to a single value we can read back. The user's
    // code runs in the function body verbatim.
    let wrapped = format!("globalThis.__nembrix_result = (async () => {{\n{source}\n}})();");

    let b_install = bridge.clone();
    let sr_eval = stop_reason.clone();
    let to_eval = bridge.limits.timeout;
    let run_result: Result<(), ScriptError> = ctx
        .async_with(async move |ctx| {
            install_console(&ctx, b_install.clone())?;
            install_db(&ctx, b_install.clone())?;

            // Evaluate the wrapper. This kicks off the async IIFE, which parks
            // on the first `await db.query(...)`.
            ctx.eval::<(), _>(wrapped.as_bytes())
                .catch(&ctx)
                .map_err(|e| classify(&sr_eval, to_eval, e.to_string()))?;
            Ok(())
        })
        .await;
    run_result?;

    // Drive every pending Rust future + JS microtask to completion. Without
    // this, the promise from the IIFE never settles.
    rt.idle().await;

    // Read back the resolved value of the IIFE promise.
    let sr_await = stop_reason.clone();
    let to_await = bridge.limits.timeout;
    let returned: Option<QueryResult> = ctx
        .async_with(async move |ctx| {
            let promise: rquickjs::Value = ctx
                .globals()
                .get("__nembrix_result")
                .map_err(|e| ScriptError::Engine(e.to_string()))?;
            // If the script threw, awaiting the promise surfaces the rejection.
            let settled: rquickjs::Value = match promise.into_promise() {
                Some(p) => p
                    .into_future::<rquickjs::Value>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| classify(&sr_await, to_await, e.to_string()))?,
                None => return Ok::<_, ScriptError>(None),
            };
            // A `db.query` result is a `{ columns, rows }` object; anything else
            // (undefined, a number, a string) is not tabular, so we fall back to
            // the last query result instead.
            Ok(coerce_query_result(&ctx, settled))
        })
        .await?;

    let logs = std::mem::take(&mut *bridge.logs.lock().unwrap());
    let last = bridge.last_result.lock().unwrap().clone();
    let query_count = bridge.query_count.load(Ordering::Relaxed);

    Ok(ScriptOutcome {
        data: returned.or(last),
        logs,
        query_count,
    })
}

/// Install a minimal `console` with `log`/`warn`/`error`, each capturing its
/// stringified args into the bridge's log buffer.
fn install_console(ctx: &rquickjs::Ctx<'_>, bridge: Arc<Bridge>) -> Result<(), ScriptError> {
    let console = Object::new(ctx.clone()).map_err(engine)?;

    for (name, level) in [
        ("log", LogLevel::Log),
        ("warn", LogLevel::Warn),
        ("error", LogLevel::Error),
    ] {
        let b = bridge.clone();
        let lvl = level.clone();
        let f = Function::new(
            ctx.clone(),
            move |args: rquickjs::function::Rest<rquickjs::Value>| {
                let text = args.0.iter().map(stringify).collect::<Vec<_>>().join(" ");
                b.logs.lock().unwrap().push(LogLine {
                    level: lvl.clone(),
                    text,
                });
            },
        )
        .map_err(engine)?;
        console.set(name, f).map_err(engine)?;
    }

    ctx.globals().set("console", console).map_err(engine)?;
    Ok(())
}

/// Install `db.query(sql, params?)` as an async host function returning a JS
/// object `{ columns, rows, rowCount }`.
fn install_db(ctx: &rquickjs::Ctx<'_>, bridge: Arc<Bridge>) -> Result<(), ScriptError> {
    let db = Object::new(ctx.clone()).map_err(engine)?;

    let b = bridge.clone();
    let query = Function::new(
        ctx.clone(),
        Async(
            move |sql: String, params: rquickjs::function::Opt<rquickjs::Value<'_>>| {
                let b = b.clone();
                // Convert JS params to JSON *synchronously* (we still hold ctx),
                // then move only owned data into the async block.
                let json_params: Result<Option<serde_json::Value>, rquickjs::Error> =
                    match params.0.as_ref() {
                        Some(v) => serde_json_from_js(v).map(Some).ok_or_else(|| {
                            rquickjs::Error::new_from_js_message(
                                "db.query",
                                "params",
                                "unserializable parameter",
                            )
                        }),
                        None => Ok(None),
                    };
                async move {
                    let params_vec = match json_params? {
                        Some(serde_json::Value::Array(a)) => a,
                        None | Some(serde_json::Value::Null) => Vec::new(),
                        Some(other) => vec![other],
                    };

                    // Enforce the query-count guard before issuing.
                    let n = b.query_count.fetch_add(1, Ordering::Relaxed) + 1;
                    if n > b.limits.max_queries {
                        return Err(rquickjs::Error::new_from_js_message(
                            "db.query",
                            "limit",
                            "max query count exceeded",
                        ));
                    }

                    let result = b.runner.query(&sql, params_vec).await.map_err(|msg| {
                        rquickjs::Error::new_from_js_message("db", "query", leak_msg(msg))
                    })?;

                    // Row-cap guard.
                    let running = b
                        .total_rows
                        .fetch_add(result.row_count() as u32, Ordering::Relaxed)
                        + result.row_count() as u32;
                    if running as usize > b.limits.max_total_rows {
                        return Err(rquickjs::Error::new_from_js_message(
                            "db.query",
                            "limit",
                            "max total rows exceeded",
                        ));
                    }

                    *b.last_result.lock().unwrap() = Some(result.clone());
                    Ok(QueryResultJs(result))
                }
            },
        ),
    )
    .map_err(engine)?;

    db.set("query", query).map_err(engine)?;
    ctx.globals().set("db", db).map_err(engine)?;
    Ok(())
}

/// Newtype so we can implement `IntoJs` for a `QueryResult` shaped the way a
/// script expects: `{ columns, rows, rowCount }`.
struct QueryResultJs(QueryResult);

impl<'js> rquickjs::IntoJs<'js> for QueryResultJs {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
        let obj = Object::new(ctx.clone())?;
        obj.set("columns", self.0.columns.clone())?;
        obj.set("rowCount", self.0.rows.len() as i64)?;
        // rows: array of objects. Round-trip via serde_json → JS.
        let rows_json = serde_json::Value::Array(
            self.0
                .rows
                .into_iter()
                .map(serde_json::Value::Object)
                .collect(),
        );
        obj.set("rows", json_to_js(ctx, &rows_json)?)?;
        Ok(obj.into_value())
    }
}

// ---- value conversion helpers ----

/// Best-effort JS → serde_json for the value kinds a params array holds.
fn serde_json_from_js(v: &rquickjs::Value<'_>) -> Option<serde_json::Value> {
    if v.is_null() || v.is_undefined() {
        Some(serde_json::Value::Null)
    } else if let Some(b) = v.as_bool() {
        Some(serde_json::Value::Bool(b))
    } else if let Some(i) = v.as_int() {
        Some(serde_json::Value::from(i))
    } else if let Some(f) = v.as_float() {
        serde_json::Number::from_f64(f).map(serde_json::Value::Number)
    } else if let Some(s) = v.as_string() {
        s.to_string().ok().map(serde_json::Value::String)
    } else if let Some(arr) = v.as_array() {
        let mut out = Vec::with_capacity(arr.len());
        for item in arr.iter::<rquickjs::Value>() {
            out.push(serde_json_from_js(&item.ok()?)?);
        }
        Some(serde_json::Value::Array(out))
    } else if let Some(obj) = v.as_object() {
        let mut map = serde_json::Map::new();
        for entry in obj.props::<String, rquickjs::Value>() {
            let (k, val) = entry.ok()?;
            map.insert(k, serde_json_from_js(&val)?);
        }
        Some(serde_json::Value::Object(map))
    } else {
        None
    }
}

fn json_to_js<'js>(
    ctx: &rquickjs::Ctx<'js>,
    v: &serde_json::Value,
) -> rquickjs::Result<rquickjs::Value<'js>> {
    Ok(match v {
        serde_json::Value::Null => rquickjs::Value::new_null(ctx.clone()),
        serde_json::Value::Bool(b) => rquickjs::Value::new_bool(ctx.clone(), *b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rquickjs::Value::new_number(ctx.clone(), i as f64)
            } else {
                rquickjs::Value::new_number(ctx.clone(), n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => rquickjs::String::from_str(ctx.clone(), s)?.into_value(),
        serde_json::Value::Array(a) => {
            let arr = rquickjs::Array::new(ctx.clone())?;
            for (i, item) in a.iter().enumerate() {
                arr.set(i, json_to_js(ctx, item)?)?;
            }
            arr.into_value()
        }
        serde_json::Value::Object(m) => {
            let obj = Object::new(ctx.clone())?;
            for (k, val) in m {
                obj.set(k.as_str(), json_to_js(ctx, val)?)?;
            }
            obj.into_value()
        }
    })
}

/// Read a settled JS value back as a `QueryResult` iff it looks like one
/// (has `columns` + `rows`). Otherwise the script returned something
/// non-tabular and we return None so the caller falls back to the last query.
fn coerce_query_result(_ctx: &rquickjs::Ctx<'_>, v: rquickjs::Value<'_>) -> Option<QueryResult> {
    let obj = v.as_object()?;
    let columns: Vec<String> = obj.get("columns").ok()?;
    let rows_val: rquickjs::Value = obj.get("rows").ok()?;
    let rows_json = serde_json_from_js(&rows_val)?;
    let rows = match rows_json {
        serde_json::Value::Array(a) => a
            .into_iter()
            .filter_map(|r| match r {
                serde_json::Value::Object(m) => Some(m),
                _ => None,
            })
            .collect(),
        _ => return None,
    };
    Some(QueryResult { columns, rows })
}

fn stringify(v: &rquickjs::Value<'_>) -> String {
    if let Some(s) = v.as_string() {
        s.to_string().unwrap_or_default()
    } else {
        serde_json_from_js(v)
            .map(|j| j.to_string())
            .unwrap_or_else(|| "[unserializable]".into())
    }
}

/// rquickjs error messages want `&'static str`; script-run driver errors are
/// owned. Leak them — a script run is short-lived and low-frequency, and this
/// only happens on the error path. (Revisit in P5 if it shows up in profiles.)
fn leak_msg(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn engine<E: std::fmt::Display>(e: E) -> ScriptError {
    ScriptError::Engine(e.to_string())
}

/// Turn a JS-side error into the right ScriptError. When the interrupt
/// handler fired (timeout or cancel), QuickJS surfaces a generic
/// "interrupted" exception — we reclassify it using the reason the handler
/// recorded so the user sees "timed out" / "cancelled" instead of a cryptic
/// JS error. Any other JS error passes through as ScriptError::Js.
fn classify(
    stop_reason: &Arc<Mutex<Option<StopReason>>>,
    timeout: std::time::Duration,
    msg: String,
) -> ScriptError {
    match *stop_reason.lock().unwrap() {
        Some(StopReason::Timeout) => ScriptError::Timeout(timeout),
        Some(StopReason::Cancelled) => ScriptError::Cancelled,
        None => ScriptError::Js(msg),
    }
}
