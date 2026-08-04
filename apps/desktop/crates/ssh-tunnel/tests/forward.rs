//! End-to-end tunnel test:
//!   client → russh tunnel → openssh-server container → echo server
//! The echo server runs inside the same container on a fixed port; the
//! tunnel forwards `direct-tcpip` requests to it. We verify the bytes
//! round-trip unchanged.
//!
//! Skipped when Docker isn't available, same convention as db-postgres.

use ssh_tunnel::{SshAuth, Tunnel, TunnelConfig};
use std::time::Duration;
use testcontainers::{
    core::{ContainerPort, IntoContainerPort, WaitFor},
    runners::AsyncRunner,
    GenericImage, ImageExt,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn docker_available() -> bool {
    if std::env::var("DBCLIENT_SKIP_DOCKER").is_ok() {
        return false;
    }
    tokio::process::Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn tunnel_forwards_tcp_through_sshd() -> anyhow::Result<()> {
    if !docker_available().await {
        if std::env::var("DBCLIENT_REQUIRE_DOCKER").is_ok() {
            panic!("Docker required but not available");
        }
        eprintln!("skipping: docker not available");
        return Ok(());
    }

    // Run linuxserver/openssh-server with a known password user, and
    // additionally start ncat as a fixed echo server on port 9999 inside
    // the same container so the tunnel has something to forward to.
    let image = GenericImage::new("linuxserver/openssh-server", "latest")
        .with_exposed_port(2222.tcp())
        .with_wait_for(WaitFor::message_on_stdout("[ls.io-init] done."));
    let container = image
        .with_env_var("PUID", "1000")
        .with_env_var("PGID", "1000")
        .with_env_var("TZ", "UTC")
        .with_env_var("PASSWORD_ACCESS", "true")
        .with_env_var("USER_NAME", "demo")
        .with_env_var("USER_PASSWORD", "demo")
        .start()
        .await?;

    // Start an in-container echo server on port 9999.
    // (Inside the container we have a busybox-y shell; `nc -l -k -p 9999 -e /bin/cat`
    // gives us a persistent echo. linuxserver image ships busybox `nc`.)
    container
        .exec(testcontainers::core::ExecCommand::new(vec![
            "sh".to_string(),
            "-c".to_string(),
            "(nc -l -k -p 9999 -e /bin/cat >/tmp/echo.log 2>&1 &) ; sleep 0.5".to_string(),
        ]))
        .await?;

    let host = container.get_host().await?.to_string();
    let port = container
        .get_host_port_ipv4(ContainerPort::Tcp(2222))
        .await?;

    let tunnel = open_trusting(TunnelConfig {
        ssh_host: host,
        ssh_port: port,
        ssh_user: "demo".into(),
        auth: SshAuth::Password {
            password: "demo".into(),
        },
        db_host: "127.0.0.1".into(), // echo server is reachable on the container's own loopback
        db_port: 9999,
        strict_host_key: false,
    })
    .await?;

    // Hit the local end of the tunnel — bytes should round-trip through ncat.
    let local = tunnel.local_port();
    // Retry the dial briefly while the echo server warms up.
    let mut sock = None;
    for _ in 0..20 {
        if let Ok(s) = TcpStream::connect(("127.0.0.1", local)).await {
            sock = Some(s);
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let mut sock = sock.expect("connect to tunnel");
    sock.write_all(b"hello tunnel\n").await?;
    let mut buf = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await??;
    let echoed = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(echoed.contains("hello tunnel"), "got: {echoed:?}");

    tunnel.shutdown().await;
    Ok(())
}

/// Start an openssh-server container (user demo / pass demo, port 2222) and
/// return (host, mapped_port). Shared by the auth/error tests below.
async fn start_sshd() -> anyhow::Result<(testcontainers::ContainerAsync<GenericImage>, String, u16)>
{
    let image = GenericImage::new("linuxserver/openssh-server", "latest")
        .with_exposed_port(2222.tcp())
        .with_wait_for(WaitFor::message_on_stdout("[ls.io-init] done."));
    let container = image
        .with_env_var("PUID", "1000")
        .with_env_var("PGID", "1000")
        .with_env_var("TZ", "UTC")
        .with_env_var("PASSWORD_ACCESS", "true")
        .with_env_var("USER_NAME", "demo")
        .with_env_var("USER_PASSWORD", "demo")
        .start()
        .await?;
    let host = container.get_host().await?.to_string();
    let port = container
        .get_host_port_ipv4(ContainerPort::Tcp(2222))
        .await?;
    Ok((container, host, port))
}

/// Open a tunnel, mirroring the real UI's TOFU flow: the first attempt to an
/// unknown host returns `UnknownHost` with the fingerprint; the UI would
/// prompt, `trust_host`, and retry. Each container has a fresh host key, so we
/// always go through the trust step here.
async fn open_trusting(
    cfg: TunnelConfig,
) -> Result<ssh_tunnel::TunnelHandle, ssh_tunnel::TunnelError> {
    match Tunnel::open(cfg.clone()).await {
        Ok(t) => Ok(t),
        Err(ssh_tunnel::TunnelError::UnknownHost {
            host, fingerprint, ..
        }) => {
            ssh_tunnel::trust_host(&host, &fingerprint).expect("trust host");
            Tunnel::open(cfg).await
        }
        Err(e) => Err(e),
    }
}

#[tokio::test]
async fn tunnel_rejects_wrong_ssh_password() -> anyhow::Result<()> {
    if !docker_available().await {
        if std::env::var("DBCLIENT_REQUIRE_DOCKER").is_ok() {
            panic!("Docker required but not available");
        }
        eprintln!("skipping: docker not available");
        return Ok(());
    }
    let (_c, host, port) = start_sshd().await?;
    // Trust the host key first (via a throwaway correct-password open) so the
    // failure below is unambiguously an AUTH failure, not host-key rejection.
    open_trusting(TunnelConfig {
        ssh_host: host.clone(),
        ssh_port: port,
        ssh_user: "demo".into(),
        auth: SshAuth::Password {
            password: "demo".into(),
        },
        db_host: "127.0.0.1".into(),
        db_port: 9999,
        strict_host_key: false,
    })
    .await?
    .shutdown()
    .await;

    let res = Tunnel::open(TunnelConfig {
        ssh_host: host,
        ssh_port: port,
        ssh_user: "demo".into(),
        auth: SshAuth::Password {
            password: "not-the-password".into(),
        },
        db_host: "127.0.0.1".into(),
        db_port: 9999,
        strict_host_key: false,
    })
    .await;
    // Host is trusted now, so this can only fail on authentication.
    assert!(
        res.is_err(),
        "wrong SSH password must fail to open the tunnel"
    );
    Ok(())
}

#[tokio::test]
async fn tunnel_opens_but_forward_to_dead_target_fails() -> anyhow::Result<()> {
    if !docker_available().await {
        if std::env::var("DBCLIENT_REQUIRE_DOCKER").is_ok() {
            panic!("Docker required but not available");
        }
        eprintln!("skipping: docker not available");
        return Ok(());
    }
    // SSH auth succeeds, so the tunnel opens — but nothing is listening on the
    // target port inside the container, so a forwarded connection should not
    // round-trip data. This guards the "tunnel up, db unreachable" path.
    let (_c, host, port) = start_sshd().await?;
    let tunnel = open_trusting(TunnelConfig {
        ssh_host: host,
        ssh_port: port,
        ssh_user: "demo".into(),
        auth: SshAuth::Password {
            password: "demo".into(),
        },
        db_host: "127.0.0.1".into(),
        db_port: 1, // nothing listens here
        strict_host_key: false,
    })
    .await?;
    let local = tunnel.local_port();
    // A dial may connect to the local forwarder, but the channel to the dead
    // target won't deliver data — a read should error or return 0 bytes.
    if let Ok(mut sock) = TcpStream::connect(("127.0.0.1", local)).await {
        let _ = sock.write_all(b"ping\n").await;
        let mut buf = vec![0u8; 16];
        let r = tokio::time::timeout(Duration::from_secs(3), sock.read(&mut buf)).await;
        let got_data = matches!(r, Ok(Ok(n)) if n > 0);
        assert!(!got_data, "no data should round-trip to a dead target");
    }
    tunnel.shutdown().await;
    Ok(())
}
