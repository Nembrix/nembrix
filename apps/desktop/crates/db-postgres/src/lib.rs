//! Postgres driver — `DbConnection` impl on top of `tokio-postgres` +
//! `deadpool-postgres`.
//!
//! ## Why not sqlx / the extended protocol
//!
//! Every query here goes through Postgres' **simple query protocol**
//! (`simple_query` / `batch_execute`), never the extended (prepared-statement)
//! protocol. The reason is connection poolers: PgBouncer in transaction- or
//! statement-pooling mode (and Supabase's pooler, RDS Proxy, …) can route a
//! Parse and its later Bind/Execute to *different* backend connections, so a
//! prepared statement made on one backend is invisible on the next —
//! `prepared statement "…" does not exist`. sqlx (and tokio-postgres'
//! `query`/`execute`) always prepare, even for the "unnamed" statement, and the
//! aggressive poolers we target discard even that. The simple protocol carries
//! no prepared-statement state, so it survives any pooler.
//!
//! The trade-off is that the simple protocol returns every value as **text**
//! and exposes only column *names* (no type OIDs). We recover a useful typed
//! view for the grid by inferring [`CellValue`] from each value's text form
//! (see [`infer_cell`]) rather than from a server-declared type.
//!
//! Because parameters can't be bound in the simple protocol, [`Params`] are
//! inlined into the SQL as safely-quoted literals (see [`inline_params`]).

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    error_chain, CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params,
    QueryHandle, QueryLang, RowBatch, RowSink, SchemaTree,
};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::config::SslMode;
use tokio_postgres::{CancelToken, Config, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

pub mod introspect;
pub mod object_ops;

const STREAM_BATCH: usize = 200;
const POOL_SIZE: usize = 8;
/// Default hard ceiling on the whole connect handshake when a config doesn't
/// set `connect_timeout_ms`. Covers the case where a pooler accepts the TCP
/// socket but stalls before completing TLS/auth/first-query.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Deadpool pool over `tokio-postgres`. Exposed so the Postgres-specific
/// `object_ops` module can run its rename/copy/drop statements against the
/// same live connection (via [`DbConnection::as_any`] downcast to [`PgConn`]).
pub type PgPool = Pool;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PgConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: PgSsl,
    pub application_name: Option<String>,
    pub statement_timeout_ms: Option<u32>,
    /// Hard wall-clock bound on the whole `connect()` — TCP connect, TLS
    /// handshake, auth, and the initial `SELECT 1`. tokio-postgres'
    /// `connect_timeout` only covers the TCP phase, so a pooler that accepts
    /// the socket but then stalls in the TLS handshake or never answers the
    /// first query would otherwise hang forever. `None` uses [`DEFAULT_CONNECT_TIMEOUT`].
    pub connect_timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PgSsl {
    Disable,
    Prefer,
    Require,
}

impl PgSsl {
    fn to_pg(self) -> SslMode {
        match self {
            // `Prefer` is tokio-postgres' native "try TLS, fall back to
            // plaintext if the server refuses" — the same graceful fallback
            // libpq gives, so a no-TLS server behind `sslmode=prefer` still
            // connects instead of erroring "server does not support TLS".
            PgSsl::Disable => SslMode::Disable,
            PgSsl::Prefer => SslMode::Prefer,
            PgSsl::Require => SslMode::Require,
        }
    }
}

/// TLS connector that encrypts but does NOT verify the server certificate —
/// mirrors libpq `sslmode=require` (encryption without authentication). A
/// stricter verifying mode is a future knob; for now this matches the posture
/// users get from `psql "…sslmode=require"`.
fn tls_connector() -> MakeRustlsConnect {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(danger::NoVerify))
        .with_no_client_auth();
    MakeRustlsConnect::new(config)
}

/// Certificate verifier that accepts any server cert. See [`tls_connector`].
mod danger {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, SignatureScheme};

    #[derive(Debug)]
    pub struct NoVerify;

    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            use SignatureScheme::*;
            vec![
                RSA_PKCS1_SHA256,
                RSA_PKCS1_SHA384,
                RSA_PKCS1_SHA512,
                ECDSA_NISTP256_SHA256,
                ECDSA_NISTP384_SHA384,
                ECDSA_NISTP521_SHA512,
                RSA_PSS_SHA256,
                RSA_PSS_SHA384,
                RSA_PSS_SHA512,
                ED25519,
            ]
        }
    }
}

