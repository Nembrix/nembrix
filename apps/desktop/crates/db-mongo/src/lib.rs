//! MongoDB driver — `DbConnection` impl on top of the official `mongodb`
//! crate.
//!
//! The trait is SQL-shaped (`stream(query: &str)`, `introspect -> SchemaTree`),
//! so the seam for a document store is the query string: it carries a slice
//! of the mongo shell language (`db.coll.find({...})`, `aggregate([...])`,
//! the write helpers, `runCommand`). [`parse`] turns that into a typed
//! [`Command`]; this module dispatches the command against the driver.
//!
//! Reads (`find`/`aggregate`/`count`/`distinct`/`runCommand`) flow through
//! [`DbConnection::stream`] as batched [`RowBatch`]es — documents become
//! `CellValue::Document` cells under a first-seen column union. Writes
//! (`insert*`/`update*`/`delete*`) flow through [`DbConnection::execute`]
//! and report an [`ExecSummary`].
//!
//! Cancellation: the driver has no server-side "cancel this cursor by id"
//! that maps cleanly onto a fire-and-forget handle, so [`cancel`] aborts the
//! local streaming task (which drops the cursor; the server reaps it on the
//! next getMore / cursor timeout). That's the same observable behaviour the
//! UI needs — the stream stops and emits `done`.

use async_trait::async_trait;
use dashmap::DashMap;
use db_core::{
    CellValue, ColMeta, DbConnection, DbError, DbResult, ExecSummary, Params, QueryHandle,
    QueryLang, RowBatch, RowSink, SchemaTree,
};
use futures::TryStreamExt;
use mongodb::bson::{doc, Document};
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::sync::Arc;
use std::time::Instant;
use tokio::task::JoinHandle;

pub mod introspect;
pub mod parse;
pub mod value;

use parse::Command;
use value::ColumnAccumulator;

const STREAM_BATCH: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MongoConfig {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    /// The default database — the one `db` refers to in shell commands and
    /// the one introspection pins. Mongo connections aren't bound to a single
    /// database, but the editor's `db.` prefix needs a target.
    pub database: Option<String>,
    /// `admin` unless overridden. Where credentials are checked.
    pub auth_source: Option<String>,
    pub tls: bool,
    pub app_name: Option<String>,
    /// Server selection / connect timeout. Keeps `test_connection` from
    /// hanging on an unreachable host.
    pub connect_timeout_ms: Option<u64>,
}

impl MongoConfig {
    /// Build a `mongodb://` connection string from the parts. We construct it
    /// by hand (rather than asking the user for a URI) so the same connection
    /// form drives every engine; credentials are URL-encoded.
    fn connection_uri(&self) -> String {
        let mut uri = String::from("mongodb://");
        if let Some(user) = self.user.as_deref().filter(|u| !u.is_empty()) {
            uri.push_str(&urlencode(user));
            if let Some(pw) = self.password.as_deref() {
                uri.push(':');
                uri.push_str(&urlencode(pw));
            }
            uri.push('@');
        }
        uri.push_str(&self.host);
        uri.push(':');
        uri.push_str(&self.port.to_string());
        uri.push('/');
        if let Some(db) = self.database.as_deref() {
            uri.push_str(db);
        }
        let mut params: Vec<String> = Vec::new();
        if let Some(src) = self.auth_source.as_deref() {
            params.push(format!("authSource={src}"));
        }
        if self.tls {
            params.push("tls=true".to_string());
        }
        if !params.is_empty() {
            uri.push('?');
            uri.push_str(&params.join("&"));
        }
        uri
    }
}

/// Minimal percent-encoding for the userinfo segment of the URI — encodes the
/// characters that would otherwise break parsing (`:`, `@`, `/`, `?`, `#`,
/// `%`). We avoid pulling a urlencoding crate for this one use.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub struct MongoConn {
    client: Client,
    default_db: Option<String>,
    /// handle -> the local streaming task, so `cancel` can abort it.
    running: Arc<DashMap<QueryHandle, JoinHandle<()>>>,
}

impl MongoConn {
    pub async fn connect(cfg: MongoConfig) -> DbResult<Arc<Self>> {
        let mut opts = ClientOptions::parse(cfg.connection_uri())
            .await
            .map_err(|e| DbError::Connect(e.to_string()))?;
        opts.app_name = Some(cfg.app_name.clone().unwrap_or_else(|| "nembrix".into()));
        if let Some(ms) = cfg.connect_timeout_ms {
            let d = std::time::Duration::from_millis(ms);
            opts.server_selection_timeout = Some(d);
            opts.connect_timeout = Some(d);
        }
        let client = Client::with_options(opts).map_err(|e| DbError::Connect(e.to_string()))?;
        Ok(Arc::new(Self {
            client,
            default_db: cfg.database,
            running: Arc::new(DashMap::new()),
        }))
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    /// The database shell commands resolve `db.` against. Falls back to
    /// `test` (Mongo's conventional default) when the connection didn't pin
    /// one, matching the shell's own behaviour.
    fn db(&self) -> Database {
        let name = self.default_db.as_deref().unwrap_or("test");
        self.client.database(name)
    }

    fn collection(&self, name: &str) -> Collection<Document> {
        self.db().collection::<Document>(name)
    }
}

#[async_trait]
impl DbConnection for MongoConn {
    fn lang(&self) -> QueryLang {
        QueryLang::MongoShell
    }

