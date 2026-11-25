//! Read-only LanceDB access. Mirrors the search paths of `src/vector-store.ts`.
use crate::config::{data_dir, Settings};
use anyhow::Result;
use crate::chunk::Chunk;
use crate::gitlab_issues::KnowledgeChunk;
use crate::jsstr::{env_int, env_pos_int};
use arrow_array::{Array, ArrayRef, FixedSizeListArray, Float32Array, Float64Array, Int32Array, Int64Array, LargeStringArray, RecordBatch, RecordBatchIterator, StringArray, StringViewArray, UInt32Array, UInt64Array};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lancedb::index::vector::IvfHnswSqIndexBuilder;
use lancedb::index::scalar::{FtsIndexBuilder, FtsQuery, FullTextSearchQuery, MatchQuery, PhraseQuery};
use lancedb::index::Index;
use lancedb::table::OptimizeAction;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::{connect, Connection, DistanceType, Table};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::OnceCell;

pub const CURRENT_CHUNK_ID_SCHEME: i64 = 2;

pub fn db_path() -> PathBuf {
    data_dir().join("lancedb")
}

/// Mirrors `needsMigration`: no sidecar, a string marker, or an older scheme all count.
pub fn needs_migration(table: &str) -> bool {
    // Nothing written yet, or a rebuild that failed: there is nothing to migrate.
    if !db_path().join(format!("{table}.lance")).exists() {
        return false;
    }
    let path = db_path().join(format!("{table}-meta.json"));
    let Ok(text) = std::fs::read_to_string(path) else { return true };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) else { return true };
    match meta.get("chunk_id_scheme") {
        Some(v) if v.is_string() => true,
        Some(v) => v.as_i64().unwrap_or(0) < CURRENT_CHUNK_ID_SCHEME,
        None => true,
    }
}

pub fn escape_sql(v: &str) -> String {
    v.replace('\'', "''")
}

pub struct Store {
    db: OnceCell<Connection>,
    tables: Mutex<HashMap<String, Table>>,
    has_vector_index: Mutex<HashMap<String, bool>>,
    health: Mutex<HashMap<String, (Health, Instant)>>,
    pub settings: Settings,
}

/// A row as JS sees it: strings via `String(x)`, numbers via `Number(x)`.
pub struct Rows {
    batches: Vec<RecordBatch>,
}

impl Rows {
    pub fn iter(&self) -> impl Iterator<Item = Row<'_>> {
        self.batches.iter().flat_map(|b| (0..b.num_rows()).map(move |i| Row { batch: b, i }))
    }
}

pub struct Row<'a> {
    batch: &'a RecordBatch,
    i: usize,
}

