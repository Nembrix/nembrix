use crate::state::{AppState, LiveConn};
use chrono::Utc;
use db_core::DynConn;
use db_mongo::{MongoConfig, MongoConn};
use db_postgres::{PgConfig, PgConn, PgSsl};
use secrets::{ConnectionRecord, SecretSlot, SshRecord};
use serde::{Deserialize, Serialize};
use specta::Type;
use ssh_tunnel::{SshAuth, Tunnel, TunnelConfig, TunnelError};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConnectionInput {
    pub id: Option<Uuid>,
    pub name: String,
    pub engine: String, // "postgres"
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: String,
    pub ssh: Option<SshInput>,
    pub color: Option<String>,
    pub environment: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshInput {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    pub strict_host_key: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionRecord>, String> {
    state.store.list_connections().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn save_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> Result<ConnectionRecord, String> {
    let id = input.id.unwrap_or_else(Uuid::new_v4);
    let now = Utc::now();
    let rec = ConnectionRecord {
        id,
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        username: input.username,
        database: input.database,
        ssl_mode: input.ssl_mode,
        ssh: input.ssh.as_ref().map(|s| SshRecord {
            host: s.host.clone(),
            port: s.port,
            user: s.user.clone(),
            auth_kind: s.auth_kind.clone(),
            key_path: s.key_path.clone(),
            strict_host_key: s.strict_host_key,
        }),
        color: input.color,
        environment: input.environment,
        group: input.group,
        created_at: now,
        updated_at: now,
    };
    state
        .store
        .upsert_connection(&rec)
        .map_err(|e| e.to_string())?;
    // Only (over)write a secret when the form actually supplies a non-empty
    // value. Editing an existing connection re-opens the form with the
    // password blanked (we never read secrets back into the UI), so an empty
    // field means "keep the stored one" — NOT "set it to empty". Writing the
    // empty string here would wipe the real keychain password and break the
    // next connect.
    if let Some(pw) = input.password.as_deref().filter(|p| !p.is_empty()) {
        secrets::put_secret(id, SecretSlot::DbPassword, pw).map_err(|e| e.to_string())?;
    }
    if let Some(ssh) = input.ssh.as_ref() {
        if let Some(pw) = ssh.password.as_deref().filter(|p| !p.is_empty()) {
            secrets::put_secret(id, SecretSlot::SshPassword, pw).map_err(|e| e.to_string())?;
        }
        if let Some(pp) = ssh.key_passphrase.as_deref().filter(|p| !p.is_empty()) {
            secrets::put_secret(id, SecretSlot::SshKeyPassphrase, pp).map_err(|e| e.to_string())?;
        }
    }
    Ok(rec)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_connection(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let mut g = state.conns.write().await;
    g.remove(&id); // also drops any live pool/tunnel
    drop(g);
    state.store.delete_connection(id).map_err(|e| e.to_string())
}

/// Open a live connection. Sets up the SSH tunnel first (when configured),
/// then connects the Postgres driver to either `host:port` or the tunnel's
/// `127.0.0.1:<local_port>`.
#[tauri::command]
#[specta::specta]
pub async fn connect(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let recs = state.store.list_connections().map_err(|e| e.to_string())?;
    let rec = recs
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "connection not found".to_string())?;

    let db_password = secrets::get_secret(id, SecretSlot::DbPassword).map_err(|e| e.to_string())?;

    let (host, port, tunnel) = if let Some(ssh) = rec.ssh.as_ref() {
        let auth = build_ssh_auth(id, ssh)?;
        let tcfg = TunnelConfig {
            ssh_host: ssh.host.clone(),
            ssh_port: ssh.port,
            ssh_user: ssh.user.clone(),
            auth,
            db_host: rec.host.clone(),
            db_port: rec.port,
            strict_host_key: ssh.strict_host_key,
        };
        let handle = Tunnel::open(tcfg).await.map_err(map_tunnel_err)?;
        let local_port = handle.local_port();
        ("127.0.0.1".to_string(), local_port, Some(handle))
    } else {
        (rec.host.clone(), rec.port, None)
    };

    let db = build_driver(
        &rec.engine,
        host,
        port,
        &rec.username,
        db_password,
        rec.database.clone(),
        &rec.ssl_mode,
        "nembrix",
        None,
    )
    .await?;

    state
        .conns
        .write()
        .await
        .insert(id, LiveConn { db, tunnel });
    Ok(())
}

/// Condense a verbose driver connect error into a short, human message —
/// the Test-connection status area is small, so raw sqlx/tokio strings (which
/// can be a paragraph long) don't fit. Falls back to a trimmed first line.
///
/// The TLS case: sqlx only raises "server does not support TLS" when the SSL
/// mode requires TLS (require/verify-*) but the server has it off — "prefer"
/// would silently fall back — so the actionable fix is to relax the SSL mode.
fn short_connect_error(raw: &str) -> String {
    let low = raw.to_lowercase();
    if low.contains("server does not support tls") {
        return "Server has no TLS — set SSL to \"prefer\" or \"disable\".".into();
    }
    // Mongo TLS mismatches: the client sent a TLS handshake to a plaintext
    // server, or vice-versa. Both surface as a garbled handshake / TLS error.
    if low.contains("tls")
        && (low.contains("handshake")
            || low.contains("alert")
            || low.contains("not enabled")
            || low.contains("required")
            || low.contains("wrong version")
            || low.contains("record overflow"))
    {
        return "TLS mismatch — toggle SSL to match the server (on vs off).".into();
    }
    if low.contains("password authentication failed") || low.contains("invalid_password") {
        return "Authentication failed — check the user and password.".into();
    }
    if low.contains("no pool configured") {
        // PgBouncer (or a similar pooler) has no pool registered for this
        // database/user — a server-side config issue, not a Nembrix one.
        return "No connection pool for this database on the server (pooler config).".into();
    }
    if low.contains("does not exist") && low.contains("database") {
        return "Database not found — check the database name.".into();
    }
    if low.contains("connection refused") {
        return "Connection refused — check the host and port.".into();
    }
    if low.contains("timed out") || low.contains("timeout") {
        return "Connection timed out — check the host, port, and network.".into();
    }
    if low.contains("no route to host")
        || low.contains("name or service not known")
        || low.contains("failed to lookup")
        || low.contains("nodename nor servname")
        || low.contains("temporary failure in name resolution")
    {
        return "Host not reachable — check the host name.".into();
    }
    if low.contains("role") && low.contains("does not exist") {
        return "User not found — check the username.".into();
    }
    if low.contains("no encryption") || low.contains("ssl is not enabled") {
        return "Server requires SSL — set SSL to \"require\".".into();
    }
    if low.contains("connection reset") || low.contains("broken pipe") {
        return "Server closed the connection — check SSL mode and the port.".into();
    }
    // Postgres' own phrasing only ("permission denied for database …"). A bare
    // "permission denied" is too broad — it's also how an OS-level file or
    // socket error reads, where advice about database rights would misdirect.
    if low.contains("permission denied for") {
        return "Permission denied — check the user's access rights.".into();
    }
    if low.contains("network is unreachable") {
        return "Network unreachable — check your internet connection.".into();
    }

    // Fallback. We only get here when nothing above matched, which in practice
    // means a driver-internal string the user can do nothing with — so lead
    // with something actionable rather than echoing plumbing like
    // "Error occurred while creating a new object: error connecting to server".
    let first = raw
        .lines()
        .next()
        .unwrap_or(raw)
        .trim()
        // Wrapper layers that carry no information for a user.
        .trim_start_matches("Error occurred while creating a new object:")
        .trim_start_matches("error connecting to server:")
        .trim();
    if first.is_empty() || is_driver_noise(first) {
        return "Could not connect — check the host, port, and credentials.".into();
    }
    let detail = if first.chars().count() > 100 {
        format!("{}…", first.chars().take(99).collect::<String>())
    } else {
        first.to_string()
    };
    format!("Could not connect — {detail}")
}

/// True when a leftover fallback string is pure driver plumbing: it names no
/// cause, so pairing it with the generic advice would just add noise.
fn is_driver_noise(s: &str) -> bool {
    let low = s.to_lowercase();
    matches!(
        low.trim_end_matches('.'),
        "error connecting to server"
            | "error occurred while creating a new object"
            | "connection error"
            | "db error"
            | "io error"
            | "error"
    ) || low.starts_with("kind: ")
}

/// Construct a live driver for an engine. Shared by `connect` (long-lived,
/// no timeout) and `test_connection` (short-lived, with a connect timeout so
/// an unreachable host fails fast). Returns the engine-agnostic `DynConn` the
/// rest of the app speaks to.
#[allow(clippy::too_many_arguments)]
async fn build_driver(
    engine: &str,
    host: String,
    port: u16,
    username: &str,
    password: Option<String>,
    database: Option<String>,
    ssl_mode: &str,
    app_name: &str,
    connect_timeout_ms: Option<u64>,
) -> Result<DynConn, String> {
    match engine {
        "postgres" => {
            let ssl_mode = match ssl_mode {
                "disable" => PgSsl::Disable,
                "require" => PgSsl::Require,
                _ => PgSsl::Prefer,
            };
            let pg = PgConn::connect(PgConfig {
                host,
                port,
                user: username.to_string(),
                password,
                database,
                ssl_mode,
                application_name: Some(app_name.to_string()),
                // test_connection wants a short session statement timeout too,
                // so a hung first query on Test doesn't sit forever.
                statement_timeout_ms: connect_timeout_ms.map(|_| 5_000),
                // Hard wall-clock bound on the whole handshake. Test passes a
                // short one (fail fast); a live connect uses the driver default.
                connect_timeout_ms: connect_timeout_ms.map(|ms| ms as u32),
            })
            .await
            .map_err(|e| short_connect_error(&e.to_string()))?;
            Ok(pg as DynConn)
        }
        "mongo" => {
            // Mongo has no libpq-style ssl_mode ladder — anything other than
            // "disable" turns TLS on. `username` empty ⇒ unauthenticated.
            let mongo = MongoConn::connect(MongoConfig {
                host,
                port,
                user: (!username.is_empty()).then(|| username.to_string()),
                password,
                database,
                // Credentials are checked against `admin` unless the
                // connection itself targets another auth database. The
                // connection form doesn't expose authSource yet, so default
                // it; advanced users can switch via runCommand once in.
                auth_source: Some("admin".to_string()),
                tls: ssl_mode != "disable",
                app_name: Some(app_name.to_string()),
                connect_timeout_ms,
            })
            .await
            .map_err(|e| short_connect_error(&e.to_string()))?;
            Ok(mongo as DynConn)
        }
        other => Err(format!("unsupported engine: {other}")),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let mut g = state.conns.write().await;
    if let Some(live) = g.remove(&id) {
        drop(live.db);
        if let Some(t) = live.tunnel {
            t.shutdown().await;
        }
    }
    Ok(())
}

/// Test a not-yet-saved connection. Mirrors `connect` but tears everything
/// down immediately so we don't pollute AppState.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(input: ConnectionInput) -> Result<u64, String> {
    let started = std::time::Instant::now();
    let (host, port, _tunnel) = if let Some(ssh) = input.ssh.as_ref() {
        // Like the DB password, SSH secrets are blanked when the form re-opens
        // for editing — fall back to the keychain when the field is empty and
        // we have a saved id.
        let stored = |slot: SecretSlot| {
            input
                .id
                .and_then(|id| secrets::get_secret(id, slot).ok().flatten())
        };
        let ssh_password = match ssh.password.as_deref() {
            Some(p) if !p.is_empty() => ssh.password.clone(),
            _ => stored(SecretSlot::SshPassword),
        };
        let ssh_passphrase = match ssh.key_passphrase.as_deref() {
            Some(p) if !p.is_empty() => ssh.key_passphrase.clone(),
            _ => stored(SecretSlot::SshKeyPassphrase),
        };
        let auth = match ssh.auth_kind.as_str() {
            "password" => SshAuth::Password {
                password: ssh_password.unwrap_or_default(),
            },
            "key_file" => SshAuth::KeyFile {
                path: ssh.key_path.clone().ok_or("missing key path")?,
                passphrase: ssh_passphrase,
            },
            _ => SshAuth::Agent,
        };
        let cfg = TunnelConfig {
            ssh_host: ssh.host.clone(),
            ssh_port: ssh.port,
            ssh_user: ssh.user.clone(),
            auth,
            db_host: input.host.clone(),
            db_port: input.port,
            strict_host_key: ssh.strict_host_key,
        };
        let handle = Tunnel::open(cfg).await.map_err(map_tunnel_err)?;
        ("127.0.0.1".to_string(), handle.local_port(), Some(handle))
    } else {
        (input.host.clone(), input.port, None)
    };

    // When editing a saved connection, the form re-opens with the password
    // blanked (we never read secrets back into the UI). So an empty password
    // on an input that already has an id means "use the stored one" — fall
    // back to the keychain rather than testing with an empty password (which
    // would spuriously fail with "authentication failed").
    let password = match input.password {
        Some(ref p) if !p.is_empty() => input.password.clone(),
        _ => match input.id {
            Some(id) => secrets::get_secret(id, SecretSlot::DbPassword)
                .ok()
                .flatten(),
            None => input.password.clone(),
        },
    };

    let db = build_driver(
        &input.engine,
        host,
        port,
        &input.username,
        password,
        input.database,
        &input.ssl_mode,
        "nembrix-test",
        Some(5_000),
    )
    .await?;
    // Mongo (and other lazy drivers) don't actually reach the server during
    // build_driver — the real failure surfaces here on ping. Condense it the
    // same way so a paragraph-long "Server selection timeout … Topology { … }"
    // dump becomes a one-line, human message instead of leaking raw.
    db.ping()
        .await
        .map_err(|e| short_connect_error(&e.to_string()))?;
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
#[specta::specta]
pub async fn trust_ssh_host(host: String, fingerprint: String) -> Result<(), String> {
    ssh_tunnel::trust_host(&host, &fingerprint).map_err(|e| e.to_string())
}

fn build_ssh_auth(id: Uuid, ssh: &SshRecord) -> Result<SshAuth, String> {
    Ok(match ssh.auth_kind.as_str() {
        "password" => SshAuth::Password {
            password: secrets::get_secret(id, SecretSlot::SshPassword)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
        },
        "key_file" => SshAuth::KeyFile {
            path: ssh.key_path.clone().ok_or("missing key path")?,
            passphrase: secrets::get_secret(id, SecretSlot::SshKeyPassphrase)
                .map_err(|e| e.to_string())?,
        },
        _ => SshAuth::Agent,
    })
}

fn map_tunnel_err(e: TunnelError) -> String {
    // The frontend pattern-matches on a typed prefix to surface TOFU prompts.
    match e {
        TunnelError::UnknownHost {
            host,
            fingerprint,
            alg,
        } => {
            format!("UNKNOWN_HOST::{host}::{fingerprint}::{alg}")
        }
        TunnelError::HostKeyMismatch { host } => format!("HOST_KEY_MISMATCH::{host}"),
        TunnelError::AuthFailed => "AUTH_FAILED".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::short_connect_error;

    #[test]
    fn tls_required_but_unavailable_is_short_and_actionable() {
        let raw = "error occurred while attempting to establish a TLS \
                   connection: server does not support TLS";
        let out = short_connect_error(raw);
        assert!(out.contains("prefer"), "should suggest a fix: {out}");
        assert!(
            out.chars().count() <= 60,
            "too long for the status area: {out}"
        );
    }

    #[test]
    fn common_errors_map_to_short_messages() {
        for (raw, needle) in [
            (
                "FATAL: password authentication failed for user \"x\"",
                "Authentication",
            ),
            ("Connection refused (os error 61)", "refused"),
            ("connection timed out", "timed out"),
            ("FATAL: No pool configured for database: \"x\"", "pool"),
            (
                "failed to lookup address information: nodename nor servname provided",
                "reachable",
            ),
            // The full mongodb driver dump — a paragraph that must condense to
            // a one-liner, not leak the Topology { … } internals.
            (
                "Kind: Server selection timeout: No available servers. Topology: \
                 { Type: Unknown, Servers: [ { Address: 127.0.0.1:27017, Type: \
                 Unknown, Error: Kind: I/O error: Connection refused (os error 61) } ] }",
                "refused",
            ),
        ] {
            let out = short_connect_error(raw);
            assert!(out.contains(needle), "{raw:?} -> {out:?} (want {needle})");
            assert!(out.chars().count() <= 80);
        }
    }

    #[test]
    fn unknown_error_falls_back_to_trimmed_first_line() {
        let raw = "some totally unrecognized multi-line error\nsecond line ignored";
        assert_eq!(
            short_connect_error(raw),
            "Could not connect — some totally unrecognized multi-line error"
        );
    }

    /// The bug this guards: deadpool + tokio-postgres wrap the real cause in
    /// two layers that name nothing. Flattened via `db_core::error_chain`, the
    /// cause is present and must drive the message.
    #[test]
    fn deadpool_wrapped_errors_classify_on_the_inner_cause() {
        for (raw, needle) in [
            (
                "Error occurred while creating a new object: error connecting to server: \
                 Connection refused (os error 61)",
                "refused",
            ),
            (
                "Error occurred while creating a new object: error connecting to server: \
                 failed to lookup address information: nodename nor servname provided",
                "reachable",
            ),
            (
                "Error occurred while creating a new object: db error: FATAL: password \
                 authentication failed for user \"x\"",
                "Authentication",
            ),
        ] {
            let out = short_connect_error(raw);
            assert!(out.contains(needle), "{raw:?} -> {out:?} (want {needle})");
            assert!(!out.contains("creating a new object"), "leaked: {out}");
        }
    }

    /// If the chain really is content-free, say something useful rather than
    /// echoing the plumbing verbatim — the exact case in the bug report.
    #[test]
    fn bare_driver_noise_becomes_generic_advice() {
        for raw in [
            "Error occurred while creating a new object: error connecting to server",
            "error connecting to server",
            "Error occurred while creating a new object:",
        ] {
            let out = short_connect_error(raw);
            assert_eq!(
                out,
                "Could not connect — check the host, port, and credentials."
            );
        }
    }

    #[test]
    fn every_message_fits_the_status_area() {
        let long = format!(
            "Error occurred while creating a new object: {}",
            "x".repeat(500)
        );
        let out = short_connect_error(&long);
        assert!(
            out.chars().count() <= 120,
            "too long ({}): {out}",
            out.chars().count()
        );
    }
}