    async fn ping(&self) -> DbResult<()> {
        self.db()
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| DbError::Driver(e.to_string()))?;
        Ok(())
    }

    async fn introspect(&self) -> DbResult<SchemaTree> {
        introspect::introspect(&self.client, self.default_db.as_deref()).await
    }

    async fn execute(&self, query: &str, _params: Params) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let cmd = parse::parse(query).map_err(|e| DbError::Driver(e.to_string()))?;
        let rows_affected = self.run_write(&cmd).await?;
        Ok(ExecSummary {
            rows_affected,
            last_insert_id: None, // Mongo ids are ObjectIds, not i64.
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn stream(&self, query: &str, _params: Params, sink: RowSink) -> DbResult<QueryHandle> {
        let cmd = parse::parse(query).map_err(|e| DbError::Driver(e.to_string()))?;
        let handle = QueryHandle::new();
        let client = self.client.clone();
        let default_db = self.default_db.clone();
        let running = self.running.clone();

        let task = tokio::spawn(async move {
            let db = client.database(default_db.as_deref().unwrap_or("test"));
            if let Err(e) = run_read(&db, &client, default_db.as_deref(), cmd, &sink).await {
                let _ = sink
                    .send(RowBatch {
                        columns: None,
                        rows: vec![vec![CellValue::Text(e.to_string())]],
                        done: true,
                    })
                    .await;
            }
            running.remove(&handle);
        });

        self.running.insert(handle, task);
        Ok(handle)
    }

    async fn cancel(&self, handle: QueryHandle) -> DbResult<()> {
        let (_, task) = self.running.remove(&handle).ok_or(DbError::UnknownHandle)?;
        // Aborting drops the cursor; the server cleans it up on timeout. The
        // task's own `done` emission is lost on abort, so we don't rely on it
        // — the Tauri layer treats a closed channel as terminal too.
        task.abort();
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl MongoConn {
    /// Run a write/admin command and return rows_affected. Reads should never
    /// reach here — they go through `stream`.
    async fn run_write(&self, cmd: &Command) -> DbResult<u64> {
        let drv = |e: mongodb::error::Error| DbError::Driver(e.to_string());
        match cmd {
            Command::InsertOne { collection, doc } => {
                self.collection(collection).insert_one(doc.clone()).await.map_err(drv)?;
                Ok(1)
            }
            Command::InsertMany { collection, docs } => {
                let res = self
                    .collection(collection)
                    .insert_many(docs.clone())
                    .await
                    .map_err(drv)?;
                Ok(res.inserted_ids.len() as u64)
            }
            Command::UpdateOne { collection, filter, update, upsert } => {
                let res = self
                    .collection(collection)
                    .update_one(filter.clone(), update.clone())
                    .upsert(*upsert)
                    .await
                    .map_err(drv)?;
                Ok(res.modified_count + res.upserted_id.is_some() as u64)
            }
            Command::UpdateMany { collection, filter, update, upsert } => {
                let res = self
                    .collection(collection)
                    .update_many(filter.clone(), update.clone())
                    .upsert(*upsert)
                    .await
                    .map_err(drv)?;
                Ok(res.modified_count + res.upserted_id.is_some() as u64)
            }
            Command::ReplaceOne { collection, filter, replacement, upsert } => {
                let res = self
                    .collection(collection)
                    .replace_one(filter.clone(), replacement.clone())
                    .upsert(*upsert)
                    .await
                    .map_err(drv)?;
                Ok(res.modified_count + res.upserted_id.is_some() as u64)
            }
            Command::DeleteOne { collection, filter } => {
                let res = self.collection(collection).delete_one(filter.clone()).await.map_err(drv)?;
                Ok(res.deleted_count)
            }
            Command::DeleteMany { collection, filter } => {
                let res = self.collection(collection).delete_many(filter.clone()).await.map_err(drv)?;
                Ok(res.deleted_count)
            }
            // A read sent to execute() — run it for its side effect-free
            // result but report 0 affected. The UI shouldn't route here, but
            // be forgiving rather than error.
            other if other.is_read() => Ok(0),
            _ => Err(DbError::Unsupported("command not valid as a write")),
        }
    }
}

/// Drive a read command, pushing batches into `sink`.
async fn run_read(
    db: &Database,
    client: &Client,
    default_db: Option<&str>,
    cmd: Command,
    sink: &RowSink,
) -> DbResult<()> {
    let drv = |e: mongodb::error::Error| DbError::Driver(e.to_string());
    match cmd {
        Command::Find { collection, opts } => {
            let coll = db.collection::<Document>(&collection);
            let mut action = coll.find(opts.filter);
            if let Some(p) = opts.projection {
                action = action.projection(p);
            }
            if let Some(s) = opts.sort {
                action = action.sort(s);
            }
            if let Some(l) = opts.limit {
                action = action.limit(l);
            }
            if let Some(s) = opts.skip {
                action = action.skip(s);
            }
            let cursor = action.await.map_err(drv)?;
            stream_documents(cursor, sink).await
        }
        Command::FindOne { collection, filter, projection } => {
            let coll = db.collection::<Document>(&collection);
            let mut action = coll.find(filter).limit(1);
            if let Some(p) = projection {
                action = action.projection(p);
            }
            let cursor = action.await.map_err(drv)?;
            stream_documents(cursor, sink).await
        }
        Command::Aggregate { collection, pipeline } => {
            let cursor = db
                .collection::<Document>(&collection)
                .aggregate(pipeline)
                .await
                .map_err(drv)?;
            stream_documents(cursor, sink).await
        }
        Command::CountDocuments { collection, filter } => {
            let n = db
                .collection::<Document>(&collection)
                .count_documents(filter)
                .await
                .map_err(drv)?;
            emit_scalar(sink, "count", CellValue::Int(n as i64)).await
        }
        Command::EstimatedDocumentCount { collection } => {
            let n = db
                .collection::<Document>(&collection)
                .estimated_document_count()
                .await
                .map_err(drv)?;
            emit_scalar(sink, "count", CellValue::Int(n as i64)).await
        }
        Command::Distinct { collection, field, filter } => {
            let values = db
                .collection::<Document>(&collection)
                .distinct(&field, filter)
                .await
                .map_err(drv)?;
            let columns = vec![ColMeta { name: field, type_name: "bson".into(), nullable: true }];
            let rows = values.iter().map(|b| vec![value::bson_to_cell(b)]).collect();
            sink.send(RowBatch { columns: Some(columns), rows, done: true })
                .await
                .ok();
            Ok(())
        }
        Command::RunCommand { command } => {
            let res = db.run_command(command).await.map_err(drv)?;
            // Render the command reply as a single document row.
            let mut acc = ColumnAccumulator::new();
            acc.observe(&res);
            let columns = acc.columns();
            let row = acc.row(&res);
            sink.send(RowBatch { columns: Some(columns), rows: vec![row], done: true })
                .await
                .ok();
            Ok(())
        }
        Command::GetCollectionNames => {
            let names = client
                .database(default_db.unwrap_or("test"))
                .list_collection_names()
                .await
                .map_err(drv)?;
            let columns = vec![ColMeta { name: "name".into(), type_name: "string".into(), nullable: false }];
            let rows = names.into_iter().map(|n| vec![CellValue::Text(n)]).collect();
            sink.send(RowBatch { columns: Some(columns), rows, done: true })
                .await
                .ok();
            Ok(())
        }
        _ => Err(DbError::Unsupported("command is not a read")),
    }
}

/// Pump a document cursor into the sink in [`STREAM_BATCH`]-sized chunks,
/// building the column union as documents arrive. The schema (`columns`) is
/// sent on the first batch only — same contract as the Postgres driver.
///
/// Subtlety: the column union can grow as later documents introduce new
/// fields, but `RowBatch.columns` is first-batch-only. We therefore lock the
/// column set after the first batch is sent; fields that appear only in later
/// documents won't get their own column. In practice the first 200 docs of a
/// collection almost always cover the field set; this keeps the wire contract
/// identical to SQL without a schema-renegotiation protocol.
async fn stream_documents(
    mut cursor: mongodb::Cursor<Document>,
    sink: &RowSink,
) -> DbResult<()> {
    let mut acc = ColumnAccumulator::new();
    let mut buf: Vec<Document> = Vec::with_capacity(STREAM_BATCH);
    let mut sent_first = false;

    loop {
        let next = cursor
            .try_next()
            .await
            .map_err(|e| DbError::Driver(e.to_string()))?;
        match next {
            Some(d) => {
                if !sent_first {
                    acc.observe(&d);
                }
                buf.push(d);
                if buf.len() >= STREAM_BATCH {
                    flush(&acc, &mut buf, sink, &mut sent_first, false).await;
                }
            }
            None => {
                flush(&acc, &mut buf, sink, &mut sent_first, true).await;
                break;
            }
        }
    }
    Ok(())
}

async fn flush(
    acc: &ColumnAccumulator,
    buf: &mut Vec<Document>,
    sink: &RowSink,
    sent_first: &mut bool,
    done: bool,
) {
    let columns = if *sent_first { None } else { Some(acc.columns()) };
    let rows = buf.iter().map(|d| acc.row(d)).collect();
    buf.clear();
    *sent_first = true;
    let _ = sink.send(RowBatch { columns, rows, done }).await;
}

async fn emit_scalar(sink: &RowSink, name: &str, v: CellValue) -> DbResult<()> {
    let columns = vec![ColMeta { name: name.into(), type_name: "int".into(), nullable: false }];
    sink.send(RowBatch { columns: Some(columns), rows: vec![value::scalar_row(v)], done: true })
        .await
        .ok();
    Ok(())
}
