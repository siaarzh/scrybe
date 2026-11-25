//! Indexes one code source. Mirrors the code path of `indexSource` in `src/indexer.ts`, from the working
//! tree or from a git ref. Ticket sources go to `index_ticket`.
use crate::branches::{self, Writer};
use crate::chunk::{self, Chunk, Sizes};
use crate::config::{data_dir, Settings};
use crate::embed;
use crate::embed_api::{self, Entry, Halving};
use crate::git;
use crate::jobs::{append_log, diag};
use crate::jsstr::{env_int, normalize_content};
use crate::phase::{self, Outcome, Phase};
use crate::registry::{self, EmbedConfig, Source};
use crate::scan;
use crate::store::{Health, Store};
use crate::vecindex;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Full,
    Incremental,
}

/// The label stored for the branch, and the ref its content is read from when that differs.
#[derive(Clone, Debug, Default)]
pub struct Options {
    pub branch: Option<String>,
    pub content_ref: Option<String>,
    /// Set by a job's cancel: checked between files and batches.
    pub cancel: Option<Arc<AtomicBool>>,
    /// The job this run belongs to, stamped on its phase records.
    pub job_id: Option<String>,
    /// Live counters for whoever started the run: a job's status, or the command line's progress line.
    pub progress: Option<ProgressSink>,
}

/// `onScanProgress`, `onEmbedProgress` and `onDownloadProgress`, as one callback.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Progress {
    /// Files scanned so far.
    Scan(usize),
    /// Chunks prepared so far, after each batch.
    Embed(usize),
    /// First-use model download, 0 to 99.
    Download(u8),
}

#[derive(Clone)]
pub struct ProgressSink(pub Arc<dyn Fn(Progress) + Send + Sync>);

impl std::fmt::Debug for ProgressSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProgressSink")
    }
}

impl Options {
    pub fn report(&self, p: Progress) {
        if let Some(sink) = &self.progress {
            (sink.0)(p);
        }
    }

    /// The download half, in the shape the embedder takes.
    pub fn download_progress(&self) -> Option<embed::DownloadProgress> {
        self.progress.clone().map(|sink| Arc::new(move |p: u8| (sink.0)(Progress::Download(p))) as embed::DownloadProgress)
    }
}

/// The error a cancelled run ends with.
pub const CANCELLED: &str = "INDEX_CANCELLED";

pub(crate) fn check_cancel(options: &Options) -> Result<()> {
    if options.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
        bail!(CANCELLED);
    }
    Ok(())
}

