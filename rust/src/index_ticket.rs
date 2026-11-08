//! Indexes one ticket source. Mirrors the non-code path of `indexSource` in `src/indexer.ts`, with the
//! GitLab plugin behind it. Not yet: the ticket poller, GitHub issues.
use crate::branches::{self, Writer};
use crate::chunk::Sizes;
use crate::config::Settings;
use crate::embed;
use crate::embed_api::{self, Entry, Halving};
use crate::gitlab_issues::{self, KnowledgeChunk};
use crate::index::{check_cancel, cursor_path, hashes_path, now_iso, repair_if_corrupt, Mode, Options};
use crate::phase::{self, Outcome, Phase};
use crate::registry::{self, EmbedConfig, Source};
use crate::store::Store;
use crate::vecindex;
use anyhow::{bail, Result};
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// A JS object of strings: it keeps the order keys were first added, which decides the order issues are fetched.
#[derive(Clone, Default)]
struct Ordered(Vec<(String, String)>);

impl Ordered {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    fn set(&mut self, key: &str, value: &str) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value.to_string(),
            None => self.0.push((key.to_string(), value.to_string())),
        }
    }
    fn remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }
}

impl Serialize for Ordered {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a map of strings")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut out = Ordered::default();
                while let Some((k, v)) = m.next_entry::<String, String>()? {
                    out.set(&k, &v);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V)
    }
}

fn load_hashes(path: &Path) -> Ordered {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_hashes(path: &Path, hashes: &Ordered) -> Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(hashes)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn load_cursor(project: &str, source: &str) -> Option<String> {
    let text = std::fs::read_to_string(cursor_path(project, source)).ok()?;
    serde_json::from_str::<Value>(&text).ok()?["updated_after"].as_str().map(String::from)
}

struct Run<'a> {
    store: &'a Store,
    table: String,
    embedding: EmbedConfig,
    max_chars: usize,
    hashes: Ordered,
    hash_path: PathBuf,
    known: HashSet<String>,
    merged: Ordered,
    batch_size: usize,
    delay_ms: u64,
    halving: Option<Halving>,
    prepared: usize,
    persisted: usize,
    files_reindexed: usize,
    seen_files: HashSet<String>,
    started: std::time::Instant,
    bytes_embedded: u64,
    phase: Phase,
}

impl Run<'_> {
    async fn embed(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        match &mut self.halving {
            Some(session) => embed_api::embed_batched(&self.embedding, &texts, self.delay_ms, session).await,
            None => embed::embed_passages(&self.embedding.model, &self.embedding.passage_prefix, texts, self.max_chars, self.batch_size).await,
        }
    }

    /// `flushBatch`: embed what's new, write it, then checkpoint the hashes. Ticket chunks carry no branch tags.
    async fn flush(&mut self, batches: &mut Vec<(String, Vec<KnowledgeChunk>)>) -> Result<()> {
        if batches.is_empty() {
            return Ok(());
        }
        let chunk_count: usize = batches.iter().map(|(_, chunks)| chunks.len()).sum();
        let persisted_before = self.persisted;
        let to_embed: Vec<&KnowledgeChunk> = batches.iter().flat_map(|(_, chunks)| chunks.iter()).filter(|c| !self.known.contains(&c.chunk_id)).collect();
        let embedded = to_embed.len();
        let batch_bytes: u64 = to_embed.iter().map(|c| c.content.len() as u64).sum();
        if embedded > 0 {
            let texts: Vec<String> = to_embed.iter().map(|c| c.content.clone()).collect();
            let owners: Vec<KnowledgeChunk> = to_embed.iter().map(|c| (*c).clone()).collect();
            let vectors = self.embed(texts).await?;
            self.phase.sample();
            // Same-id chunks share the last vector, then the first row wins.
            let by_id: HashMap<String, Vec<f32>> = owners.iter().map(|c| c.chunk_id.clone()).zip(vectors.iter().cloned()).collect();
            self.files_reindexed += batches.iter().filter(|(_, chunks)| chunks.iter().any(|c| by_id.contains_key(&c.chunk_id))).count();
            let mut seen = HashSet::new();
            let rows: Vec<(KnowledgeChunk, Vec<f32>)> = batches
                .iter()
                .flat_map(|(_, chunks)| chunks.iter())
                .filter(|c| by_id.contains_key(&c.chunk_id) && seen.insert(c.chunk_id.clone()))
                .map(|c| (c.clone(), by_id[&c.chunk_id].clone()))
                .collect();
            let before = self.store.count_rows(&self.table).await.unwrap_or(0);
            self.store.upsert_knowledge(&self.table, &rows).await?;
            let after = self.store.count_rows(&self.table).await.unwrap_or(0);
            let added = after.saturating_sub(before);
            self.persisted += added;
            vecindex::record_upsert(&self.table, added, after);
            self.phase.sample();
        }
        for (key, chunks) in batches.iter() {
            // A comment's path has no entry in the scan, so it never gets a hash.
            if let Some(hash) = self.merged.get(key).map(String::from) {
                self.hashes.set(key, &hash);
            }
            self.seen_files.insert(key.clone());
            self.prepared += chunks.len();
        }
        save_hashes(&self.hash_path, &self.hashes)?;
        self.bytes_embedded += batch_bytes;
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
        eprintln!("chunks {} persisted {} files {} after {:.0}s", self.prepared, self.persisted, self.seen_files.len(), self.started.elapsed().as_secs_f64());
        Ok(())
    }
}

