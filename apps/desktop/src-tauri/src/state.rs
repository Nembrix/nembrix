use db_core::DynConn;
use secrets::Store;
use ssh_tunnel::TunnelHandle;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct LiveConn {
    pub db: DynConn,
    /// Held alongside the DB connection so dropping the entry tears down
    /// the pool first, then the tunnel.
    pub tunnel: Option<TunnelHandle>,
}

#[derive(Clone)]
pub struct AppState {
    pub conns: Arc<RwLock<HashMap<Uuid, LiveConn>>>,
    pub store: Arc<Store>,
    /// Per-connection cancel flags for running scripts, keyed by connection
    /// id. `run_script` inserts a fresh flag before running and removes it
    /// after; `cancel_script` flips the flag so the engine's interrupt
    /// handler tears the script down. One in-flight script per connection is
    /// the model (mirrors the query cancel design).
    pub script_cancels: Arc<RwLock<HashMap<Uuid, Arc<AtomicBool>>>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            conns: Arc::new(RwLock::new(HashMap::new())),
            store: Arc::new(store),
            script_cancels: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}