/// Writes must never reach a real data dir while this port is unfinished.
pub fn refuse_live_data_dir() -> Result<()> {
    let dir = std::fs::canonicalize(data_dir()).unwrap_or_else(|_| data_dir());
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let live = std::fs::canonicalize(home.join(".local/share/scrybe")).unwrap_or_else(|_| home.join(".local/share/scrybe"));
    if dir == live {
        bail!("refusing to write to {}: this build only indexes a scratch data dir (set SCRYBE_DATA_DIR)", dir.display());
    }
    if std::env::var_os("SCRYBE_DATA_DIR").is_none() {
        bail!("refusing to write without an explicit SCRYBE_DATA_DIR");
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn file_hash(path: &Path) -> Option<String> {
    Some(sha256_hex(&std::fs::read(path).ok()?))
}

fn slug(branch: &str) -> String {
    if branch == "*" { "_all_".to_string() } else { branch.replace('/', "__") }
}

pub fn hashes_path(project: &str, source: &str, branch: &str) -> PathBuf {
    data_dir().join("hashes").join(format!("{project}__{source}__{}.json", slug(branch)))
}

fn load_hashes(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_hashes(path: &Path, hashes: &HashMap<String, String>) -> Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(hashes)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub(crate) fn cursor_path(project: &str, source: &str) -> PathBuf {
    data_dir().join("cursors").join(format!("{project}__{source}.json"))
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// First-seen chunk id wins: LanceDB's mergeInsert inserts every duplicate in one source batch.
fn dedupe(rows: Vec<(Chunk, Vec<f32>)>) -> Vec<(Chunk, Vec<f32>)> {
    let mut seen = HashSet::new();
    rows.into_iter().filter(|(c, _)| seen.insert(c.chunk_id.clone())).collect()
}

/// `getExpectedDimensions`: the text profile prefers its own entry, then falls back to the code one.
pub(crate) fn expected_dimensions(cfg: &EmbedConfig, text: bool) -> i32 {
    let meta: Option<Value> = std::fs::read_to_string(data_dir().join("embedding-meta.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    let from_meta = meta.and_then(|m| {
        let given = |v: &Value| v.as_i64().filter(|d| *d != 0);
        let own = if text { given(&m["text"]["dimensions"]) } else { None };
        own.or(given(&m["code"]["dimensions"])).or(given(&m["dimensions"]))
    });
    from_meta.map_or(cfg.dimensions, |d| d as i32)
}

/// The full-index health check. A corrupt table is dropped and rebuilt by the index that follows. Today's
/// code also tries a version rollback, but it calls a method the LanceDB package doesn't have, so it never
/// runs and that branch isn't ported. Returns the table's state and how it was repaired.
pub(crate) async fn repair_if_corrupt(store: &Store, table: &str, project: &str, source: &str, cfg: &EmbedConfig, text: bool) -> (&'static str, &'static str) {
    match store.table_health(table, Some(expected_dimensions(cfg, text)), true).await {
        Health::Corrupt(_) => {
            let mut repaired = "none";
            if store.drop_table(table).await.is_ok() {
                repaired = "rebuild";
                debug_emit(json!({ "event": "indexer.repaired", "projectId": project, "sourceId": source, "method": "rebuild" }));
                append_log(&json!({ "ts": now_iso(), "event": "health.repaired-via-rebuild", "projectId": project, "sourceId": source }).to_string());
            }
            ("corrupt", repaired)
        }
        Health::Healthy => ("healthy", "none"),
        Health::Unknown => ("unknown", "none"),
    }
}

/// `debugEmit`: only with SCRYBE_DEBUG_INDEXER=1.
pub(crate) fn debug_emit(record: Value) {
    if !debug_indexer() {
        return;
    }
    let mut line = json!({ "ts": now_iso(), "debug": true });
    for (k, v) in record.as_object().into_iter().flatten() {
        line[k] = v.clone();
    }
    append_log(&line.to_string());
}

/// The indexer's records in the server log, stamped with the run they belong to.
pub(crate) struct Records {
    project: String,
    source: String,
    branch: String,
    mode: &'static str,
    started: std::time::Instant,
}

impl Records {
    pub(crate) fn new(project: &str, source: &str, branch: &str, mode: Mode) -> Self {
        Records { project: project.into(), source: source.into(), branch: branch.into(), mode: if mode == Mode::Full { "full" } else { "incremental" }, started: std::time::Instant::now() }
    }

    fn stamped(&self, event: &str, with_mode: bool, fields: Value) -> Value {
        let mut record = json!({ "event": event, "projectId": self.project, "sourceId": self.source, "branch": self.branch });
        if with_mode {
            record["mode"] = json!(self.mode);
        }
        for (k, v) in fields.as_object().into_iter().flatten() {
            record[k] = v.clone();
        }
        record
    }

    pub(crate) fn scanned(&self, total: usize, to_index: usize, to_remove: &[String], old: usize, current: usize) {
        debug_emit(self.stamped("indexer.phase1", true, json!({ "oldHashesCount": old, "currentSourcesCount": current, "toRemove": to_remove, "toReindexCount": to_index })));
        diag(self.stamped("indexer.scan.completed", true, json!({ "files_total": total, "files_to_reindex": to_index, "files_to_remove": to_remove.len() })));
    }

    pub(crate) fn removed(&self, path: &str) {
        debug_emit(self.stamped("indexer.applyFile", false, json!({ "path": path, "kind": "removed" })));
    }

    pub(crate) fn deduplicated(&self, dropped: usize) {
        if dropped > 0 {
            diag(self.stamped("indexer.flush.intra_batch_dedup", false, json!({ "intra_batch_dupes": dropped })));
        }
    }

    pub(crate) fn written(&self, rows: usize, added: usize, cumulative: usize) {
        if debug_indexer() {
            diag(self.stamped("indexer.write.completed", false, json!({ "chunks_in_batch": rows, "chunks_actually_added": added, "cumulative_chunks_persisted": cumulative })));
        }
    }

    pub(crate) fn embedded(&self, chunks: usize, took: std::time::Duration, cumulative: usize) {
        if debug_indexer() {
            diag(self.stamped("indexer.embed.batch", false, json!({ "batch_size": chunks, "batch_ms": took.as_millis() as u64, "cumulative_chunks_embedded": cumulative })));
        }
    }

    pub(crate) fn pruned(&self, removed: usize, freed: u64) {
        if removed > 0 {
            debug_emit(json!({ "event": "indexer.pruneOrphans", "projectId": self.project, "sourceId": self.source, "removed": removed, "bytesFreed": freed }));
        }
    }

    /// `result` is what the run answers with.
    pub(crate) fn finished(&self, result: &Value) {
        debug_emit(self.stamped("indexer.result", true, json!({ "chunksIndexed": result["chunks_prepared"], "filesScanned": result["files_scanned"], "filesReindexed": result["files_reindexed"], "filesRemoved": result["files_removed"] })));
        let mut fields = json!({});
        for k in ["files_scanned", "files_reindexed", "chunks_prepared", "chunks_persisted"] {
            fields[k] = result[k].clone();
        }
        fields["total_ms"] = json!(self.started.elapsed().as_millis() as u64);
        diag(self.stamped("indexer.job.summary", true, fields));
    }

    pub(crate) fn sha_not_saved(&self, error: &anyhow::Error) {
        diag(self.stamped("indexer.branch_state.write_failed", false, json!({ "error": format!("{error:#}") })));
    }
}

fn debug_indexer() -> bool {
    std::env::var("SCRYBE_DEBUG_INDEXER").as_deref() == Ok("1")
}

fn cursor_present(project: &str, source: &str) -> bool {
    let text = std::fs::read_to_string(cursor_path(project, source)).ok();
    text.and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|v| v["updated_after"].is_string())
}

struct Run<'a> {
    store: &'a Store,
    table: String,
    embedding: EmbedConfig,
    max_chars: usize,
    writer: Writer,
    hashes: HashMap<String, String>,
    hash_path: PathBuf,
    known: HashSet<String>,
    source_hash: HashMap<String, String>,
    batch_size: usize,
    delay_ms: u64,
    halving: Option<Halving>,
    prepared: usize,
    persisted: usize,
    files_reindexed: usize,
    seen_files: HashSet<String>,
    bytes_embedded: u64,
    phase: Phase,
    records: Records,
    options: &'a Options,
}

impl Run<'_> {
    async fn embed(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        match &mut self.halving {
            Some(session) => embed_api::embed_batched(&self.embedding, &texts, self.delay_ms, session).await,
            None => embed::embed_passages(&self.embedding.model, &self.embedding.passage_prefix, texts, self.max_chars, self.batch_size, self.options.download_progress()).await,
        }
    }

    /// `flushBatch`: embed what's new, write it, then checkpoint tags and hashes. The file with chunks still to come
    /// (`open`) gets no hash yet, or a run that ends here would leave it half indexed for good.
    async fn flush(&mut self, batches: &mut Vec<(String, Vec<Chunk>)>, open: Option<&str>) -> Result<()> {
        if batches.is_empty() {
            return Ok(());
        }
        let batch_started = std::time::Instant::now();
        let chunk_count: usize = batches.iter().map(|(_, chunks)| chunks.len()).sum();
        let persisted_before = self.persisted;
        let mut texts = vec![];
        let mut owners = vec![];
        for (_, chunks) in batches.iter() {
            for c in chunks {
                if !self.known.contains(&c.chunk_id) {
                    texts.push(c.content.clone());
                    owners.push(c.clone());
                }
            }
        }
        let embedded = texts.len();
        let batch_bytes: u64 = texts.iter().map(|t| t.len() as u64).sum();
        if !texts.is_empty() {
            let vectors = self.embed(texts).await?;
            self.phase.sample();
            let new_ids: HashSet<&str> = owners.iter().map(|c| c.chunk_id.as_str()).collect();
            self.files_reindexed += batches.iter().filter(|(_, chunks)| chunks.iter().any(|c| new_ids.contains(c.chunk_id.as_str()))).count();
            let rows = dedupe(owners.iter().cloned().zip(vectors).collect());
            self.records.deduplicated(owners.len() - rows.len());
            let before = self.store.count_rows(&self.table).await.unwrap_or(0);
            self.store.upsert_code(&self.table, &rows).await?;
            let after = self.store.count_rows(&self.table).await.unwrap_or(0);
            let added = after.saturating_sub(before);
            self.persisted += added;
            vecindex::record_upsert(&self.table, added, after);
            self.records.written(rows.len(), added, self.persisted);
            self.phase.sample();
        }
        for (i, (key, chunks)) in batches.iter().enumerate() {
            self.writer.add_tags(key, chunks)?;
            for c in chunks {
                self.known.insert(c.chunk_id.clone());
            }
            if open != Some(key.as_str()) {
                self.hashes.insert(key.clone(), self.source_hash[key].clone());
            }
            // A hash file that can't be written must not leave every file of the batch tagged.
            if i == 0 || i + 1 == batches.len() {
                save_hashes(&self.hash_path, &self.hashes)?;
            }
            self.seen_files.insert(key.clone());
            self.prepared += chunks.len();
        }
        self.options.report(Progress::Embed(self.prepared));
        self.bytes_embedded += batch_bytes;
        self.records.embedded(chunk_count, batch_started.elapsed(), self.prepared);
        self.phase.add_work(&[
            ("batches", 1),
            ("chunks_prepared", chunk_count as u64),
            ("chunks_embedded", embedded as u64),
            ("chunks_persisted", (self.persisted - persisted_before) as u64),
            ("bytes_embedded", batch_bytes),
            ("files_checkpointed", batches.len() as u64),
        ]);
        self.phase.set_work(json!({
            "cumulative_chunks_prepared": self.prepared,
            "cumulative_chunks_persisted": self.persisted,
            "cumulative_bytes_embedded": self.bytes_embedded,
            "cumulative_files_seen": self.seen_files.len(),
        }));
        self.phase.maybe_roll();
        batches.clear();
        Ok(())
    }
}

pub async fn index_source(store: &Store, project_id: &str, source_id: &str, mode: Mode, options: &Options) -> Result<Value> {
    refuse_live_data_dir()?;
    let project = registry::get_project(project_id).with_context(|| format!("Project '{project_id}' not found"))?;
    let source: &Source = project.sources.iter().find(|s| s.source_id == source_id).with_context(|| format!("Source '{source_id}' not found in project '{project_id}'"))?;
    if source.kind() == "ticket" {
        return crate::index_ticket::index_ticket_source(store, project_id, source, mode, options).await;
    }
    if source.kind() != "code" {
        bail!("No plugin registered for source type \"{}\"", source.kind());
    }
    let embedding = registry::resolve_embedding(source)?;
    let table = registry::assign_table(project_id, source, &embedding)?;
    let root = PathBuf::from(source.root_path().context("code source without root_path")?);
    let max_chars = embedding.char_cap();
    let branch = options.branch.clone().unwrap_or_else(|| branches::resolve_branch(source));
    let git_ref = options.content_ref.clone().unwrap_or_else(|| branch.clone());
    let sizes = Sizes::from_env();
    let settings = Settings::from_env();

    let ctx = phase::Ctx { project_id: project_id.to_string(), source_id: source_id.to_string(), job_id: options.job_id.clone(), branch: branch.clone(), mode: if mode == Mode::Full { "full" } else { "incremental" } };
    let records = Records::new(project_id, source_id, &branch, mode);
    phase::emit_job_intent(&ctx, "started", json!({ "is_code": true }));
    let provider = if embedding.local { "local" } else { "api" };

    // Same SHA capture point as the TypeScript: before any work starts.
    let sha = git::trimmed(&root, &["rev-parse", &git_ref]);
    let non_head = branch != branches::resolve_branch_for_path(&root);
    if non_head {
        if let Some(ref_to_verify) = options.content_ref.as_ref().or(options.branch.as_ref()) {
            if git::trimmed(&root, &["rev-parse", "--verify", ref_to_verify]).is_none() {
                let hint = if ref_to_verify.starts_with("origin/") { "fetch the ref first".to_string() } else { format!("try 'origin/{ref_to_verify}' or fetch the ref first") };
                bail!("branch '{ref_to_verify}' not found locally — {hint}");
            }
        }
    }

    check_cancel(options)?;
    if mode == Mode::Full {
        embed_api::require_key(&embedding)?;
        let mut phase = Phase::begin(&ctx, "preflight_health");
        phase.set_work(json!({ "table_state": "unknown", "repaired": "none" }));
        let (table_state, repaired) = repair_if_corrupt(store, &table, project_id, source_id, &embedding, false).await;
        phase.set_work(json!({ "table_state": table_state, "repaired": repaired }));
        phase.end(Outcome::Ok);
    }

    let hash_path = hashes_path(project_id, source_id, &branch);
    let mut writer = Writer::open(project_id, source_id, &branch)?;
    let old_hashes = if mode == Mode::Full { HashMap::new() } else { load_hashes(&hash_path) };
    if mode == Mode::Full {
        let _ = std::fs::remove_file(cursor_path(project_id, source_id));
    }

    // What to read, in the order TypeScript reads it: order decides batch-mates, and batch-mates move vectors.
    enum Content {
        File(PathBuf),
        Text(String),
    }
    let cursor_used = mode == Mode::Incremental && cursor_present(project_id, source_id);
    let mut scan_phase = Phase::begin(&ctx, "scan");
    let entries: Vec<(String, Content)> = if non_head {
        scan::scan_ref(&root, &git_ref, Some(project_id), Some(source_id)).into_iter().map(|(rel, text)| (rel, Content::Text(text))).collect()
    } else {
        scan::walk_repo_files(&root, Some(project_id), Some(source_id)).into_iter().map(|(rel, abs)| (rel, Content::File(abs))).collect()
    };
    let mut current: HashMap<String, String> = HashMap::new();
    for (rel, content) in &entries {
        let hash = match content {
            Content::File(abs) => file_hash(abs),
            Content::Text(text) => Some(sha256_hex(text.as_bytes())),
        };
        if let Some(h) = hash {
            current.insert(rel.clone(), h);
        }
        if non_head {
            scan_phase.sample();
        }
    }
    if non_head {
        let cached_bytes: usize = entries.iter().map(|(_, c)| if let Content::Text(t) = c { t.len() } else { 0 }).sum();
        scan_phase.set_work(json!({ "scan_kind": "git-ref", "sources_found": current.len(), "cached_content_bytes": cached_bytes }));
    } else {
        scan_phase.set_work(json!({ "scan_kind": "working-tree", "sources_found": current.len(), "cursor_used": cursor_used }));
    }
    scan_phase.end(Outcome::Ok);

    let mut diff_phase = Phase::begin(&ctx, "diff");
    for n in 0..=current.len() {
        if let Err(e) = check_cancel(options) {
            diff_phase.end(Outcome::of(&e));
            return Err(e);
        }
        if n > 0 {
            options.report(Progress::Scan(n));
        }
    }
    let to_remove: Vec<String> = old_hashes.keys().filter(|p| !current.contains_key(*p)).cloned().collect();
    let mut to_index: HashSet<String> = current.iter().filter(|(p, h)| old_hashes.get(*p) != Some(*h)).map(|(p, _)| p.clone()).collect();
    diff_phase.sample();
    diff_phase.set_work(json!({ "files_total": current.len(), "prior_hashes": old_hashes.len(), "files_to_reindex": to_index.len(), "files_to_remove": to_remove.len() }));
    diff_phase.end(Outcome::Ok);
    records.scanned(current.len(), to_index.len(), &to_remove, old_hashes.len(), current.len());
    phase::emit_job_intent(&ctx, "planned", json!({
        "files_total": current.len(),
        "files_to_reindex": if mode == Mode::Full { current.len() } else { to_index.len() },
        "files_to_remove": to_remove.len(),
        "is_non_head_branch": non_head,
        "provider": provider,
    }));

    let mut stale_phase = Phase::begin(&ctx, "stale_apply");
    let mut known = HashSet::new();
    let mut hashes = old_hashes.clone();
    if mode == Mode::Full {
        // The rows last: a run killed in between must not leave an empty table that counts as indexed.
        hashes.clear();
        save_hashes(&hash_path, &hashes)?;
        writer.wipe_branch()?;
        store.delete_project_rows(&table, project_id).await?;
        to_index.extend(current.keys().cloned());
    } else {
        known = branches::all_chunk_ids_for_source(&writer, project_id, source_id)?;
        if !to_index.is_empty() && !known.is_empty() {
            // A full run of one branch deletes the rows of them all and leaves the others' tags.
            let present: HashSet<String> = store.list_chunk_ids(&table, project_id).await?.into_iter().collect();
            known.retain(|id| present.contains(id));
        }
        for p in &to_remove {
            writer.remove_file(p)?;
            hashes.remove(p);
            stale_phase.sample();
            records.removed(p);
        }
        for p in &to_index {
            writer.remove_file(p)?;
            stale_phase.sample();
        }
        if !to_remove.is_empty() {
            save_hashes(&hash_path, &hashes)?;
        }
    }
    let bytes_to_read: u64 = entries
        .iter()
        .filter(|(rel, _)| to_index.contains(rel))
        .map(|(_, content)| match content {
            Content::Text(text) => text.len() as u64,
            Content::File(abs) => {
                stale_phase.sample();
                std::fs::metadata(abs).map_or(0, |m| m.len())
            }
        })
        .sum();
    stale_phase.set_work(json!({ "files_to_reindex": to_index.len(), "files_to_remove": to_remove.len(), "known_chunk_ids": known.len(), "bytes_to_read": bytes_to_read }));
    stale_phase.end(Outcome::Ok);

    let ceiling = env_int("SCRYBE_EMBED_BATCH_SIZE").map_or(100, |n| n as usize);
    let delay_ms = env_int("SCRYBE_EMBED_BATCH_DELAY_MS").map_or(0, |n| n as u64);
    let state_key = format!("{project_id}:{source_id}:{}:{}", if embedding.base_url.is_empty() { "local" } else { &embedding.base_url }, embedding.model);
    let state = (!embedding.local).then(|| embed_api::read_entry(&state_key)).flatten();
    let batch_size = if embedding.local { ceiling } else { embed_api::probe_size(state, ceiling) };
    let halving = (!embedding.local).then_some(Halving { effective: batch_size, max_failed: state.map(|s| s.max_failed), halved: false });

    let mut phase = Phase::begin(&ctx, "chunk_embed");
    phase.set_work(json!({ "batch_size": batch_size, "provider": provider }));
    let mut run = Run { store, table: table.clone(), embedding, max_chars, writer, hashes, hash_path, known, source_hash: current.clone(), batch_size, delay_ms, halving, prepared: 0, persisted: 0, files_reindexed: 0, seen_files: HashSet::new(), bytes_embedded: 0, phase, records, options };
    let mut batches: Vec<(String, Vec<Chunk>)> = vec![];
    let mut pending = 0;
    let mut chunks_seen = 0usize;
    let streamed: Result<()> = async {
        for (rel, content) in entries {
            if !to_index.contains(&rel) {
                continue;
            }
            check_cancel(options)?;
            let text = match content {
                Content::Text(text) => text,
                Content::File(abs) => {
                    let Ok(bytes) = std::fs::read(&abs) else { continue };
                    String::from_utf8_lossy(&bytes).into_owned()
                }
            };
            let lang = scan::language_of(&rel).unwrap_or("").to_string();
            let (p, s, r) = (project_id.to_string(), source_id.to_string(), rel.clone());
            let chunks = tokio::task::spawn_blocking(move || {
                let text = normalize_content(&text);
                chunk::chunk_file(&p, &s, &r, &text, &lang, Some(max_chars), sizes)
            })
            .await?;
            let mut left = chunks.len();
            for c in chunks {
                left -= 1;
                match batches.last_mut() {
                    Some((key, list)) if *key == rel => list.push(c),
                    _ => batches.push((rel.clone(), vec![c])),
                }
                pending += 1;
                chunks_seen += 1;
                if chunks_seen & 0x3f == 0 {
                    run.phase.sample();
                }
                if pending >= batch_size {
                    check_cancel(options)?;
                    run.flush(&mut batches, (left > 0).then_some(rel.as_str())).await?;
                    pending = 0;
                }
            }
        }
        run.flush(&mut batches, None).await
    }
    .await;
    if let Err(e) = streamed {
        run.phase.end(Outcome::of(&e));
        return Err(e);
    }

    // Files that produced no chunks still get a hash, or every run re-marks them.
    let zero_chunk_files = to_index.iter().filter(|p| !run.seen_files.contains(*p)).count();
    run.phase.set_work(json!({ "zero_chunk_files": zero_chunk_files }));
    for p in &to_index {
        if !run.seen_files.contains(p) {
            if let Some(h) = current.get(p) {
                run.hashes.insert(p.clone(), h.clone());
            }
        }
    }
    if zero_chunk_files > 0 {
        let _ = save_hashes(&run.hash_path, &run.hashes);
    }
    run.phase.end(Outcome::Ok);

    if let Some(session) = &run.halving {
        let existing = state.map_or(0, |s| s.max_failed);
        let max_failed = if session.halved { session.max_failed.unwrap_or(existing) } else { existing };
        embed_api::write_entry(&state_key, Entry { last_successful: session.effective, max_failed })?;
    }

    let now = now_iso();
    registry::update_source(project_id, source_id, &[("last_indexed", json!(now)), ("embedding_schema_version", json!(2))])?;
    if !non_head {
        let cursor = cursor_path(project_id, source_id);
        std::fs::create_dir_all(cursor.parent().unwrap())?;
        std::fs::write(&cursor, json!({ "updated_after": now }).to_string())?;
    }

    let did_work = !to_index.is_empty() || !to_remove.is_empty();
    if did_work && settings.hybrid_enabled {
        let mut fts_phase = Phase::begin(&ctx, "fts_index");
        let built = match store.create_fts_index(&table).await {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[scrybe] FTS index creation failed (hybrid search will fall back to vector-only): {e:#}");
                false
            }
        };
        fts_phase.set_work(json!({ "built": built }));
        fts_phase.end(Outcome::Ok);
    }
    if did_work {
        // Housekeeping: a failure here must not fail an index that has already been written.
        let mut compact_phase = Phase::begin(&ctx, "compact");
        let compacted = store.compact_with_grace(&table).await.is_ok();
        compact_phase.set_work(json!({ "compacted": compacted }));
        compact_phase.end(Outcome::Ok);
        let mut prune_phase = Phase::begin(&ctx, "prune_orphans");
        let (removed, freed) = store.prune_index_orphans(&table);
        run.records.pruned(removed, freed);
        prune_phase.set_work(json!({ "orphans_removed": removed }));
        prune_phase.end(Outcome::Ok);
        if mode == Mode::Full {
            vecindex::mark_full_reindex(&table);
        }
    }
    store.invalidate_health(&table);
    let result = json!({
        "status": "ok",
        "project_id": project_id,
        "source_id": source_id,
        "chunks_prepared": run.prepared,
        "chunks_persisted": run.persisted,
        "files_scanned": current.len(),
        "files_reindexed": run.files_reindexed,
        "files_removed": to_remove.len(),
    });
    run.records.finished(&result);
    if let Some(sha) = sha {
        if let Err(e) = run.writer.set_last_indexed_sha(&sha) {
            run.records.sha_not_saved(&e);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_slug_matches_hash_file_names() {
        assert_eq!(slug("feat/x"), "feat__x");
        assert_eq!(slug("*"), "_all_");
    }
}