pub async fn index_ticket_source(store: &Store, project_id: &str, source: &Source, mode: Mode, options: &Options) -> Result<Value> {
    let source_id = source.source_id.as_str();
    let started = std::time::Instant::now();
    if source.source_config.get("provider").and_then(Value::as_str) == Some("github") {
        bail!("GitHub ticket sources are not supported by this build yet");
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
    let max_chars = embedding.char_cap();
    let sizes = Sizes::from_env();
    let settings = Settings::from_env();
    // Ticket sources always use the "*" branch.
    let branch = "*";

    let ctx = phase::Ctx { project_id: project_id.to_string(), source_id: source_id.to_string(), job_id: options.job_id.clone(), branch: branch.to_string(), mode: if mode == Mode::Full { "full" } else { "incremental" } };
    phase::emit_job_intent(&ctx, "started", json!({ "is_code": false }));
    let provider = if embedding.local { "local" } else { "api" };

    check_cancel(options)?;
    if mode == Mode::Full {
        let mut phase = Phase::begin(&ctx, "preflight_health");
        phase.set_work(json!({ "table_state": "unknown", "repaired": "none" }));
        let (table_state, repaired) = repair_if_corrupt(store, &table, project_id, source_id, &embedding, true).await;
        phase.set_work(json!({ "table_state": table_state, "repaired": repaired }));
        phase.end(Outcome::Ok);
    }

    let hash_path = hashes_path(project_id, source_id, branch);
    let mut writer = Writer::open(project_id, source_id, branch)?;
    let old_hashes = if mode == Mode::Full { Ordered::default() } else { load_hashes(&hash_path) };
    if mode == Mode::Full {
        let _ = std::fs::remove_file(cursor_path(project_id, source_id));
    }
    let cursor = if mode == Mode::Full { None } else { load_cursor(project_id, source_id) };

    let mut scan_phase = Phase::begin(&ctx, "scan");
    let scanned = match gitlab_issues::scan_sources(project_id, source, cursor.as_deref()).await {
        Ok(s) => Ordered(s),
        Err(e) => {
            scan_phase.end(Outcome::of(&e));
            return Err(e);
        }
    };
    scan_phase.set_work(json!({ "scan_kind": "plugin-fetch", "sources_found": scanned.0.len(), "cursor_used": cursor.is_some() }));
    scan_phase.end(Outcome::Ok);

    // With a cursor the scan is only what changed, so nothing is ever removed.
    let effective_cursor = cursor.as_deref().is_some_and(|c| !c.is_empty());
    let mut merged = if effective_cursor { old_hashes.clone() } else { Ordered::default() };
    for (k, v) in &scanned.0 {
        merged.set(k, v);
    }

    let mut diff_phase = Phase::begin(&ctx, "diff");
    let to_remove: Vec<String> = if effective_cursor { vec![] } else { old_hashes.0.iter().filter(|(p, _)| scanned.get(p).is_none()).map(|(p, _)| p.clone()).collect() };
    let mut to_index: Vec<String> = merged.0.iter().filter(|(p, h)| old_hashes.get(p) != Some(h.as_str())).map(|(p, _)| p.clone()).collect();
    diff_phase.sample();
    diff_phase.set_work(json!({ "files_total": merged.0.len(), "prior_hashes": old_hashes.0.len(), "files_to_reindex": to_index.len(), "files_to_remove": to_remove.len() }));
    diff_phase.end(Outcome::Ok);
    phase::emit_job_intent(&ctx, "planned", json!({
        "files_total": merged.0.len(),
        "files_to_reindex": if mode == Mode::Full { scanned.0.len() } else { to_index.len() },
        "files_to_remove": to_remove.len(),
        "is_non_head_branch": false,
        "provider": provider,
    }));

    let mut stale_phase = Phase::begin(&ctx, "stale_apply");
    let mut known = HashSet::new();
    let mut hashes = old_hashes.clone();
    if mode == Mode::Full {
        store.delete_project_rows(&table, project_id).await?;
        writer.wipe_branch()?;
        hashes = Ordered::default();
        save_hashes(&hash_path, &hashes)?;
        for (k, _) in &scanned.0 {
            if !to_index.contains(k) {
                to_index.push(k.clone());
            }
        }
    } else {
        known = branches::all_chunk_ids_for_source(&writer, project_id, source_id)?;
        for p in &to_remove {
            writer.remove_file(p)?;
            hashes.remove(p);
            stale_phase.sample();
        }
        for p in &to_index {
            writer.remove_file(p)?;
            stale_phase.sample();
        }
        save_hashes(&hash_path, &hashes)?;
    }
    stale_phase.set_work(json!({ "files_to_reindex": to_index.len(), "files_to_remove": to_remove.len(), "known_chunk_ids": known.len(), "bytes_to_read": 0 }));
    stale_phase.end(Outcome::Ok);

    let ceiling: usize = std::env::var("SCRYBE_EMBED_BATCH_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(100);
    let delay_ms: u64 = std::env::var("SCRYBE_EMBED_BATCH_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let state_key = format!("{project_id}:{source_id}:{}:{}", if embedding.base_url.is_empty() { "local" } else { &embedding.base_url }, embedding.model);
    let state = (!embedding.local).then(|| embed_api::read_entry(&state_key)).flatten();
    let batch_size = if embedding.local { ceiling } else { embed_api::probe_size(state, ceiling) };
    let halving = (!embedding.local).then_some(Halving { effective: batch_size, max_failed: state.map(|s| s.max_failed), halved: false });

    let mut phase = Phase::begin(&ctx, "chunk_embed");
    phase.set_work(json!({ "batch_size": batch_size, "provider": provider }));
    let mut run = Run { store, table: table.clone(), embedding, max_chars, hashes, hash_path, known, merged, batch_size, delay_ms, halving, prepared: 0, persisted: 0, files_reindexed: 0, seen_files: HashSet::new(), started, bytes_embedded: 0, phase };
    let mut batches: Vec<(String, Vec<KnowledgeChunk>)> = vec![];
    let mut pending = 0;
    let mut chunks_seen = 0usize;
    let streamed: Result<()> = async {
        for key in &to_index {
            check_cancel(options)?;
            let Some(chunks) = gitlab_issues::fetch_issue_chunks(project_id, source, key, sizes).await? else { continue };
            for c in chunks {
                match batches.last_mut() {
                    Some((k, list)) if *k == c.item_path => list.push(c),
                    _ => batches.push((c.item_path.clone(), vec![c])),
                }
                pending += 1;
                chunks_seen += 1;
                if chunks_seen & 0x3f == 0 {
                    run.phase.sample();
                }
                if pending >= batch_size {
                    check_cancel(options)?;
                    run.flush(&mut batches).await?;
                    pending = 0;
                }
            }
            // GitLab allows about 10 requests a second.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        run.flush(&mut batches).await
    }
    .await;
    if let Err(e) = streamed {
        run.phase.end(Outcome::of(&e));
        return Err(e);
    }
    run.phase.end(Outcome::Ok);

    if let Some(session) = &run.halving {
        let existing = state.map_or(0, |s| s.max_failed);
        let max_failed = if session.halved { session.max_failed.unwrap_or(existing) } else { existing };
        embed_api::write_entry(&state_key, Entry { last_successful: session.effective, max_failed })?;
    }

    let now = now_iso();
    registry::update_source(project_id, source_id, &[("last_indexed", json!(now)), ("embedding_schema_version", json!(2))])?;
    let cursor_file = cursor_path(project_id, source_id);
    std::fs::create_dir_all(cursor_file.parent().unwrap())?;
    std::fs::write(&cursor_file, json!({ "updated_after": now }).to_string())?;

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
        let mut compact_phase = Phase::begin(&ctx, "compact");
        let compacted = store.compact_with_grace(&table).await.is_ok();
        compact_phase.set_work(json!({ "compacted": compacted }));
        compact_phase.end(Outcome::Ok);
        let mut prune_phase = Phase::begin(&ctx, "prune_orphans");
        let removed = store.prune_index_orphans(&table);
        prune_phase.set_work(json!({ "orphans_removed": removed }));
        prune_phase.end(Outcome::Ok);
        if mode == Mode::Full {
            vecindex::mark_full_reindex(&table);
        }
    }
    Ok(json!({
        "status": "ok",
        "project_id": project_id,
        "source_id": source_id,
        "chunks_prepared": run.prepared,
        "chunks_persisted": run.persisted,
        "files_scanned": run.merged.0.len(),
        "files_reindexed": run.files_reindexed,
        "files_removed": to_remove.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_keeps_first_position_and_file_order() {
        let mut o: Ordered = serde_json::from_str(r#"{"b":"1","a":"2","b":"3"}"#).unwrap();
        o.set("c", "4");
        assert_eq!(serde_json::to_string(&o).unwrap(), r#"{"b":"3","a":"2","c":"4"}"#);
        o.remove("b");
        assert_eq!(o.get("b"), None);
        assert_eq!(o.get("a"), Some("2"));
    }
}