impl Row<'_> {
    fn col(&self, name: &str) -> Option<&ArrayRef> {
        self.batch.column_by_name(name)
    }
    /// `String(row[name])`: a null becomes the text "null", as it does in the TypeScript.
    pub fn string(&self, name: &str) -> String {
        self.opt_string(name).unwrap_or_else(|| "null".to_string())
    }
    /// `String(row[name] ?? "")`.
    pub fn string_or_empty(&self, name: &str) -> String {
        self.opt_string(name).unwrap_or_default()
    }
    fn opt_string(&self, name: &str) -> Option<String> {
        let col = self.col(name)?;
        if col.is_null(self.i) {
            return None;
        }
        if let Some(a) = col.as_any().downcast_ref::<StringArray>() {
            return Some(a.value(self.i).to_string());
        }
        if let Some(a) = col.as_any().downcast_ref::<LargeStringArray>() {
            return Some(a.value(self.i).to_string());
        }
        if let Some(a) = col.as_any().downcast_ref::<StringViewArray>() {
            return Some(a.value(self.i).to_string());
        }
        None
    }
    pub fn number(&self, name: &str) -> f64 {
        let Some(col) = self.col(name) else { return 0.0 };
        if col.is_null(self.i) {
            return 0.0;
        }
        let any = col.as_any();
        if let Some(a) = any.downcast_ref::<Float32Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<Float64Array>() {
            return a.value(self.i);
        }
        if let Some(a) = any.downcast_ref::<Int32Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<Int64Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<UInt32Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<UInt64Array>() {
            return a.value(self.i) as f64;
        }
        0.0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Health {
    Healthy,
    Corrupt(Fault),
    /// A passing IO error: say nothing about the table.
    Unknown,
}

/// Why a table can't be used, and the `details` that go with the reason.
#[derive(Clone, Debug, PartialEq)]
pub struct Fault {
    pub reason: &'static str,
    pub details: Map<String, Value>,
}

impl Fault {
    fn corrupt(reason: &'static str, details: Value) -> Health {
        Health::Corrupt(Fault { reason, details: details.as_object().cloned().unwrap_or_default() })
    }

    /// What a search says about it.
    pub fn message(&self, project: &str, source: &str) -> String {
        let what = match self.reason {
            "dimensions_mismatch" => format!("has a dimensions mismatch (indexed at {}, embedder is now {})", self.details["actual_dimensions"], self.details["expected_dimensions"]),
            "manifest_missing_data" => {
                let n = self.details.get("missing_files").and_then(Value::as_array).map_or(1, Vec::len);
                format!("has a corrupt index (manifest references {n} missing data file{})", if n == 1 { "" } else { "s" })
            }
            _ => "has an unreadable index".to_string(),
        };
        format!("Source '{project}/{source}' {what}. Run: scrybe index -P {project} -S {source} --full")
    }
}

fn health_ttl() -> Duration {
    Duration::from_millis(env_pos_int("SCRYBE_HEALTH_TTL_MS").map_or(60_000, |n| n as u64))
}

/// Versions a table may keep before a write compacts it.
pub fn compact_threshold() -> usize {
    env_int("SCRYBE_LANCE_COMPACT_THRESHOLD").map_or(10, |n| n as usize)
}

/// How old a version must be before compaction prunes it, so a search under way keeps its snapshot.
fn grace() -> chrono::TimeDelta {
    chrono::TimeDelta::milliseconds(env_int("SCRYBE_LANCE_GRACE_MS").filter(|n| n.is_finite() && *n >= 0.0).map_or(60_000, |n| n.min(1e15) as i64))
}

fn is_commit_conflict(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("commit conflict") || m.contains("cannot be automatically resolved")
}

fn classify_probe_error(msg: &str) -> Health {
    // Interrupted, IO, try again, busy, out of handles, and the sharing codes of Windows.
    const PASSING: [&str; 11] = ["4", "5", "11", "16", "23", "24", "26", "32", "33", "35", "1224"];
    let code = msg.rsplit_once("os error ").map(|(_, rest)| &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()]);
    if code.is_some_and(|c| PASSING.contains(&c)) || ["EBUSY", "EIO", "EAGAIN"].iter().any(|t| msg.to_uppercase().contains(t)) {
        return Health::Unknown;
    }
    let data_file = regex::Regex::new(r"(?i)data[\\/][0-9a-f-]+\.lance").expect("a fixed pattern");
    if !msg.to_lowercase().contains("not found") || !data_file.is_match(msg) {
        return Fault::corrupt("schema_unreadable", json!({ "error_message": msg }));
    }
    let mut files: Vec<String> = vec![];
    for m in data_file.find_iter(msg).map(|m| m.as_str().replace('\\', "/")) {
        if !files.contains(&m) {
            files.push(m);
        }
    }
    Fault::corrupt("manifest_missing_data", json!({ "missing_files": files }))
}

/// Runs `op` once more, with a fresh handle, when another writer's commit got in first.
async fn retry_on_conflict<T, F: std::future::Future<Output = Result<T>>>(name: &str, evict: impl Fn(), op: impl Fn() -> F) -> Result<T> {
    match op().await {
        Err(e) if is_commit_conflict(&format!("{e:#}")) => {
            evict();
            eprintln!("[scrybe] commit conflict on '{name}' — evicting cached table handle and retrying");
            op().await
        }
        other => other,
    }
}

#[derive(Default)]
pub struct CompactReport {
    pub bytes_freed: u64,
    pub had_real_work: bool,
    pub fragments_merged: u64,
    pub versions_pruned: u64,
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.flatten().map(|e| match e.metadata() {
        Ok(m) if m.is_dir() => dir_bytes(&e.path()),
        Ok(m) => m.len(),
        Err(_) => 0,
    }).sum()
}

/// A limit far above any table's size is cut to its rows: a search sizes its heap by it.
async fn within_rows(table: &Table, limit: usize) -> Result<usize> {
    const PLAIN: usize = 10_000;
    Ok(if limit <= PLAIN { limit } else { limit.min(table.count_rows(None).await?.max(1)) })
}