pub struct PgConn {
    pool: Pool,
    /// Handle → cancel token for each in-flight streamed query. The token
    /// opens its own connection to the server (via `CancelToken::cancel_query`)
    /// and sends a CancelRequest — which PgBouncer forwards to the right
    /// backend, so this cancels correctly *through* the pooler (unlike
    /// `pg_cancel_backend`, which needs the real backend PID we can't see).
    cancels: Arc<DashMap<QueryHandle, CancelToken>>,
}

impl PgConn {
    pub async fn connect(cfg: PgConfig) -> DbResult<Arc<Self>> {
        // Install a process-wide rustls crypto provider once. Ignore the error
        // if another component already installed one.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let mut pg = Config::new();
        pg.host(&cfg.host)
            .port(cfg.port)
            .user(&cfg.user)
            .ssl_mode(cfg.ssl_mode.to_pg())
            .application_name(cfg.application_name.as_deref().unwrap_or("nembrix"))
            .connect_timeout(Duration::from_secs(15));
        if let Some(db) = &cfg.database {
            pg.dbname(db);
        }
        if let Some(pw) = &cfg.password {
            pg.password(pw);
        }
        if let Some(ms) = cfg.statement_timeout_ms {
            // libpq `options=-c statement_timeout=…` — applied per session by
            // the server, no round-trip needed from us.
            pg.options(format!("-c statement_timeout={ms}"));
        }

        let mgr_config = ManagerConfig {
            // `Fast` only checks `is_closed()` on recycle — no test query, so
            // nothing that could trip a pooler.
            recycling_method: RecyclingMethod::Fast,
        };
        let mgr = Manager::from_config(pg, tls_connector(), mgr_config);
        let pool = Pool::builder(mgr)
            .max_size(POOL_SIZE)
            .build()
            .map_err(|e| DbError::Connect(error_chain(&e)))?;

        // deadpool is lazy: building the pool does not open a connection, so
        // auth / host errors wouldn't surface until the first query. Force one
        // real connection now so `connect()` fails fast with the true reason
        // (bad password, unreachable host, TLS refused, …).
        //
        // Bound the whole thing in a hard timeout. `connect_timeout` above only
        // covers the TCP connect — a pooler that accepts the socket but then
        // stalls in the TLS handshake, auth, or never answers `SELECT 1` would
        // hang indefinitely (deadpool's `get()` has no wait timeout by default).
        let budget = cfg
            .connect_timeout_ms
            .map(|ms| Duration::from_millis(ms as u64))
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT);
        let force_connect = async {
            // `error_chain`, not `to_string()`: deadpool/tokio-postgres bury the
            // real reason (refused, DNS, auth) under two useless outer layers.
            let client = pool
                .get()
                .await
                .map_err(|e| DbError::Connect(error_chain(&e)))?;
            client
                .simple_query("SELECT 1")
                .await
                .map_err(|e| DbError::Connect(error_chain(&e)))?;
            drop(client);
            Ok::<(), DbError>(())
        };
        match tokio::time::timeout(budget, force_connect).await {
            Ok(res) => res?,
            Err(_) => {
                return Err(DbError::Connect(format!(
                    "connection timed out after {}s (server accepted the socket but did not \
                     complete TLS/auth/handshake — common with a misconfigured pooler)",
                    budget.as_secs()
                )));
            }
        }

        Ok(Arc::new(Self {
            pool,
            cancels: Arc::new(DashMap::new()),
        }))
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }
}

#[async_trait]
impl DbConnection for PgConn {
    fn lang(&self) -> QueryLang {
        QueryLang::Sql
    }

    async fn ping(&self) -> DbResult<()> {
        let client = self.pool.get().await.map_err(pool_err)?;
        client.simple_query("SELECT 1").await.map_err(driver_err)?;
        Ok(())
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        let client = self.pool.get().await.map_err(pool_err)?;
        introspect::introspect(&client).await
        // `&client` (a deadpool Object) deref-coerces to `&tokio_postgres::Client`.
    }

