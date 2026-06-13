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
//! Host-key verification is TOFU against `~/.ssh/known_hosts`. An unknown
//! host returns [`TunnelError::UnknownHost`] with the fingerprint so the
//! frontend can prompt the user.

use russh::client::{self, Handle};
use russh_keys::{self as keys, key::{PublicKey, KeyPair as PrivateKey}};
use russh::{ChannelMsg, Disconnect};
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
    /// When true, refuse to connect if the host key is unknown. When false,
    /// unknown hosts return [`TunnelError::UnknownHost`] so the frontend can
    /// prompt; on user accept, call [`trust_host`] before retrying.
    pub strict_host_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuth {
    Password { password: String },
    KeyFile { path: String, passphrase: Option<String> },
    Agent,
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
            host: cfg.ssh_host.clone(),
            strict: cfg.strict_host_key,
        };
        let client_cfg = Arc::new(client::Config::default());
        let mut session = client::connect(
            client_cfg,
            (cfg.ssh_host.as_str(), cfg.ssh_port),
            handler,
        )
        .await?;

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
            session.authenticate_password(&cfg.ssh_user, password).await?
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
                let (a, res) = session
                    .authenticate_future(&cfg.ssh_user, id, agent)
                    .await;
                agent = a;
                match res {
                    Ok(true) => { auth_ok = true; break; }
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
        .channel_open_direct_tcpip(db_host, db_port as u32, &peer.ip().to_string(), peer.port() as u32)
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
        let trusted = known_hosts::is_trusted(&self.host, &fp).unwrap_or(false);
        if trusted {
            return Ok(true);
        }
        if self.strict {
            return Err(TunnelError::HostKeyMismatch {
                host: self.host.clone(),
            });
        }
        Err(TunnelError::UnknownHost {
            host: self.host.clone(),
            fingerprint: fp,
            alg,
        })
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
    const T: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((b.len() + 2) / 3 * 4);
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
        let _ = write!(s, "{}{}==", T[((n >> 18) & 0x3f) as usize] as char, T[((n >> 12) & 0x3f) as usize] as char);
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

/// `~/.ssh/known_hosts` backed TOFU store. Simple SHA256-fingerprint match —
/// good enough for a desktop client whose users set up known_hosts via the
/// frontend's accept dialog.
pub mod known_hosts {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::{BufRead, BufReader, Write};

    fn path() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".ssh").join("nembrix_known_hosts"))
    }

    pub fn is_trusted(host: &str, fingerprint: &str) -> Option<bool> {
        let p = path()?;
        let f = fs::File::open(&p).ok()?;
        for line in BufReader::new(f).lines().flatten() {
            let mut it = line.split_whitespace();
            if let (Some(h), Some(fp)) = (it.next(), it.next()) {
                if h == host && fp == fingerprint {
                    return Some(true);
                }
            }
        }
        Some(false)
    }

    pub fn trust(host: &str, fingerprint: &str) -> std::io::Result<()> {
        let p = path().ok_or_else(|| std::io::Error::other("no home dir"))?;
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new().create(true).append(true).open(&p)?;
        writeln!(f, "{} {}", host, fingerprint)?;
        Ok(())
    }
}

// Re-export the public trust helper at crate root for ergonomic Tauri-command wiring.
pub fn trust_host(host: &str, fingerprint: &str) -> std::io::Result<()> {
    known_hosts::trust(host, fingerprint)
}