fn newest_manifest_is_empty(versions: &std::path::Path) -> bool {
    let Ok(dir) = std::fs::read_dir(versions) else { return false };
    let newest = dir.flatten().filter_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        Some((name.strip_suffix(".manifest")?.parse::<u64>().ok()?, e.path()))
    }).max_by_key(|(n, _)| *n);
    newest.is_some_and(|(_, p)| std::fs::metadata(p).is_ok_and(|m| m.len() == 0))
}

/// Any `0a 10` followed by 16 bytes reads as a uuid, the scan `pruneIndexOrphans` uses. It over-collects,
/// which only ever keeps an extra folder.
fn uuids_in_manifest(buf: &[u8]) -> Vec<String> {
    let mut out = vec![];
    if buf.len() < 18 {
        return out;
    }
    for i in 0..buf.len() - 17 {
        if buf[i] == 0x0a && buf[i + 1] == 0x10 {
            let h: String = buf[i + 2..i + 18].iter().map(|b| format!("{b:02x}")).collect();
            out.push(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]));
        }
    }
    out
}

fn code_schema(dimensions: i32) -> Arc<Schema> {
    let text = |n: &str| Field::new(n, DataType::Utf8, false);
    Arc::new(Schema::new(vec![
        text("chunk_id"),
        text("project_id"),
        text("item_path"),
        text("content"),
        Field::new("start_line", DataType::Int32, false),
        Field::new("end_line", DataType::Int32, false),
        text("language"),
        text("symbol_name"),
        Field::new("vector", DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, false)), dimensions), false),
    ]))
}

fn knowledge_schema(dimensions: i32) -> Arc<Schema> {
    let text = |n: &str| Field::new(n, DataType::Utf8, false);
    let mut fields: Vec<Field> = ["chunk_id", "project_id", "source_id", "item_path", "item_url", "item_type", "author", "timestamp", "content", "state", "labels", "assignees", "milestone", "confidential"].iter().map(|n| text(n)).collect();
    fields.push(Field::new("vector", DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, false)), dimensions), false));
    Arc::new(Schema::new(fields))
}

impl Store {
    pub fn new(settings: Settings) -> Self {
        Store { db: OnceCell::new(), tables: Mutex::default(), has_vector_index: Mutex::default(), health: Mutex::default(), settings }
    }

    async fn conn(&self) -> Result<&Connection> {
        Ok(self
            .db
            .get_or_try_init(|| async {
                let mut builder = connect(&db_path().to_string_lossy());
                let mb = |name: &str| std::env::var(name).ok().and_then(|v| v.parse::<usize>().ok());
                // Experiment: LanceDB defaults to a 6 GiB index cache and 1 GiB metadata cache.
                if let (Some(index), Some(meta)) = (mb("SCRYBE_LANCE_INDEX_CACHE_MB"), mb("SCRYBE_LANCE_META_CACHE_MB")) {
                    builder = builder.session(Arc::new(lancedb::Session::new(index << 20, meta << 20, Arc::new(lancedb::ObjectStoreRegistry::default()))));
                }
                builder.execute().await
            })
            .await?)
    }

