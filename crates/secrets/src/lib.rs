//! Secrets + connection-metadata layer.
//!
//! - Secret strings (DB password, SSH password, SSH key passphrase) live in
//!   the OS keychain via `keyring-rs`, keyed by `conn:<uuid>:<slot>`.
//! - Everything else (connection metadata, query history, saved queries,
//!   open tabs) lives in a local SQLite file at `app_data_dir()/metadata.db`.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use thiserror::Error;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "dev.nembrix.app";

#[derive(Debug, Error)]
pub enum SecretsError {
    #[error("keyring: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("not found")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, SecretsError>;

#[derive(Debug, Clone, Copy)]
pub enum SecretSlot {
    DbPassword,
    SshPassword,
    SshKeyPassphrase,
}

impl SecretSlot {
    fn as_str(self) -> &'static str {
        match self {
            SecretSlot::DbPassword => "db_password",
            SecretSlot::SshPassword => "ssh_password",
            SecretSlot::SshKeyPassphrase => "ssh_key_passphrase",
        }
    }
}

fn keyring_key(conn_id: Uuid, slot: SecretSlot) -> String {
    format!("conn:{conn_id}:{}", slot.as_str())
}

pub fn put_secret(conn_id: Uuid, slot: SecretSlot, value: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_key(conn_id, slot))?;
    entry.set_password(value)?;
    Ok(())
}

pub fn get_secret(conn_id: Uuid, slot: SecretSlot) -> Result<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_key(conn_id, slot))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretsError::Keyring(e)),
    }
}