    async fn execute(&self, query: &str, params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let sql = inline_params(query, params)?;
        let client = self.pool.get().await.map_err(pool_err)?;

        // `simple_query` runs the whole (possibly multi-statement) batch on the
        // simple protocol and reports a rows-affected count per statement. We
        // report the last statement's count — matching the "run this and tell
        // me what it changed" intent of `execute`.
        let msgs = client.simple_query(&sql).await.map_err(driver_err)?;
        let mut rows_affected = 0u64;
        for m in &msgs {
            if let SimpleQueryMessage::CommandComplete(n) = m {
                rows_affected = *n;
            }
        }
        Ok(ExecSummary {
            rows_affected,
            last_insert_id: None, // Postgres returns via RETURNING; use stream() for that.
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn stream(&self, query: &str, params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let handle = QueryHandle::new();
        let sql = inline_params(query, params)?;
        let cancels = self.cancels.clone();

        // Hold a dedicated pooled client for the life of the stream so we can
        // (a) grab its cancel token and (b) keep the streaming connection
        // pinned to one backend for the whole result.
        let client = self.pool.get().await.map_err(pool_err)?;
        cancels.insert(handle, client.cancel_token());

        tokio::spawn(async move {
            let result = client.simple_query_raw(&sql).await;
            let stream = match result {
                Ok(s) => s,
                Err(e) => {
                    // `error_chain`, not `to_string()`: tokio-postgres' Display
                    // is just the outer "db error" layer, and the actual server
                    // message (syntax error, constraint violation, …) lives in
                    // the source chain underneath it.
                    let _ = sink
                        .send(RowBatch {
                            columns: None,
                            rows: vec![vec![CellValue::Text(error_chain(&e))]],
                            done: true,
                        })
                        .await;
                    cancels.remove(&handle);
                    return;
                }
            };
            futures::pin_mut!(stream);

            let mut buf: Vec<Vec<CellValue>> = Vec::with_capacity(STREAM_BATCH);
            let mut columns: Option<Vec<ColMeta>> = None;
            let mut col_count = 0usize;

            loop {
                match stream.try_next().await {
                    Ok(Some(SimpleQueryMessage::RowDescription(desc))) => {
                        let cols: Vec<ColMeta> = desc
                            .iter()
                            .map(|c| ColMeta {
                                name: c.name().to_string(),
                                // The simple protocol carries no type OID; the
                                // grid infers per-value kinds instead. Label the
                                // column generically.
                                type_name: "text".to_string(),
                                nullable: true,
                            })
                            .collect();
                        col_count = cols.len();
                        columns = Some(cols);
                    }
                    Ok(Some(SimpleQueryMessage::Row(row))) => {
                        buf.push(extract_row(&row, col_count));
                        if buf.len() >= STREAM_BATCH {
                            let _ = sink
                                .send(RowBatch {
                                    columns: columns.take(),
                                    rows: std::mem::take(&mut buf),
                                    done: false,
                                })
                                .await;
                        }
                    }
                    // CommandComplete for a SELECT arrives after its rows; for a
                    // non-row statement it's all we get. Either way it's not a
                    // terminal signal on its own — the stream ends at `None`.
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        let _ = sink
                            .send(RowBatch {
                                columns: columns.take(),
                                rows: std::mem::take(&mut buf),
                                done: true,
                            })
                            .await;
                        break;
                    }
                    Err(e) => {
                        // Same as above: keep the source chain, or the caller
                        // only ever sees the bare "db error" outer layer.
                        let _ = sink
                            .send(RowBatch {
                                columns: columns.take(),
                                rows: vec![vec![CellValue::Text(error_chain(&e))]],
                                done: true,
                            })
                            .await;
                        break;
                    }
                }
            }
            cancels.remove(&handle);
            drop(client);
        });

        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let token = self
            .cancels
            .get(&handle)
            .map(|e| e.value().clone())
            .ok_or(DbError::UnknownHandle)?;
        // Opens its own connection and sends a CancelRequest; the pooler
        // forwards it to the backend running the query.
        token
            .cancel_query(tls_connector())
            .await
            .map_err(driver_err)?;
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

fn pool_err(e: deadpool_postgres::PoolError) -> DbError {
    DbError::Driver(error_chain(&e))
}

fn driver_err(e: tokio_postgres::Error) -> DbError {
    // The outer layer is a generic "error connecting to server" / "db error";
    // the DbError the user reads needs the source chain underneath it.
    DbError::Driver(error_chain(&e))
}

/// Inline driver [`Params`] into `$1, $2, …` placeholders as safely-quoted SQL
/// literals. The simple query protocol can't bind parameters, so we substitute
/// them client-side.
///
/// Quoting rules (Postgres):
/// - strings: single-quote, doubling inner `'`, prefixed `E` when the value
///   contains a backslash so `\` is taken literally.
/// - numbers/bools: emitted bare (already validated by the Rust type).
/// - bytea: `'\xDEADBEEF'` hex form.
/// - NULL: the literal `NULL`.
///
/// Placeholders are matched greedily by number, so `$10` binds param 10, not
/// `$1` followed by `0`. A `$n` with no corresponding param is left as-is
/// (Postgres will raise its own clear error).
fn inline_params(query: &str, params: Params) -> DbResult<String> {
    if params.is_empty() {
        return Ok(query.to_string());
    }
    let literals: Vec<String> = params.iter().map(quote_literal).collect();

    let mut out = String::with_capacity(query.len() + literals.len() * 8);
    let bytes = query.as_bytes();
    let mut i = 0;
    // Track single-quoted string / dollar-quoted / comment context so a `$1`
    // inside a string literal or comment isn't substituted.
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '\'' => {
                // Copy through a single-quoted string, respecting '' escapes.
                out.push('\'');
                i += 1;
                while i < bytes.len() {
                    let ch = bytes[i] as char;
                    out.push(ch);
                    i += 1;
                    if ch == '\'' {
                        if i < bytes.len() && bytes[i] as char == '\'' {
                            out.push('\'');
                            i += 1;
                        } else {
                            break;
                        }
                    }
                }
            }
            '$' => {
                // Parse the following digits as a 1-based param index.
                let start = i + 1;
                let mut j = start;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > start {
                    let idx: usize = query[start..j].parse().unwrap_or(0);
                    if idx >= 1 && idx <= literals.len() {
                        out.push_str(&literals[idx - 1]);
                    } else {
                        out.push_str(&query[i..j]);
                    }
                    i = j;
                } else {
                    out.push('$');
                    i += 1;
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(out)
}

fn quote_literal(v: &CellValue) -> String {
    match v {
        CellValue::Null => "NULL".to_string(),
        CellValue::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Int(i) => i.to_string(),
        CellValue::Float(f) => {
            if f.is_finite() {
                f.to_string()
            } else if f.is_nan() {
                "'NaN'".to_string()
            } else if *f > 0.0 {
                "'Infinity'".to_string()
            } else {
                "'-Infinity'".to_string()
            }
        }
        CellValue::Text(s) | CellValue::Raw(s) => quote_string(s),
        CellValue::Document(v) => {
            // Bind JSON as a quoted string; Postgres coerces to json/jsonb at
            // the target site.
            quote_string(&v.to_string())
        }
        CellValue::Bytes(b) => {
            let mut s = String::with_capacity(b.len() * 2 + 4);
            s.push_str("'\\x");
            for byte in b {
                use std::fmt::Write;
                let _ = write!(s, "{byte:02x}");
            }
            s.push('\'');
            s
        }
    }
}

/// Quote a string as a Postgres string literal. Uses the `E'…'` escape form
/// when the value contains a backslash so `\` is taken literally rather than as
/// the start of an escape (standard_conforming_strings can't be assumed).
fn quote_string(s: &str) -> String {
    let escaped = s.replace('\'', "''");
    if s.contains('\\') {
        format!("E'{}'", escaped.replace('\\', "\\\\"))
    } else {
        format!("'{escaped}'")
    }
}

fn extract_row(row: &tokio_postgres::SimpleQueryRow, col_count: usize) -> Vec<CellValue> {
    let n = if col_count > 0 { col_count } else { row.len() };
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(match row.get(i) {
            Some(s) => infer_cell(s),
            None => CellValue::Null,
        });
    }
    out
}

/// Best-effort text → [`CellValue`] inference. The simple protocol gives us the
/// value's text form with no type OID, so we pick the grid-friendliest cell kind
/// the text plausibly represents:
///
/// - `t` / `f` → [`CellValue::Bool`] (Postgres' text form for `bool`).
/// - an integer that fits `i64` → [`CellValue::Int`].
/// - a decimal/exponent number that round-trips **losslessly** through `f64`
///   → [`CellValue::Float`]; a numeric that would lose precision (big `numeric`,
///   a huge integer, high-scale decimals) → [`CellValue::Raw`] (lossless text,
///   still right-aligned as a number in the grid — never silently rounded).
/// - `{…}` / `[…]` that parse as JSON → [`CellValue::Document`].
/// - everything else (timestamps, uuid, bytea hex, arrays, money, …) → text.
///
/// Losslessness is the invariant that matters: we would rather label a value
/// generically than show a *wrong* number, so anything numeric we can't prove
/// round-trips is preserved verbatim as `Raw`.
fn infer_cell(s: &str) -> CellValue {
    // Booleans: Postgres renders bool as single-char t / f in text output.
    if s == "t" {
        return CellValue::Bool(true);
    }
    if s == "f" {
        return CellValue::Bool(false);
    }
    // Integers that fit i64. Guard against leading zeros ("007") and lone "-"
    // which we'd rather keep as text. `from_i64` further routes values past
    // JS's 2^53 safe range to a lossless `Raw` so the frontend can't round them.
    if let Ok(i) = s.parse::<i64>() {
        if !has_insignificant_leading_zero(s) {
            return CellValue::from_i64(i);
        }
    }
    // Anything else numeric-looking (decimals, exponents, integers too big for
    // i64). Postgres `numeric`/`decimal` is arbitrary-precision; `f64` is not.
    // Only emit Float when the value round-trips through f64 without loss;
    // otherwise keep the exact digits as Raw so we never corrupt the value.
    if looks_like_number(s) {
        // A leading-zero number ("007", "0.10"→ok, but "01") is an identifier
        // in disguise or carries significant scale — keep it verbatim. "0.x"
        // and a lone "0" are fine.
        if has_numeric_leading_zero(s) {
            return CellValue::Text(s.to_string());
        }
        if let Ok(f) = s.parse::<f64>() {
            if f.is_finite() && f64_roundtrips(s, f) {
                return CellValue::Float(f);
            }
        }
        // A well-formed number we can't represent exactly: preserve the text,
        // don't round. Still a number, so the grid can right-align it.
        return CellValue::Raw(s.to_string());
    }
    // JSON objects / arrays. (Postgres array literals like `{1,2,3}` are NOT
    // valid JSON, so they fall through to text — which is what we want.)
    let t = s.trim_start();
    if t.starts_with('{') || t.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            return CellValue::Document(v);
        }
    }
    CellValue::Text(s.to_string())
}

/// True when a string is a well-formed decimal/exponent numeric literal
/// (optionally signed, at most one `.`, an optional single `e`/`E` exponent).
/// Stricter than the old `looks_like_float`: rejects `1e`, `1.2.3`, `--1`,
/// stray characters — so only genuine numbers reach the parse/round-trip check.
fn looks_like_number(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    let mut saw_digit = false;
    let mut saw_dot = false;
    let mut saw_exp = false;
    // optional leading sign
    if bytes[i] == b'+' || bytes[i] == b'-' {
        i += 1;
    }
    while i < bytes.len() {
        match bytes[i] {
            b'0'..=b'9' => saw_digit = true,
            b'.' if !saw_dot && !saw_exp => saw_dot = true,
            b'e' | b'E' if saw_digit && !saw_exp => {
                saw_exp = true;
                // exponent may carry its own sign, and must have digits after
                if i + 1 < bytes.len() && (bytes[i + 1] == b'+' || bytes[i + 1] == b'-') {
                    i += 1;
                }
                // require at least one digit after the exponent marker
                if i + 1 >= bytes.len() || !bytes[i + 1].is_ascii_digit() {
                    return false;
                }
            }
            _ => return false,
        }
        i += 1;
    }
    saw_digit
}

/// True when `f64` can represent `s` without losing precision the user would
/// notice. The check: the input can't carry more significant digits than f64
/// reliably holds (17), and re-parsing our own shortest formatting of `f` must
/// yield the identical bit pattern. A big/high-scale `numeric` fails the digit
/// ceiling and is kept as `Raw`; ordinary floats (`3.14`, `1e3`, `-0.5`) pass.
fn f64_roundtrips(s: &str, f: f64) -> bool {
    let significant = s.chars().filter(|c| c.is_ascii_digit()).count();
    if significant > 17 {
        return false;
    }
    // Rust's shortest round-trip repr re-parses to the same f64 by definition;
    // the ceiling above is what actually rejects lossy inputs. This guards the
    // parse itself and any exotic formatting mismatch.
    format!("{f}").parse::<f64>() == Ok(f)
}

/// True when a numeric literal has an insignificant leading zero on its integer
/// part ("007", "-01") — treat as text. `0`, `-0`, and `0.5`/`0.10` (a leading
/// zero that's the whole integer part before a dot) are legitimate numbers.
fn has_numeric_leading_zero(s: &str) -> bool {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    let int_part = body.split(['.', 'e', 'E']).next().unwrap_or(body);
    int_part.len() > 1 && int_part.starts_with('0')
}

/// True when a numeric string has a leading zero that would be lost by parsing
/// to an integer (e.g. "007", "-01") — such values are identifiers-in-disguise
/// and should stay text. "0" and "-0" are fine.
fn has_insignificant_leading_zero(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s);
    digits.len() > 1 && digits.starts_with('0')
}

#[cfg(test)]
mod infer_tests {
    use super::*;

    fn kind(s: &str) -> CellValue {
        infer_cell(s)
    }

    #[test]
    fn bools_and_integers() {
        assert!(matches!(kind("t"), CellValue::Bool(true)));
        assert!(matches!(kind("f"), CellValue::Bool(false)));
        assert!(matches!(kind("0"), CellValue::Int(0)));
        assert!(matches!(kind("-7"), CellValue::Int(-7)));
        // Within JS's safe integer range → Int.
        assert!(matches!(kind("9007199254740991"), CellValue::Int(_)));
        // Past 2^53 (still a valid i64) must be lossless Raw, or the frontend
        // would round it when reading the JSON number.
        match kind("9007199254740992") {
            CellValue::Raw(s) => assert_eq!(s, "9007199254740992"),
            other => panic!("expected Raw for unsafe int, got {other:?}"),
        }
        assert!(matches!(kind("9223372036854775807"), CellValue::Raw(_))); // i64::MAX
                                                                           // Leading-zero identifiers stay text.
        assert!(matches!(kind("007"), CellValue::Text(_)));
    }

    #[test]
    fn small_decimals_are_float() {
        assert!(matches!(kind("3.14"), CellValue::Float(_)));
        assert!(matches!(kind("-0.5"), CellValue::Float(_)));
        assert!(matches!(kind("1e3"), CellValue::Float(_)));
        assert!(matches!(kind(".5"), CellValue::Float(_)));
    }

    #[test]
    fn big_numeric_is_lossless_raw_not_rounded_float() {
        // The bug this whole audit found: a big numeric must NOT become a
        // rounded f64. It stays exact as Raw.
        match kind("12345678901234567890.123") {
            CellValue::Raw(s) => assert_eq!(s, "12345678901234567890.123"),
            other => panic!("expected lossless Raw, got {other:?}"),
        }
        // Integer too big for i64, arrives as numeric text.
        match kind("123456789012345678901234567890") {
            CellValue::Raw(s) => assert_eq!(s, "123456789012345678901234567890"),
            other => panic!("expected Raw, got {other:?}"),
        }
        // High-scale decimal whose extra precision f64 can't hold.
        assert!(matches!(kind("1.00000000000000001"), CellValue::Raw(_)));
    }

    #[test]
    fn non_numbers_stay_text() {
        assert!(matches!(kind("hello"), CellValue::Text(_)));
        assert!(matches!(kind(""), CellValue::Text(_)));
        assert!(matches!(kind("2024-01-15 10:30:00"), CellValue::Text(_)));
        assert!(matches!(
            kind("550e8400-e29b-41d4-a716-446655440000"),
            CellValue::Text(_)
        ));
        assert!(matches!(kind("\\x48656c6c6f"), CellValue::Text(_))); // bytea
        assert!(matches!(kind("$1,000.50"), CellValue::Text(_))); // money
        assert!(matches!(kind("{1,2,3}"), CellValue::Text(_))); // PG array literal
        assert!(matches!(kind("Infinity"), CellValue::Text(_)));
        assert!(matches!(kind("NaN"), CellValue::Text(_)));
        // Malformed number-ish tokens must not sneak through as numbers.
        assert!(matches!(kind("1e"), CellValue::Text(_)));
        assert!(matches!(kind("1.2.3"), CellValue::Text(_)));
        assert!(matches!(kind("--1"), CellValue::Text(_)));
    }

    #[test]
    fn json_objects_and_arrays_are_documents() {
        assert!(matches!(kind(r#"{"a":1}"#), CellValue::Document(_)));
        assert!(matches!(kind("[1,2,3]"), CellValue::Document(_)));
    }
}