    pub async fn open(&self, name: &str) -> Result<Option<Table>> {
        if let Some(t) = self.tables.lock().unwrap().get(name) {
            return Ok(Some(t.clone()));
        }
        match self.conn().await?.open_table(name).execute().await {
            Ok(t) => {
                self.tables.lock().unwrap().insert(name.to_string(), t.clone());
                Ok(Some(t))
            }
            Err(lancedb::Error::TableNotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Mirrors `vectorIndexPresent`, including the on-disk check: a manifest entry can outlive its dir.
    async fn vector_index_present(&self, name: &str, table: &Table) -> Result<bool> {
        if let Some(v) = self.has_vector_index.lock().unwrap().get(name) {
            return Ok(*v);
        }
        let in_manifest = table
            .list_indices()
            .await?
            .iter()
            .any(|i| i.index_type.to_string().to_uppercase().contains("HNSW") && i.columns.iter().any(|c| c == "vector"));
        let exists = in_manifest
            && std::fs::read_dir(db_path().join(format!("{name}.lance")).join("_indices"))
                .map(|d| d.flatten().any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
                .unwrap_or(false);
        self.has_vector_index.lock().unwrap().insert(name.to_string(), exists);
        Ok(exists)
    }

    pub async fn vector_search(&self, name: &str, vec: &[f32], where_: &str, top_k: usize) -> Result<Rows> {
        let Some(table) = self.open(name).await? else { return Ok(Rows { batches: vec![] }) };
        let top_k = within_rows(&table, top_k).await?;
        let mut query = table.query().nearest_to(vec)?.distance_type(DistanceType::Cosine).only_if(where_).limit(top_k);
        if self.settings.vector_index_enabled && self.vector_index_present(name, &table).await? {
            let refine = self.settings.vector_refine_factor;
            let ef = self.settings.vector_ef.max(top_k * refine as usize);
            query = query.refine_factor(refine).ef(ef);
        } else {
            query = query.bypass_vector_index();
        }
        Ok(Rows { batches: query.execute().await?.try_collect().await? })
    }

    /// Same query the Node binding builds for `table.search(text, "fts", "content")`.
    pub async fn fts_search(&self, name: &str, text: &str, where_: &str, top_k: usize) -> Result<Rows> {
        let Some(table) = self.open(name).await? else { return Ok(Rows { batches: vec![] }) };
        let top_k = within_rows(&table, top_k).await?;
        let is_phrase = text.len() >= 2 && text.starts_with('"') && text.ends_with('"');
        let fts: FtsQuery = if is_phrase {
            PhraseQuery::new(text[1..text.len() - 1].to_string()).into()
        } else {
            MatchQuery::new(text.to_string()).into()
        };
        let q = FullTextSearchQuery::new_query(fts).with_columns(&["content".to_string()])?;
        let stream = table.query().full_text_search(q).only_if(where_).limit(top_k).execute().await?;
        Ok(Rows { batches: stream.try_collect().await? })
    }

    /// `getProjectTable` for a write: creates the table and its sidecar on first use.
    async fn open_or_create_code(&self, name: &str, dimensions: i32) -> Result<Table> {
        if let Some(t) = self.open(name).await? {
            return Ok(t);
        }
        std::fs::create_dir_all(db_path())?;
        let table = self.conn().await?.create_empty_table(name, code_schema(dimensions)).execute().await?;
        let meta = serde_json::json!({ "chunk_id_scheme": CURRENT_CHUNK_ID_SCHEME, "chunk_id_scheme_introduced_in": "0.31.0" });
        std::fs::write(db_path().join(format!("{name}-meta.json")), serde_json::to_string_pretty(&meta)? + "\n")?;
        self.tables.lock().unwrap().insert(name.to_string(), table.clone());
        Ok(table)
    }

    /// `getProjectTable` for a knowledge write: also stamps the metadata-schema version.
    async fn open_or_create_knowledge(&self, name: &str, dimensions: i32) -> Result<Table> {
        if let Some(t) = self.open(name).await? {
            return Ok(t);
        }
        std::fs::create_dir_all(db_path())?;
        let table = self.conn().await?.create_empty_table(name, knowledge_schema(dimensions)).execute().await?;
        let meta = serde_json::json!({
            "chunk_id_scheme": CURRENT_CHUNK_ID_SCHEME,
            "chunk_id_scheme_introduced_in": "0.31.0",
            "knowledge_schema_version": 2,
            "knowledge_schema_version_introduced_in": "0.41.0",
        });
        std::fs::write(db_path().join(format!("{name}-meta.json")), serde_json::to_string_pretty(&meta)? + "\n")?;
        self.tables.lock().unwrap().insert(name.to_string(), table.clone());
        Ok(table)
    }

    /// `upsertKnowledge` through `writeWithRetry`.
    pub async fn upsert_knowledge(&self, name: &str, rows: &[(KnowledgeChunk, Vec<f32>)]) -> Result<()> {
        retry_on_conflict(name, || self.evict(name), || self.upsert_knowledge_once(name, rows)).await
    }

    fn evict(&self, name: &str) {
        self.tables.lock().unwrap().remove(name);
    }

    /// `writeWithRetry` on a table that exists; nothing to do on one that doesn't.
    async fn write_with_retry<F: std::future::Future<Output = Result<()>>>(&self, name: &str, op: impl Fn(Table) -> F) -> Result<()> {
        let attempt = || async {
            match self.open(name).await? {
                Some(t) => op(t).await,
                None => Ok(()),
            }
        };
        retry_on_conflict(name, || self.evict(name), attempt).await
    }

    async fn upsert_knowledge_once(&self, name: &str, rows: &[(KnowledgeChunk, Vec<f32>)]) -> Result<()> {
        let Some(dim) = rows.first().map(|(_, v)| v.len() as i32) else { return Ok(()) };
        let table = self.open_or_create_knowledge(name, dim).await?;
        let schema = knowledge_schema(dim);
        let text = |f: &dyn Fn(&KnowledgeChunk) -> &str| -> ArrayRef { Arc::new(StringArray::from_iter_values(rows.iter().map(|(c, _)| f(c)))) };
        let flat: Vec<f32> = rows.iter().flat_map(|(_, v)| v.iter().copied()).collect();
        let vectors = FixedSizeListArray::try_new(Arc::new(Field::new("item", DataType::Float32, false)), dim, Arc::new(Float32Array::from(flat)), None)?;
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                text(&|c| &c.chunk_id),
                text(&|c| &c.project_id),
                text(&|c| &c.source_id),
                text(&|c| &c.item_path),
                text(&|c| &c.item_url),
                text(&|c| &c.item_type),
                text(&|c| &c.author),
                text(&|c| &c.timestamp),
                text(&|c| &c.content),
                text(&|c| &c.state),
                text(&|c| &c.labels),
                text(&|c| &c.assignees),
                text(&|c| &c.milestone),
                text(&|c| &c.confidential),
                Arc::new(vectors),
            ],
        )?;
        let mut merge = table.merge_insert(&["chunk_id"]);
        merge.when_matched_update_all(None).when_not_matched_insert_all();
        merge.execute(Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema))).await?;
        Ok(())
    }