pub fn delete_secret(conn_id: Uuid, slot: SecretSlot) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_key(conn_id, slot))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretsError::Keyring(e)),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConnectionRecord {
    pub id: Uuid,
    pub name: String,
    pub engine: String, // "postgres" for v1
    pub host: String,
    pub port: u16,
    pub username: String,
    pub database: Option<String>,
    pub ssl_mode: String, // "disable" | "prefer" | "require"
    pub ssh: Option<SshRecord>,
    pub color: Option<String>,
    /// "production" | "staging" | "development" | "test" | "other".
    /// Optional for backwards compatibility with v1 records.
    pub environment: Option<String>,
    /// Optional free-form group label — used to organize the connection
    /// manager dialog into TablePlus-style collapsible sections.
    pub group: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshRecord {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: String, // "password" | "key_file" | "agent"
    pub key_path: Option<String>,
    pub strict_host_key: bool,
}

// `rusqlite::Connection` is Send but not Sync (it holds a RefCell), so
// putting it directly into a Tauri `State<Store>` fails the Sync bound.
// Wrap it in a Mutex so concurrent IPC calls can lock it sequentially.
// SQLite itself serializes writes anyway, so the lock contention is a
// non-issue at our query volume.
pub struct Store {
    db: std::sync::Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&db)?;
        Ok(Self { db: std::sync::Mutex::new(db) })
    }

    pub fn list_connections(&self) -> Result<Vec<ConnectionRecord>> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(
            "SELECT id, name, engine, host, port, username, database, ssl_mode,
                    ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path, ssh_strict,
                    color, created_at, updated_at, environment, \"group\"
             FROM connections ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            let ssh_host: Option<String> = r.get(8)?;
            let ssh = ssh_host.map(|host| SshRecord {
                host,
                port: r.get::<_, i64>(9).unwrap_or(22) as u16,
                user: r.get::<_, String>(10).unwrap_or_default(),
                auth_kind: r.get::<_, String>(11).unwrap_or_else(|_| "password".into()),
                key_path: r.get::<_, Option<String>>(12).unwrap_or(None),
                strict_host_key: r.get::<_, i64>(13).unwrap_or(0) != 0,
            });
            let id_str: String = r.get(0)?;
            let created_at: String = r.get(15)?;
            let updated_at: String = r.get(16)?;
            Ok(ConnectionRecord {
                id: Uuid::parse_str(&id_str).unwrap_or_default(),
                name: r.get(1)?,
                engine: r.get(2)?,
                host: r.get(3)?,
                port: r.get::<_, i64>(4)? as u16,
                username: r.get(5)?,
                database: r.get(6)?,
                ssl_mode: r.get(7)?,
                ssh,
                color: r.get(14)?,
                environment: r.get::<_, Option<String>>(17).unwrap_or(None),
                group: r.get::<_, Option<String>>(18).unwrap_or(None),
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                updated_at: updated_at.parse().unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn upsert_connection(&self, c: &ConnectionRecord) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO connections
                 (id, name, engine, host, port, username, database, ssl_mode,
                  ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path, ssh_strict,
                  color, created_at, updated_at, environment, \"group\")
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                     ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 engine=excluded.engine,
                 host=excluded.host,
                 port=excluded.port,
                 username=excluded.username,
                 database=excluded.database,
                 ssl_mode=excluded.ssl_mode,
                 ssh_host=excluded.ssh_host,
                 ssh_port=excluded.ssh_port,
                 ssh_user=excluded.ssh_user,
                 ssh_auth_kind=excluded.ssh_auth_kind,
                 ssh_key_path=excluded.ssh_key_path,
                 ssh_strict=excluded.ssh_strict,
                 color=excluded.color,
                 environment=excluded.environment,
                 \"group\"=excluded.\"group\",
                 updated_at=excluded.updated_at",
            params![
                c.id.to_string(),
                c.name,
                c.engine,
                c.host,
                c.port as i64,
                c.username,
                c.database,
                c.ssl_mode,
                c.ssh.as_ref().map(|s| s.host.clone()),
                c.ssh.as_ref().map(|s| s.port as i64),
                c.ssh.as_ref().map(|s| s.user.clone()),
                c.ssh.as_ref().map(|s| s.auth_kind.clone()),
                c.ssh.as_ref().and_then(|s| s.key_path.clone()),
                c.ssh.as_ref().map(|s| s.strict_host_key as i64).unwrap_or(0),
                c.color,
                c.created_at.to_rfc3339(),
                c.updated_at.to_rfc3339(),
                c.environment,
                c.group,
            ],
        )?;
        Ok(())
    }

    pub fn delete_connection(&self, id: Uuid) -> Result<()> {
        self.db.lock().unwrap()
            .execute("DELETE FROM connections WHERE id = ?1", params![id.to_string()])?;
        let _ = delete_secret(id, SecretSlot::DbPassword);
        let _ = delete_secret(id, SecretSlot::SshPassword);
        let _ = delete_secret(id, SecretSlot::SshKeyPassphrase);
        Ok(())
    }

    pub fn record_query(&self, conn_id: Uuid, sql: &str, elapsed_ms: u64) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO query_history (id, conn_id, sql, elapsed_ms, run_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                Uuid::new_v4().to_string(),
                conn_id.to_string(),
                sql,
                elapsed_ms as i64,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn query_history(&self, conn_id: Uuid, limit: u32) -> Result<Vec<HistoryEntry>> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(
            "SELECT sql, elapsed_ms, run_at FROM query_history
             WHERE conn_id = ?1 ORDER BY run_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![conn_id.to_string(), limit as i64], |r| {
            let run_at: String = r.get(2)?;
            Ok(HistoryEntry {
                sql: r.get(0)?,
                elapsed_ms: r.get::<_, i64>(1)? as u64,
                run_at: run_at.parse().unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_known_host_fp(&self, host: &str) -> Result<Option<String>> {
        let db = self.db.lock().unwrap();
        let v = db
            .query_row(
                "SELECT fingerprint FROM known_hosts WHERE host = ?1",
                params![host],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn list_saved_queries(&self, conn_id: Option<Uuid>) -> Result<Vec<SavedRow>> {
        let (sql, args): (&str, Vec<rusqlite::types::Value>) = match conn_id {
            Some(id) => (
                "SELECT id, conn_id, name, sql, created_at, updated_at
                 FROM saved_queries
                 WHERE conn_id IS NULL OR conn_id = ?1
                 ORDER BY updated_at DESC",
                vec![id.to_string().into()],
            ),
            None => (
                "SELECT id, conn_id, name, sql, created_at, updated_at
                 FROM saved_queries
                 ORDER BY updated_at DESC",
                vec![],
            ),
        };
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            let id: String = r.get(0)?;
            let conn_id: Option<String> = r.get(1)?;
            let created_at: String = r.get(4)?;
            let updated_at: String = r.get(5)?;
            Ok(SavedRow {
                id: Uuid::parse_str(&id).unwrap_or_default(),
                conn_id: conn_id.and_then(|s| Uuid::parse_str(&s).ok()),
                name: r.get(2)?,
                sql: r.get(3)?,
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                updated_at: updated_at.parse().unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn upsert_saved_query(
        &self,
        id: Uuid,
        conn_id: Option<Uuid>,
        name: &str,
        sql: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO saved_queries (id, conn_id, name, sql, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 sql=excluded.sql,
                 conn_id=excluded.conn_id,
                 updated_at=excluded.updated_at",
            params![
                id.to_string(),
                conn_id.map(|c| c.to_string()),
                name,
                sql,
                now.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn delete_saved_query(&self, id: Uuid) -> Result<()> {
        self.db.lock().unwrap()
            .execute("DELETE FROM saved_queries WHERE id = ?1", params![id.to_string()])?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SavedRow {
    pub id: Uuid,
    pub conn_id: Option<Uuid>,
    pub name: String,
    pub sql: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HistoryEntry {
    pub sql: String,
    pub elapsed_ms: u64,
    pub run_at: DateTime<Utc>,
}

fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            engine TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            database TEXT,
            ssl_mode TEXT NOT NULL DEFAULT 'prefer',
            ssh_host TEXT, ssh_port INTEGER, ssh_user TEXT,
            ssh_auth_kind TEXT, ssh_key_path TEXT, ssh_strict INTEGER DEFAULT 0,
            color TEXT,
            environment TEXT,
            "group" TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS query_history (
            id TEXT PRIMARY KEY,
            conn_id TEXT NOT NULL,
            sql TEXT NOT NULL,
            elapsed_ms INTEGER NOT NULL,
            run_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_qhist_conn_run ON query_history(conn_id, run_at);
        CREATE TABLE IF NOT EXISTS saved_queries (
            id TEXT PRIMARY KEY,
            conn_id TEXT,
            name TEXT NOT NULL,
            sql TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tabs (
            id TEXT PRIMARY KEY,
            conn_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT,
            payload TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS known_hosts (
            host TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            added_at TEXT NOT NULL
        );
        "#,
    )?;
    // Backfill column on databases created before the `environment` field existed.
    // SQLite has no IF NOT EXISTS on ADD COLUMN; ignore "duplicate column" errors.
    let _ = db.execute("ALTER TABLE connections ADD COLUMN environment TEXT", []);
    let _ = db.execute("ALTER TABLE connections ADD COLUMN \"group\" TEXT", []);
    Ok(())
}
