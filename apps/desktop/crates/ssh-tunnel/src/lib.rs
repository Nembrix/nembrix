//! SSH local-port-forwarding tunnel built on `russh`.
//!
//! Open a tunnel with [`Tunnel::open`] — it binds an ephemeral local port,
//! accepts connections, and pipes each one through a `direct-tcpip` channel
//! to `db_host:db_port`. Drivers then dial `localhost:<local_port>`.
//!
//! Auth: password, key file (RSA / Ed25519 / ECDSA, passphrase-protected),
//! and ssh-agent (SSH_AUTH_SOCK on unix, OpenSSH-on-Windows / Pageant on
//! Windows via russh-keys).
//!
//! Host-key verification is TOFU against Nembrix's own store,
//! `~/.ssh/nembrix_known_hosts` (not the user's OpenSSH `known_hosts`). An
//! unknown host returns [`TunnelError::UnknownHost`] with the fingerprint so
//! the frontend can prompt the user; a host whose stored key differs returns
//! [`TunnelError::HostKeyMismatch`] and is never offered for re-trust.

use russh::client::{self, Handle};
use russh::{ChannelMsg, Disconnect};
use russh_keys::{
    self as keys,
    key::{KeyPair as PrivateKey, PublicKey},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TunnelConfig {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub auth: SshAuth,
    pub db_host: String,
    pub db_port: u16,
    /// When true, refuse to connect if the host key is unknown
    /// ([`TunnelError::UntrustedHost`]). When false, unknown hosts return
    /// [`TunnelError::UnknownHost`] so the frontend can prompt; on user accept,
    /// call [`trust_host`] with the error's `host` before retrying.
    pub strict_host_key: bool,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuth {
    Password {
        password: String,
    },
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

/// Hand-written so a `{:?}` of a config (in a log line or a panic message)
/// never prints the password or key passphrase.
impl std::fmt::Debug for SshAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshAuth::Password { .. } => f.debug_struct("Password").finish_non_exhaustive(),
            SshAuth::KeyFile { path, passphrase } => f
                .debug_struct("KeyFile")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
            SshAuth::Agent => f.write_str("Agent"),
        }
    }
}

#[derive(Debug, Error)]
pub enum TunnelError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("ssh: {0}")]
    Ssh(#[from] russh::Error),
    #[error("key: {0}")]
    Key(#[from] russh_keys::Error),
    #[error("authentication failed")]
    AuthFailed,
    #[error("unknown host {host}: fingerprint {fingerprint} (alg={alg})")]
    UnknownHost {
        host: String,
        fingerprint: String,
        alg: String,
    },
    #[error("host key mismatch for {host}")]
    HostKeyMismatch { host: String },
    #[error("host {host} is not in the trusted host list")]
    UntrustedHost { host: String },
    #[error("agent unavailable")]
    AgentUnavailable,
}

pub struct TunnelHandle {
    /// Local 127.0.0.1 port the driver should connect to.
    pub local_port: u16,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl TunnelHandle {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(t) = self.task.take() {
            let _ = t.await;
        }
    }
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

pub struct Tunnel;

impl Tunnel {
    /// Open a local-port-forwarding tunnel. Returns once the SSH session is
    /// authenticated and the listener is bound — caller can immediately
    /// connect the DB driver to `127.0.0.1:<local_port>`.
    pub async fn open(cfg: TunnelConfig) -> Result<TunnelHandle, TunnelError> {
        let handler = TofuHandler {
            host: known_hosts::host_key(&cfg.ssh_host, cfg.ssh_port),
            strict: cfg.strict_host_key,
        };
        let client_cfg = Arc::new(client::Config::default());
        let mut session =
            client::connect(client_cfg, (cfg.ssh_host.as_str(), cfg.ssh_port), handler).await?;

        authenticate(&mut session, &cfg).await?;

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local_port = listener.local_addr()?.port();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let session = Arc::new(session);
        let db_host = cfg.db_host.clone();
        let db_port = cfg.db_port;

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = task_cancel.cancelled() => {
                        debug!("tunnel cancelled");
                        let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
                        return;
                    }
                    accept = listener.accept() => {
                        let (sock, peer) = match accept {
                            Ok(p) => p,
                            Err(e) => { warn!(?e, "accept failed"); return; }
                        };
                        let session = Arc::clone(&session);
                        let db_host = db_host.clone();
                        tokio::spawn(async move {
                            if let Err(e) = forward(session, sock, peer, &db_host, db_port).await {
                                warn!(?e, "forward terminated");
                            }
                        });
                    }
                }
            }
        });

        Ok(TunnelHandle {
            local_port,
            cancel,
            task: Some(task),
        })
    }
}