    /// `countTableRows`.
    pub async fn count_rows(&self, name: &str) -> Result<usize> {
        match self.open(name).await? {
            Some(t) => Ok(t.count_rows(None).await?),
            None => Ok(0),
        }
    }

    /// `upsert` through `writeWithRetry`: a commit conflict means a stale handle, so reopen and try once more.
    pub async fn upsert_code(&self, name: &str, rows: &[(Chunk, Vec<f32>)]) -> Result<()> {
        retry_on_conflict(name, || self.evict(name), || self.upsert_once(name, rows)).await
    }

    /// `dropTable`: the table, a directory Lance may leave behind, and its sidecar.
    pub async fn drop_table(&self, name: &str) -> Result<()> {
        self.tables.lock().unwrap().remove(name);
        self.has_vector_index.lock().unwrap().remove(name);
        self.invalidate_health(name);
        let _ = self.conn().await?.drop_table(name, &[]).await;
        let dir = db_path().join(format!("{name}.lance"));
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        let sidecar = db_path().join(format!("{name}-meta.json"));
        if sidecar.exists() {
            let _ = std::fs::remove_file(sidecar);
        }
        Ok(())
    }

    /// `getTableHealth`: an answer stays good for a minute unless `force`; a passing IO error is never kept.
    pub async fn table_health(&self, name: &str, expected_dim: Option<i32>, force: bool) -> Health {
        if !force {
            if let Some((h, _)) = self.health.lock().unwrap().get(name).filter(|(_, at)| at.elapsed() < health_ttl()) {
                return h.clone();
            }
        }
        let found = self.probe(name, expected_dim).await;
        if found != Health::Unknown {
            self.health.lock().unwrap().insert(name.to_string(), (found.clone(), Instant::now()));
        }
        found
    }

    pub fn invalidate_health(&self, name: &str) {
        self.health.lock().unwrap().remove(name);
    }

