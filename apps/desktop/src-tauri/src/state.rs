use db_core::DynConn;
use secrets::Store;
use ssh_tunnel::TunnelHandle;
use std::collections::HashMap;
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
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            conns: Arc::new(RwLock::new(HashMap::new())),
            store: Arc::new(store),
        }
    }
}