async fn authenticate(
    session: &mut Handle<TofuHandler>,
    cfg: &TunnelConfig,
) -> Result<(), TunnelError> {
    let ok = match &cfg.auth {
        SshAuth::Password { password } => {
            session
                .authenticate_password(&cfg.ssh_user, password)
                .await?
        }
        SshAuth::KeyFile { path, passphrase } => {
            let key: PrivateKey =
                keys::load_secret_key(PathBuf::from(path), passphrase.as_deref())?;
            session
                .authenticate_publickey(&cfg.ssh_user, Arc::new(key))
                .await?
        }
        SshAuth::Agent => {
            let mut agent = russh_keys::agent::client::AgentClient::connect_env()
                .await
                .map_err(|_| TunnelError::AgentUnavailable)?;
            let identities = agent
                .request_identities()
                .await
                .map_err(|_| TunnelError::AgentUnavailable)?;
            let mut auth_ok = false;
            for id in identities {
                // russh 0.43 renamed `authenticate_future_publickey` to
                // `authenticate_future`. Same shape: returns the signer
                // back (it gets moved through the channel internals) and
                // a `Result<bool, _>` for the auth outcome.
                let (a, res) = session.authenticate_future(&cfg.ssh_user, id, agent).await;
                agent = a;
                match res {
                    Ok(true) => {
                        auth_ok = true;
                        break;
                    }
                    Ok(false) => continue,
                    Err(_) => continue,
                }
            }
            auth_ok
        }
    };
    if ok {
        Ok(())
    } else {
        Err(TunnelError::AuthFailed)
    }
}

