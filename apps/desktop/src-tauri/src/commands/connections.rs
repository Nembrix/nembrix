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
    if let Some(pw) = input.password.as_deref() {
        secrets::put_secret(id, SecretSlot::DbPassword, pw).map_err(|e| e.to_string())?;
    }
    if let Some(ssh) = input.ssh.as_ref() {
        if let Some(pw) = ssh.password.as_deref() {
            secrets::put_secret(id, SecretSlot::SshPassword, pw).map_err(|e| e.to_string())?;
        }
        if let Some(pp) = ssh.key_passphrase.as_deref() {
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
    if low.contains("password authentication failed") || low.contains("invalid_password") {
        return "Authentication failed — check the user and password.".into();
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
    {
        return "Host not reachable — check the host name.".into();
    }
    // Fallback: first line, trimmed to a sensible length for the small area.
    let first = raw.lines().next().unwrap_or(raw).trim();
    if first.chars().count() > 120 {
        format!("{}…", first.chars().take(119).collect::<String>())
    } else {
        first.to_string()
    }
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
                // Postgres has its own statement timeout knob; the connect
                // timeout used by test_connection doesn't map onto it, so we
                // keep its prior behaviour (5s statement timeout on test).
                statement_timeout_ms: connect_timeout_ms.map(|_| 5_000),
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
        let auth = match ssh.auth_kind.as_str() {
            "password" => SshAuth::Password {
                password: ssh.password.clone().unwrap_or_default(),
            },
            "key_file" => SshAuth::KeyFile {
                path: ssh.key_path.clone().ok_or("missing key path")?,
                passphrase: ssh.key_passphrase.clone(),
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

    let db = build_driver(
        &input.engine,
        host,
        port,
        &input.username,
        input.password,
        input.database,
        &input.ssl_mode,
        "nembrix-test",
        Some(5_000),
    )
    .await?;
    db.ping().await.map_err(|e| e.to_string())?;
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
            (
                "failed to lookup address information: nodename nor servname provided",
                "reachable",
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
            "some totally unrecognized multi-line error"
        );
    }
}
