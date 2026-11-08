//! Indexes one code source. Mirrors the code path of `indexSource` in `src/indexer.ts`, from the working
//! tree or from a git ref. Not yet: ticket sources, phase telemetry, the rebuild-cadence bookkeeping.
use crate::branches::{self, Writer};
use crate::chunk::{self, Chunk, Sizes};
use crate::config::{data_dir, Settings};
use crate::embed;
use crate::embed_api::{self, Entry, Halving};
use crate::git;
use crate::jsstr::normalize_content;
use crate::registry::{self, EmbedConfig, Source};
use crate::scan;
use crate::store::{Health, Store};
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
}

/// The error a cancelled run ends with.
pub const CANCELLED: &str = "INDEX_CANCELLED";

fn check_cancel(options: &Options) -> Result<()> {
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

fn cursor_path(project: &str, source: &str) -> PathBuf {
    data_dir().join("cursors").join(format!("{project}__{source}.json"))
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// First-seen chunk id wins: LanceDB's mergeInsert inserts every duplicate in one source batch.
fn dedupe(rows: Vec<(Chunk, Vec<f32>)>) -> Vec<(Chunk, Vec<f32>)> {
    let mut seen = HashSet::new();
    rows.into_iter().filter(|(c, _)| seen.insert(c.chunk_id.clone())).collect()
}

fn expected_dimensions(cfg: &EmbedConfig) -> i32 {
    let meta: Option<Value> = std::fs::read_to_string(data_dir().join("embedding-meta.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    let from_meta = meta.and_then(|m| m["code"]["dimensions"].as_i64().or(m["dimensions"].as_i64()));
    from_meta.map_or(cfg.dimensions, |d| d as i32)
}

/// The full-index health check. A corrupt table is dropped and rebuilt by the index that follows. Today's
/// code also tries a version rollback, but it calls a method the LanceDB package doesn't have, so it never
/// runs and that branch isn't ported.
async fn repair_if_corrupt(store: &Store, table: &str, project: &str, source: &str, cfg: &EmbedConfig) {
    if let Health::Corrupt(reason) = store.table_health(table, Some(expected_dimensions(cfg))).await {
        eprintln!("[scrybe] table {table} is corrupt ({reason}): rebuilding");
        if store.drop_table_and_files(table).await.is_ok() {
            let line = json!({ "ts": now_iso(), "event": "health.repaired-via-rebuild", "projectId": project, "sourceId": source });
            let log = std::env::var_os("SCRYBE_DAEMON_LOG_PATH").map_or_else(|| data_dir().join("daemon-log.jsonl"), PathBuf::from);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
                use std::io::Write;
                let _ = writeln!(f, "{line}");
            }
        }
    }
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
    started: std::time::Instant,
}

impl Run<'_> {
    async fn embed(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        match &mut self.halving {
            Some(session) => embed_api::embed_batched(&self.embedding, &texts, self.delay_ms, session).await,
            None => embed::embed_passages(&self.embedding.model, &self.embedding.passage_prefix, texts, self.max_chars, self.batch_size).await,
        }
    }

    /// `flushBatch`: embed what's new, write it, then checkpoint tags and hashes.
    async fn flush(&mut self, batches: &mut Vec<(String, Vec<Chunk>)>) -> Result<()> {
        if batches.is_empty() {
            return Ok(());
        }
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
        if !texts.is_empty() {
            let vectors = self.embed(texts).await?;
            let new_ids: HashSet<&str> = owners.iter().map(|c| c.chunk_id.as_str()).collect();
            self.files_reindexed += batches.iter().filter(|(_, chunks)| chunks.iter().any(|c| new_ids.contains(c.chunk_id.as_str()))).count();
            let rows = dedupe(owners.iter().cloned().zip(vectors).collect());
            let before = self.store.count_rows(&self.table).await.unwrap_or(0);
            self.store.upsert_code(&self.table, &rows).await?;
            let after = self.store.count_rows(&self.table).await.unwrap_or(0);
            self.persisted += after.saturating_sub(before);
        }
        for (key, chunks) in batches.iter() {
            self.writer.add_tags(key, chunks)?;
            for c in chunks {
                self.known.insert(c.chunk_id.clone());
            }
            self.hashes.insert(key.clone(), self.source_hash[key].clone());
            self.seen_files.insert(key.clone());
            self.prepared += chunks.len();
        }
        save_hashes(&self.hash_path, &self.hashes)?;
        batches.clear();
        eprintln!("chunks {} persisted {} files {} after {:.0}s", self.prepared, self.persisted, self.seen_files.len(), self.started.elapsed().as_secs_f64());
        Ok(())
    }
}

pub async fn index_source(store: &Store, project_id: &str, source_id: &str, mode: Mode, options: &Options) -> Result<Value> {
    refuse_live_data_dir()?;
    let started = std::time::Instant::now();
    let project = registry::get_project(project_id).with_context(|| format!("Project '{project_id}' not found"))?;
    let source: &Source = project.sources.iter().find(|s| s.source_id == source_id).with_context(|| format!("Source '{source_id}' not found in project '{project_id}'"))?;
    if source.kind() != "code" {
        bail!("this build only indexes code sources, not ticket sources yet");
    }
    let embedding = registry::resolve_embedding(source)?;
    let table = match &source.table_name {
        Some(t) => t.clone(),
        None => {
            let name = registry::table_name_for(project_id, source, &embedding);
            registry::update_source(project_id, source_id, &[("table_name", json!(name))])?;
            name
        }
    };
    let root = PathBuf::from(source.root_path().context("code source without root_path")?);
    let max_chars = embedding.char_cap();
    let branch = options.branch.clone().unwrap_or_else(|| branches::resolve_branch(source));
    let git_ref = options.content_ref.clone().unwrap_or_else(|| branch.clone());
    let sizes = Sizes::from_env();
    let settings = Settings::from_env();

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
        repair_if_corrupt(store, &table, project_id, source_id, &embedding).await;
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
    }
    let to_remove: Vec<String> = old_hashes.keys().filter(|p| !current.contains_key(*p)).cloned().collect();
    let mut to_index: HashSet<String> = current.iter().filter(|(p, h)| old_hashes.get(*p) != Some(*h)).map(|(p, _)| p.clone()).collect();

    let mut known = HashSet::new();
    let mut hashes = old_hashes.clone();
    if mode == Mode::Full {
        store.delete_project_rows(&table, project_id).await?;
        writer.wipe_branch()?;
        hashes.clear();
        save_hashes(&hash_path, &hashes)?;
        to_index.extend(current.keys().cloned());
    } else {
        known = branches::all_chunk_ids_for_source(&writer, project_id, source_id)?;
        for p in &to_remove {
            writer.remove_file(p)?;
            hashes.remove(p);
        }
        for p in &to_index {
            writer.remove_file(p)?;
        }
        save_hashes(&hash_path, &hashes)?;
    }

    let ceiling: usize = std::env::var("SCRYBE_EMBED_BATCH_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(100);
    let delay_ms: u64 = std::env::var("SCRYBE_EMBED_BATCH_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let state_key = format!("{project_id}:{source_id}:{}:{}", if embedding.base_url.is_empty() { "local" } else { &embedding.base_url }, embedding.model);
    let state = (!embedding.local).then(|| embed_api::read_entry(&state_key)).flatten();
    let batch_size = if embedding.local { ceiling } else { embed_api::probe_size(state, ceiling) };
    let halving = (!embedding.local).then_some(Halving { effective: batch_size, max_failed: state.map(|s| s.max_failed), halved: false });

    let mut run = Run { store, table: table.clone(), embedding, max_chars, writer, hashes, hash_path, known, source_hash: current.clone(), batch_size, delay_ms, halving, prepared: 0, persisted: 0, files_reindexed: 0, seen_files: HashSet::new(), started };
    let mut batches: Vec<(String, Vec<Chunk>)> = vec![];
    let mut pending = 0;
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
        for c in chunks {
            match batches.last_mut() {
                Some((key, list)) if *key == rel => list.push(c),
                _ => batches.push((rel.clone(), vec![c])),
            }
            pending += 1;
            if pending >= batch_size {
                check_cancel(options)?;
                run.flush(&mut batches).await?;
                pending = 0;
            }
        }
    }
    run.flush(&mut batches).await?;

    // Files that produced no chunks still get a hash, or every run re-marks them.
    for p in &to_index {
        if !run.seen_files.contains(p) {
            if let Some(h) = current.get(p) {
                run.hashes.insert(p.clone(), h.clone());
            }
        }
    }
    save_hashes(&run.hash_path, &run.hashes)?;

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
        if let Err(e) = store.create_fts_index(&table).await {
            eprintln!("[scrybe] FTS index creation failed (hybrid search will fall back to vector-only): {e:#}");
        }
    }
    if did_work {
        // Housekeeping: a failure here must not fail an index that has already been written.
        let _ = store.compact_with_grace(&table).await;
        store.prune_index_orphans(&table);
    }
    if let Some(sha) = sha {
        if let Err(e) = run.writer.set_last_indexed_sha(&sha) {
            eprintln!("[scrybe] could not record the indexed commit: {e:#}");
        }
    }
    Ok(json!({
        "status": "ok",
        "project_id": project_id,
        "source_id": source_id,
        "chunks_prepared": run.prepared,
        "chunks_persisted": run.persisted,
        "files_scanned": current.len(),
        "files_reindexed": run.files_reindexed,
        "files_removed": to_remove.len(),
    }))
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