    /// `probeTableHealth`: one retry after 100 ms, because a compaction can hide a file briefly.
    async fn probe(&self, name: &str, expected_dim: Option<i32>) -> Health {
        let first = self.probe_once(name, expected_dim).await;
        if !matches!(first, Health::Corrupt(_)) {
            return first;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        self.probe_once(name, expected_dim).await
    }

    async fn probe_once(&self, name: &str, expected_dim: Option<i32>) -> Health {
        let dir = db_path().join(format!("{name}.lance"));
        if !dir.exists() {
            return Health::Healthy;
        }
        if newest_manifest_is_empty(&dir.join("_versions")) {
            return Fault::corrupt("schema_unreadable", json!({ "error_message": "zero-byte manifest" }));
        }
        let read = async {
            // A fresh connection: a cached handle can keep reading a table that has changed underneath it.
            let table = connect(&db_path().to_string_lossy()).execute().await?.open_table(name).execute().await?;
            let rows = table.count_rows(None).await?;
            let mut dim = None;
            if rows > 0 {
                let probe: Vec<RecordBatch> = table.query().select(lancedb::query::Select::columns(&["chunk_id"])).limit(1).execute().await?.try_collect().await?;
                drop(probe);
                let schema = table.schema().await?;
                if let Ok(DataType::FixedSizeList(_, n)) = schema.field_with_name("vector").map(|f| f.data_type()) {
                    dim = Some(*n);
                }
            }
            anyhow::Ok(dim)
        }
        .await;
        match (read, expected_dim) {
            (Ok(Some(actual)), Some(expected)) if actual != expected => Fault::corrupt("dimensions_mismatch", json!({ "expected_dimensions": expected, "actual_dimensions": actual })),
            (Ok(_), _) => Health::Healthy,
            (Err(e), _) => classify_probe_error(&format!("{e:#}")),
        }
    }

    /// `pruneIndexOrphans`: removes index folders no retained manifest mentions. Returns how many, and the bytes they held.
    pub fn prune_index_orphans(&self, name: &str) -> (usize, u64) {
        let table_dir = db_path().join(format!("{name}.lance"));
        let (indices, versions) = (table_dir.join("_indices"), table_dir.join("_versions"));
        let (Ok(entries), Ok(manifests)) = (std::fs::read_dir(&indices), std::fs::read_dir(&versions)) else { return (0, 0) };
        let mut referenced = std::collections::HashSet::new();
        for m in manifests.flatten() {
            if let Ok(buf) = std::fs::read(m.path()) {
                referenced.extend(uuids_in_manifest(&buf));
            }
        }
        let (mut removed, mut freed) = (0, 0);
        for e in entries.flatten() {
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if is_dir && !referenced.contains(&*e.file_name().to_string_lossy()) {
                let size = dir_bytes(&e.path());
                if std::fs::remove_dir_all(e.path()).is_ok() {
                    removed += 1;
                    freed += size;
                }
            }
        }
        (removed, freed)
    }

    async fn upsert_once(&self, name: &str, rows: &[(Chunk, Vec<f32>)]) -> Result<()> {
        let Some(dim) = rows.first().map(|(_, v)| v.len() as i32) else { return Ok(()) };
        let table = self.open_or_create_code(name, dim).await?;
        let schema = code_schema(dim);
        let text = |f: &dyn Fn(&Chunk) -> String| -> ArrayRef { Arc::new(StringArray::from_iter_values(rows.iter().map(|(c, _)| f(c)))) };
        let flat: Vec<f32> = rows.iter().flat_map(|(_, v)| v.iter().copied()).collect();
        let vectors = FixedSizeListArray::try_new(Arc::new(Field::new("item", DataType::Float32, false)), dim, Arc::new(Float32Array::from(flat)), None)?;
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                text(&|c| c.chunk_id.clone()),
                text(&|c| c.project_id.clone()),
                text(&|c| c.item_path.clone()),
                text(&|c| c.content.clone()),
                Arc::new(Int32Array::from_iter_values(rows.iter().map(|(c, _)| c.start_line as i32))),
                Arc::new(Int32Array::from_iter_values(rows.iter().map(|(c, _)| c.end_line as i32))),
                text(&|c| c.language.clone()),
                text(&|c| c.symbol_name.clone()),
                Arc::new(vectors),
            ],
        )?;
        let mut merge = table.merge_insert(&["chunk_id"]);
        merge.when_matched_update_all(None).when_not_matched_insert_all();
        merge.execute(Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema))).await?;
        Ok(())
    }

    /// `deleteProject`.
    pub async fn delete_project_rows(&self, name: &str, project: &str) -> Result<()> {
        let rows = format!("project_id = '{}'", escape_sql(project));
        self.write_with_retry(name, |t| {
            let rows = &rows;
            async move {
                t.delete(rows.as_str()).await?;
                self.maybe_compact(name, &t).await
            }
        })
        .await
    }

    /// `createFtsIndex`: skipped when a live keyword index is already there.
    pub async fn create_fts_index(&self, name: &str) -> Result<()> {
        let Some(table) = self.open(name).await? else { return Ok(()) };
        if table.count_rows(None).await? == 0 {
            return Ok(());
        }
        let in_manifest = table.list_indices().await?.iter().any(|i| i.index_type.to_string().to_uppercase().contains("FTS") && i.columns.iter().any(|c| c == "content"));
        let on_disk = std::fs::read_dir(db_path().join(format!("{name}.lance")).join("_indices")).map(|d| d.flatten().any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))).unwrap_or(false);
        if in_manifest && on_disk {
            return Ok(());
        }
        self.write_with_retry(name, |t| async move {
            let params = FtsIndexBuilder::default().stem(false).lower_case(true);
            t.create_index(&["content"], Index::FTS(params)).replace(true).execute().await?;
            self.maybe_compact(name, &t).await
        })
        .await
    }

    /// `createVectorIndex`: an hnswSq index on `vector`, cosine, one partition. Skipped below the row threshold,
    /// and when one exists unless `force`, which rebuilds it in place.
    pub async fn create_vector_index(&self, name: &str, force: bool) -> Result<()> {
        let Some(table) = self.open(name).await? else { return Ok(()) };
        if table.count_rows(None).await? < self.settings.vector_index_min_rows {
            return Ok(());
        }
        if !force && self.vector_index_present(name, &table).await? {
            return Ok(());
        }
        self.write_with_retry(name, |t| async move {
            let params = IvfHnswSqIndexBuilder::default().distance_type(DistanceType::Cosine).num_partitions(1);
            t.create_index(&["vector"], Index::IvfHnswSq(params)).replace(true).execute().await?;
            self.maybe_compact(name, &t).await
        })
        .await?;
        self.has_vector_index.lock().unwrap().remove(name);
        self.tables.lock().unwrap().remove(name);
        Ok(())
    }

    /// `maybeCompact`: only once enough versions have piled up.
    async fn maybe_compact(&self, name: &str, table: &Table) -> Result<()> {
        if table.list_versions().await?.len() >= compact_threshold() {
            self.compact_with_grace(name).await?;
        }
        Ok(())
    }

    /// `compactTableWithGrace`: merge fragments, prune versions older than the grace, refresh indexes.
    pub async fn compact_with_grace(&self, name: &str) -> Result<()> {
        let Some(table) = self.open(name).await? else { return Ok(()) };
        table.optimize(OptimizeAction::Compact { options: Default::default(), remap_options: None }).await?;
        table.optimize(OptimizeAction::Prune { older_than: Some(grace()), delete_unverified: None, error_if_tagged_old_versions: None }).await?;
        table.optimize(OptimizeAction::Index(Default::default())).await?;
        Ok(())
    }

    /// `compactTable` or `compactTableWithGrace`. Returns the bytes the folder shrank by, because Lance's
    /// own count includes bytes it never deleted.
    pub async fn compact_measured(&self, name: &str, purge: bool) -> Result<u64> {
        Ok(self.compact_report(name, purge).await?.bytes_freed)
    }

    /// `compactTable` with what it did: the folder's shrinkage, whether anything real happened, fragments merged, versions pruned.
    pub async fn compact_report(&self, name: &str, purge: bool) -> Result<CompactReport> {
        let Some(table) = self.open(name).await? else { return Ok(CompactReport::default()) };
        let dir = db_path().join(format!("{name}.lance"));
        let before = dir_bytes(&dir);
        let older_than = if purge { chrono::TimeDelta::zero() } else { grace() };
        let merged = table.optimize(OptimizeAction::Compact { options: Default::default(), remap_options: None }).await?.compaction;
        let pruned = table.optimize(OptimizeAction::Prune { older_than: Some(older_than), delete_unverified: None, error_if_tagged_old_versions: None }).await?.prune;
        table.optimize(OptimizeAction::Index(Default::default())).await?;
        let versions_pruned = pruned.map_or(0, |p| p.old_versions);
        let had_real_work = merged.as_ref().is_some_and(|c| c.files_removed > 0 || c.files_added > 0) || versions_pruned > 1;
        Ok(CompactReport { bytes_freed: before.saturating_sub(dir_bytes(&dir)), had_real_work, fragments_merged: merged.map_or(0, |c| c.fragments_removed as u64), versions_pruned })
    }

    /// `getTableStats`: the table folder's bytes and how many versions it keeps.
    pub async fn table_stats(&self, name: &str) -> (u64, usize) {
        let size = dir_bytes(&db_path().join(format!("{name}.lance")));
        let versions = match self.open(name).await {
            Ok(Some(t)) => t.list_versions().await.map_or(0, |v| v.len()),
            _ => 0,
        };
        (size, versions)
    }

    /// `listChunkIds`.
    pub async fn list_chunk_ids(&self, name: &str, project: &str) -> Result<Vec<String>> {
        let Some(table) = self.open(name).await? else { return Ok(vec![]) };
        let batches: Vec<RecordBatch> = table.query().select(lancedb::query::Select::columns(&["chunk_id"])).only_if(format!("project_id = '{}'", escape_sql(project))).execute().await?.try_collect().await?;
        let mut out = vec![];
        for b in &batches {
            let col = b.column(0);
            if let Some(a) = col.as_any().downcast_ref::<StringArray>() {
                out.extend(a.iter().flatten().map(String::from));
            } else if let Some(a) = col.as_any().downcast_ref::<LargeStringArray>() {
                out.extend(a.iter().flatten().map(String::from));
            } else if let Some(a) = col.as_any().downcast_ref::<StringViewArray>() {
                out.extend(a.iter().flatten().map(String::from));
            }
        }
        Ok(out)
    }

    /// `deleteChunks`.
    pub async fn delete_chunks(&self, name: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let list: Vec<String> = ids.iter().map(|id| format!("'{}'", escape_sql(id))).collect();
        let rows = format!("chunk_id IN ({})", list.join(", "));
        self.write_with_retry(name, |t| {
            let rows = &rows;
            async move {
                t.delete(rows.as_str()).await?;
                self.maybe_compact(name, &t).await
            }
        })
        .await
    }

    pub async fn plain_query(&self, table: &Table, where_: &str, limit: usize) -> Result<Rows> {
        let stream = table.query().only_if(where_).limit(limit).execute().await?;
        Ok(Rows { batches: stream.try_collect().await? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn fault(h: Health) -> Fault {
        match h {
            Health::Corrupt(f) => f,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_fault_is_told_in_the_words_a_search_uses() {
        let f = fault(classify_probe_error("lance error: Not found: /d/lancedb/t.lance/data/0a1b-2c.lance, Not found: x\\data\\0A1B.lance, data/0a1b-2c.lance"));
        assert_eq!(f.details["missing_files"], json!(["data/0a1b-2c.lance", "data/0A1B.lance"]));
        assert_eq!(f.message("p", "s"), "Source 'p/s' has a corrupt index (manifest references 2 missing data files). Run: scrybe index -P p -S s --full");
        let f = fault(classify_probe_error("Not found: t.lance/_versions/3.manifest"));
        assert_eq!((f.reason, f.details["error_message"].as_str()), ("schema_unreadable", Some("Not found: t.lance/_versions/3.manifest")));
        assert_eq!(f.message("p", "s"), "Source 'p/s' has an unreadable index. Run: scrybe index -P p -S s --full");
        let f = fault(Fault::corrupt("dimensions_mismatch", json!({ "expected_dimensions": 8, "actual_dimensions": 4 })));
        assert_eq!(f.message("p", "s"), "Source 'p/s' has a dimensions mismatch (indexed at 4, embedder is now 8). Run: scrybe index -P p -S s --full");
        assert_eq!(classify_probe_error("read failed: EIO"), Health::Unknown);
        assert_eq!(classify_probe_error("Generic LocalFileSystem error: Too many open files (os error 24)"), Health::Unknown);
        fault(classify_probe_error("Permission denied (os error 13)"));
    }

    #[tokio::test]
    async fn a_commit_conflict_is_tried_once_more_with_a_fresh_handle_and_other_errors_are_not() {
        for (errors, calls, evictions, ok) in [(vec![], 1, 0, true), (vec!["Commit conflict for version 3"], 2, 1, true), (vec!["it cannot be automatically resolved", "commit conflict"], 2, 1, false), (vec!["disk full"], 1, 0, false)] {
            let (n, gone) = (Cell::new(0), Cell::new(0));
            let result = retry_on_conflict("t", || gone.set(gone.get() + 1), || {
                let error = errors.get(n.get()).copied();
                n.set(n.get() + 1);
                async move { error.map_or(Ok(()), |e| Err(anyhow::anyhow!(e))) }
            })
            .await;
            assert_eq!((n.get(), gone.get(), result.is_ok()), (calls, evictions, ok), "{errors:?}");
        }
    }
}