async fn forward(
    session: Arc<Handle<TofuHandler>>,
    mut sock: TcpStream,
    peer: SocketAddr,
    db_host: &str,
    db_port: u16,
) -> Result<(), TunnelError> {
    let mut channel = session
        .channel_open_direct_tcpip(
            db_host,
            db_port as u32,
            &peer.ip().to_string(),
            peer.port() as u32,
        )
        .await?;

    let (mut sock_r, mut sock_w) = sock.split();
    let mut buf = vec![0u8; 32 * 1024];

    loop {
        tokio::select! {
            // Local TCP → SSH channel
            n = sock_r.read(&mut buf) => {
                let n = n?;
                if n == 0 { let _ = channel.eof().await; break; }
                channel.data(&buf[..n]).await?;
            }
            // SSH channel → local TCP
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => sock_w.write_all(&data).await?,
                    Some(ChannelMsg::Eof) | None => break,
                    Some(ChannelMsg::Close) => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

struct TofuHandler {
    /// Store key for this endpoint — see [`known_hosts::host_key`].
    host: String,
    strict: bool,
}

#[async_trait::async_trait]
impl client::Handler for TofuHandler {
    type Error = TunnelError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = sha256_fingerprint(server_public_key);
        let alg = server_public_key.name().to_string();
        match known_hosts::lookup(&self.host, &fp) {
            known_hosts::Status::Trusted => Ok(true),
            // A different key than the one the user accepted: refuse outright.
            // Reporting this as "unknown" would invite a re-trust prompt.
            known_hosts::Status::Changed => Err(TunnelError::HostKeyMismatch {
                host: self.host.clone(),
            }),
            known_hosts::Status::Unknown if self.strict => Err(TunnelError::UntrustedHost {
                host: self.host.clone(),
            }),
            known_hosts::Status::Unknown => Err(TunnelError::UnknownHost {
                host: self.host.clone(),
                fingerprint: fp,
                alg,
            }),
        }
    }
}

fn sha256_fingerprint(key: &PublicKey) -> String {
    // russh 0.43+ moved `public_key_bytes` behind the PublicKeyBase64
    // trait. We bring it into scope locally rather than re-export
    // globally so the rest of the file isn't polluted with a
    // single-use trait import.
    use russh_keys::PublicKeyBase64;
    let bytes = key.public_key_bytes();
    let digest = Sha256::digest(&bytes);
    format!("SHA256:{}", base64_pad(&digest))
}

fn base64_pad(b: &[u8]) -> String {
    use std::fmt::Write;
    // tiny base64 without an extra dep
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= b.len() {
        let n = ((b[i] as u32) << 16) | ((b[i + 1] as u32) << 8) | (b[i + 2] as u32);
        for j in (0..4).rev() {
            s.push(T[((n >> (j * 6)) & 0x3f) as usize] as char);
        }
        i += 3;
    }
    let rem = b.len() - i;
    if rem == 1 {
        let n = (b[i] as u32) << 16;
        let _ = write!(
            s,
            "{}{}==",
            T[((n >> 18) & 0x3f) as usize] as char,
            T[((n >> 12) & 0x3f) as usize] as char
        );
    } else if rem == 2 {
        let n = ((b[i] as u32) << 16) | ((b[i + 1] as u32) << 8);
        let _ = write!(
            s,
            "{}{}{}=",
            T[((n >> 18) & 0x3f) as usize] as char,
            T[((n >> 12) & 0x3f) as usize] as char,
            T[((n >> 6) & 0x3f) as usize] as char,
        );
    }
    s
}

/// TOFU store at `~/.ssh/nembrix_known_hosts`: one `<host-key> <fingerprint>`
/// pair per line, SHA256-fingerprint match. Populated via the frontend's
/// accept dialog.
pub mod known_hosts {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::{BufRead, BufReader, Write};
    use std::path::Path;

    #[derive(Debug, PartialEq, Eq)]
    pub enum Status {
        /// The endpoint has an entry with this fingerprint.
        Trusted,
        /// The endpoint has entries, none with this fingerprint.
        Changed,
        /// No entry for the endpoint.
        Unknown,
    }

    fn path() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".ssh").join("nembrix_known_hosts"))
    }

    /// Store key for an SSH endpoint, OpenSSH-style: bare `host` on port 22,
    /// `[host]:port` otherwise — so two servers on one host don't share trust.
    pub fn host_key(host: &str, port: u16) -> String {
        if port == 22 {
            host.to_string()
        } else {
            format!("[{host}]:{port}")
        }
    }

    /// The bare host of a `[host]:port` key; `None` for a bare key.
    fn bare_host(key: &str) -> Option<&str> {
        key.strip_prefix('[')?.split_once("]:").map(|(h, _)| h)
    }

    pub fn lookup(key: &str, fingerprint: &str) -> Status {
        match path() {
            Some(p) => lookup_in(&p, key, fingerprint),
            None => Status::Unknown,
        }
    }

    pub(crate) fn lookup_in(p: &Path, key: &str, fingerprint: &str) -> Status {
        let Ok(f) = fs::File::open(p) else {
            return Status::Unknown;
        };
        let mut exact: Vec<String> = Vec::new();
        let mut legacy: Vec<String> = Vec::new();
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            let mut it = line.split_whitespace();
            if let (Some(h), Some(fp)) = (it.next(), it.next()) {
                if h == key {
                    exact.push(fp.to_string());
                } else if bare_host(key) == Some(h) {
                    // Entries written before the store was port-aware are keyed
                    // on the bare host whatever the port. Honour them for a
                    // non-22 endpoint that has no entry of its own yet.
                    legacy.push(fp.to_string());
                }
            }
        }
        let fps = if exact.is_empty() { legacy } else { exact };
        if fps.is_empty() {
            Status::Unknown
        } else if fps.iter().any(|fp| fp == fingerprint) {
            Status::Trusted
        } else {
            Status::Changed
        }
    }

    /// A value that can't break the one-pair-per-line format: non-empty, no
    /// whitespace or control characters.
    fn is_field(s: &str) -> bool {
        !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c.is_control())
    }

    pub fn trust(key: &str, fingerprint: &str) -> std::io::Result<()> {
        let p = path().ok_or_else(|| std::io::Error::other("no home dir"))?;
        trust_in(&p, key, fingerprint)
    }

    pub(crate) fn trust_in(p: &Path, key: &str, fingerprint: &str) -> std::io::Result<()> {
        if !is_field(key) || !is_field(fingerprint) || !fingerprint.starts_with("SHA256:") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid host or fingerprint",
            ));
        }
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new().create(true).append(true).open(p)?;
        writeln!(f, "{} {}", key, fingerprint)?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn store(name: &str, contents: &str) -> PathBuf {
            let p = std::env::temp_dir().join(format!("nembrix-kh-{}-{name}", std::process::id()));
            fs::write(&p, contents).unwrap();
            p
        }

        #[test]
        fn host_key_is_port_aware() {
            assert_eq!(host_key("db.example", 22), "db.example");
            assert_eq!(host_key("db.example", 2222), "[db.example]:2222");
        }

        #[test]
        fn lookup_distinguishes_trusted_changed_unknown() {
            let p = store(
                "status",
                "a.example SHA256:aaa\n[b.example]:2222 SHA256:bbb\n",
            );
            assert_eq!(lookup_in(&p, "a.example", "SHA256:aaa"), Status::Trusted);
            assert_eq!(lookup_in(&p, "a.example", "SHA256:zzz"), Status::Changed);
            assert_eq!(
                lookup_in(&p, "[b.example]:2222", "SHA256:bbb"),
                Status::Trusted
            );
            assert_eq!(
                lookup_in(&p, "[b.example]:2223", "SHA256:bbb"),
                Status::Unknown
            );
            assert_eq!(lookup_in(&p, "c.example", "SHA256:aaa"), Status::Unknown);
            let _ = fs::remove_file(p);
        }

        #[test]
        fn legacy_bare_entry_covers_other_ports_until_a_specific_one_exists() {
            let p = store("legacy", "a.example SHA256:old\n");
            assert_eq!(
                lookup_in(&p, "[a.example]:2222", "SHA256:old"),
                Status::Trusted
            );
            assert_eq!(
                lookup_in(&p, "[a.example]:2222", "SHA256:new"),
                Status::Changed
            );
            fs::write(&p, "a.example SHA256:old\n[a.example]:2222 SHA256:new\n").unwrap();
            assert_eq!(
                lookup_in(&p, "[a.example]:2222", "SHA256:new"),
                Status::Trusted
            );
            assert_eq!(
                lookup_in(&p, "[a.example]:2222", "SHA256:old"),
                Status::Changed
            );
            let _ = fs::remove_file(p);
        }

        #[test]
        fn trust_rejects_values_that_would_inject_lines() {
            let p = store("inject", "");
            for (key, fp) in [
                ("evil.example\nother.example", "SHA256:x"),
                ("evil.example other.example", "SHA256:x"),
                ("ok.example", "SHA256:x\nother.example SHA256:y"),
                ("ok.example", "not-a-fingerprint"),
                ("", "SHA256:x"),
            ] {
                assert!(trust_in(&p, key, fp).is_err(), "{key:?} {fp:?}");
            }
            assert_eq!(fs::read_to_string(&p).unwrap(), "");
            trust_in(&p, "[ok.example]:2222", "SHA256:x").unwrap();
            assert_eq!(
                lookup_in(&p, "[ok.example]:2222", "SHA256:x"),
                Status::Trusted
            );
            let _ = fs::remove_file(p);
        }
    }
}

// Re-export the public trust helper at crate root for ergonomic Tauri-command wiring.
pub fn trust_host(host: &str, fingerprint: &str) -> std::io::Result<()> {
    known_hosts::trust(host, fingerprint)
}
