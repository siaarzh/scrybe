//! Indexes one code source. Mirrors the code path of `indexSource` in `src/indexer.ts`.
//! Code sources from the working tree only. Not yet: ticket sources, git refs,
//! pinned branches, corruption repair, phase telemetry, index-orphan pruning, API embedders.
use crate::branches::{self, Writer};
use crate::chunk::{self, Chunk, Sizes};
use crate::config::{data_dir, Settings};
use crate::embed;
use crate::jsstr::normalize_content;
use crate::registry::{self, Source};
use crate::scan;
use crate::store::{escape_sql, Store};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Full,
    Incremental,
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

fn file_hash(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect())
}

fn slug(branch: &str) -> String {
    if branch == "*" { "_all_".to_string() } else { branch.replace('/', "__") }
}

fn hashes_path(project: &str, source: &str, branch: &str) -> PathBuf {
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

/// `updateSource`: patches the registry as JSON so fields this code doesn't know survive.
fn stamp_source(project: &str, source: &str, now: &str) -> Result<()> {
    let path = data_dir().join("projects.json");
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    for p in doc.as_array_mut().context("projects.json is not a list")? {
        if p["id"] != project {
            continue;
        }
        for s in p["sources"].as_array_mut().into_iter().flatten() {
            if s["source_id"] == source {
                s["last_indexed"] = json!(now);
                s["embedding_schema_version"] = json!(2);
            }
        }
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// First-seen chunk id wins: LanceDB's mergeInsert inserts every duplicate in one source batch.
fn dedupe(rows: Vec<(Chunk, Vec<f32>)>) -> Vec<(Chunk, Vec<f32>)> {
    let mut seen = HashSet::new();
    rows.into_iter().filter(|(c, _)| seen.insert(c.chunk_id.clone())).collect()
}

struct Run<'a> {
    store: &'a Store,
    table: String,
    model: String,
    prefix: String,
    max_chars: usize,
    writer: Writer,
    hashes: HashMap<String, String>,
    hash_path: PathBuf,
    known: HashSet<String>,
    file_hash: HashMap<String, String>,
    batch_size: usize,
    prepared: usize,
    embedded: usize,
    seen_files: HashSet<String>,
    started: std::time::Instant,
}

impl Run<'_> {
    /// `flushBatch`: embed what's new, write it, then checkpoint tags and hashes.
    async fn flush(&mut self, batches: &mut Vec<(String, Vec<Chunk>)>) -> Result<()> {
        if batches.is_empty() {
            return Ok(());
        }
        let mut new_ids = HashSet::new();
        let mut texts = vec![];
        let mut owners = vec![];
        for (_, chunks) in batches.iter() {
            for c in chunks {
                if !self.known.contains(&c.chunk_id) {
                    texts.push(c.content.clone());
                    owners.push(c.clone());
                    new_ids.insert(c.chunk_id.clone());
                }
            }
        }
        if !texts.is_empty() {
            let vectors = embed::embed_passages(&self.model, &self.prefix, texts, self.max_chars, self.batch_size).await?;
            self.embedded += vectors.len();
            let rows = dedupe(owners.into_iter().zip(vectors).collect());
            self.store.upsert_code(&self.table, &rows).await?;
        }
        for (key, chunks) in batches.iter() {
            self.writer.add_tags(key, chunks)?;
            for c in chunks {
                self.known.insert(c.chunk_id.clone());
            }
            self.hashes.insert(key.clone(), self.file_hash[key].clone());
            self.seen_files.insert(key.clone());
            self.prepared += chunks.len();
        }
        save_hashes(&self.hash_path, &self.hashes)?;
        batches.clear();
        eprintln!("chunks {} embedded {} files {} after {:.0}s", self.prepared, self.embedded, self.seen_files.len(), self.started.elapsed().as_secs_f64());
        Ok(())
    }
}

pub async fn index_source(store: &Store, project_id: &str, source_id: &str, mode: Mode) -> Result<Value> {
    refuse_live_data_dir()?;
    let started = std::time::Instant::now();
    let project = registry::get_project(project_id).with_context(|| format!("Project '{project_id}' not found"))?;
    let source: &Source = project.sources.iter().find(|s| s.source_id == source_id).with_context(|| format!("Source '{source_id}' not found in project '{project_id}'"))?;
    if source.kind() != "code" {
        bail!("this build only indexes code sources, not ticket sources yet");
    }
    let table = source.table_name.clone().context("source has no table_name: assigning one is not ported yet")?;
    let root = PathBuf::from(source.root_path().context("code source without root_path")?);
    let (model, _) = registry::resolve_local_model(source)?;
    let prefix = registry::passage_prefix(source)?;
    let max_chars = registry::char_cap(source)?;
    let branch = branches::resolve_branch(source);
    let sizes = Sizes::from_env();
    let hybrid = Settings::from_env().hybrid_enabled;

    let hash_path = hashes_path(project_id, source_id, &branch);
    let mut writer = Writer::open(project_id, source_id, &branch)?;
    let old_hashes = if mode == Mode::Full { HashMap::new() } else { load_hashes(&hash_path) };

    // Same SHA capture point as the TypeScript: before any work starts.
    let sha = std::process::Command::new("git").args(["rev-parse", &branch]).current_dir(&root).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    let files = scan::walk_repo_files(&root, Some(project_id), Some(source_id));
    let mut current: HashMap<String, String> = HashMap::new();
    for (rel, abs) in &files {
        if let Some(h) = file_hash(abs) {
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
        let _ = std::fs::remove_file(cursor_path(project_id, source_id));
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

    let batch_size: usize = std::env::var("SCRYBE_EMBED_BATCH_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(100);
    let mut run = Run { store, table: table.clone(), model, prefix, max_chars, writer, hashes, hash_path, known, file_hash: current.clone(), batch_size, prepared: 0, embedded: 0, seen_files: HashSet::new(), started };
    let mut batches: Vec<(String, Vec<Chunk>)> = vec![];
    let mut pending = 0;
    for (rel, abs) in &files {
        if !to_index.contains(rel) {
            continue;
        }
        let Ok(bytes) = std::fs::read(abs) else { continue };
        let lang = scan::language_of(rel).unwrap_or("").to_string();
        let (p, s, r) = (project_id.to_string(), source_id.to_string(), rel.clone());
        let chunks = tokio::task::spawn_blocking(move || {
            let text = normalize_content(&String::from_utf8_lossy(&bytes));
            chunk::chunk_file(&p, &s, &r, &text, &lang, Some(max_chars), sizes)
        })
        .await?;
        for c in chunks {
            match batches.last_mut() {
                Some((key, list)) if key == rel => list.push(c),
                _ => batches.push((rel.clone(), vec![c])),
            }
            pending += 1;
            if pending >= batch_size {
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

    let now = now_iso();
    stamp_source(project_id, source_id, &now)?;
    let cursor = cursor_path(project_id, source_id);
    std::fs::create_dir_all(cursor.parent().unwrap())?;
    std::fs::write(&cursor, json!({ "updated_after": now }).to_string())?;

    let did_work = !to_index.is_empty() || !to_remove.is_empty();
    if did_work && hybrid {
        store.create_fts_index(&table).await?;
    }
    if did_work {
        store.compact_with_grace(&table).await?;
    }
    if let Some(sha) = sha {
        run.writer.set_last_indexed_sha(&sha)?;
    }
    Ok(json!({
        "status": "ok",
        "project_id": project_id,
        "source_id": source_id,
        "branch": branch,
        "files_scanned": current.len(),
        "files_reindexed": to_index.len(),
        "files_removed": to_remove.len(),
        "chunks_prepared": run.prepared,
        "chunks_embedded": run.embedded,
        "seconds": (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "where": escape_sql(&table),
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
