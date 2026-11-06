//! Hybrid search. Mirrors `src/search.ts`: fan out per source, vector + full text, RRF merge.
use crate::branches;
use crate::embed;
use crate::registry::{self, Project, Source};
use crate::store::{escape_sql, Rows, Store};
use anyhow::Result;
use futures::future::try_join_all;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tokio::sync::Mutex;

/// Above this many ids the branch filter runs after the query instead of in SQL.
const BRANCH_FILTER_INLINE_LIMIT: usize = 5000;

#[derive(Clone, Debug, Serialize)]
pub struct CodeHit {
    pub chunk_id: String,
    pub score: f64,
    pub project_id: String,
    pub source_id: String,
    pub item_path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub language: String,
    pub symbol_name: String,
    pub content: String,
    pub branches: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct KnowledgeHit {
    pub score: f64,
    pub project_id: String,
    pub source_id: String,
    pub item_path: String,
    pub item_url: String,
    pub item_type: String,
    pub author: String,
    pub timestamp: String,
    pub content: String,
    pub state: String,
    pub labels: String,
    pub assignees: String,
    pub milestone: String,
    pub confidential: String,
}

/// Reciprocal rank fusion. Insertion order breaks ties, as the JS Map plus stable sort does.
pub fn merge_rrf<T: Clone>(lists: &[Vec<T>], k: f64, key: impl Fn(&T) -> String, set_score: impl Fn(&mut T, f64)) -> Vec<T> {
    let mut order: Vec<String> = vec![];
    let mut scored: HashMap<String, (f64, T)> = HashMap::new();
    for list in lists {
        for (rank, item) in list.iter().enumerate() {
            let id = key(item);
            let add = 1.0 / (k + rank as f64 + 1.0);
            match scored.get_mut(&id) {
                Some(entry) => entry.0 += add,
                None => {
                    order.push(id.clone());
                    scored.insert(id, (add, item.clone()));
                }
            }
        }
    }
    let mut entries: Vec<(f64, String)> = order.into_iter().map(|id| (scored[&id].0, id)).collect();
    entries.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    entries
        .into_iter()
        .map(|(score, id)| {
            let mut item = scored.remove(&id).unwrap().1;
            set_score(&mut item, score);
            item
        })
        .collect()
}

fn code_rows(rows: &Rows, vector: bool) -> Vec<CodeHit> {
    rows.iter()
        .map(|r| CodeHit {
            chunk_id: r.string("chunk_id"),
            score: if vector { 1.0 - r.number("_distance") } else { 0.0 },
            project_id: r.string("project_id"),
            source_id: String::new(),
            item_path: r.string("item_path"),
            start_line: r.number("start_line") as i64,
            end_line: r.number("end_line") as i64,
            language: r.string("language"),
            symbol_name: r.string("symbol_name"),
            content: r.string("content"),
            branches: vec![],
        })
        .collect()
}

fn knowledge_rows(rows: &Rows, vector: bool) -> Vec<KnowledgeHit> {
    rows.iter()
        .map(|r| KnowledgeHit {
            score: if vector { 1.0 - r.number("_distance") } else { 0.0 },
            project_id: r.string("project_id"),
            source_id: r.string_or_empty("source_id"),
            item_path: r.string("item_path"),
            item_url: r.string("item_url"),
            item_type: r.string("item_type"),
            author: r.string("author"),
            timestamp: r.string("timestamp"),
            content: r.string("content"),
            state: r.string_or_empty("state"),
            labels: r.string_or_empty("labels"),
            assignees: r.string_or_empty("assignees"),
            milestone: r.string_or_empty("milestone"),
            confidential: r.string_or_empty("confidential"),
        })
        .collect()
}

pub use crate::jsstr::js_slice;

/// Only an error that names an index or FTS means "no keyword index on this table".
fn fts_missing(err: &anyhow::Error) -> bool {
    let msg = format!("{err:#}").to_lowercase();
    msg.contains("index") || msg.contains("fts")
}

/// One query vector per model within a single call, as `embedQueryOnce` does.
struct QueryVectors<'a> {
    query: &'a str,
    cache: Mutex<HashMap<String, Vec<f32>>>,
}

impl QueryVectors<'_> {
    async fn get(&self, source: &Source) -> Result<Vec<f32>> {
        let emb = registry::resolve_embedding(source)?;
        let key = format!("{}\0{}\0{}", emb.base_url, emb.model, emb.query_prefix);
        let mut cache = self.cache.lock().await;
        if let Some(v) = cache.get(&key) {
            return Ok(v.clone());
        }
        let v = embed::embed_query_for(&emb, self.query).await?;
        cache.insert(key, v.clone());
        Ok(v)
    }
}

pub fn code_sources(p: &Project) -> Vec<&Source> {
    p.sources.iter().filter(|s| s.profile() == Some("code")).collect()
}

pub fn knowledge_sources(p: &Project) -> Vec<&Source> {
    p.sources.iter().filter(|s| s.profile() == Some("text")).collect()
}

pub async fn search_code(store: &Store, query: &str, project_id: &str, top_k: usize, branch: Option<&str>) -> Result<Vec<CodeHit>> {
    let Some(project) = registry::get_project(project_id) else {
        anyhow::bail!("Project '{project_id}' not found");
    };
    let sources = code_sources(&project);
    if sources.is_empty() {
        let hint = if knowledge_sources(&project).is_empty() {
            "Project has no indexed code sources".to_string()
        } else {
            format!("Project '{project_id}' has no code sources; it has knowledge sources: use search_knowledge")
        };
        anyhow::bail!("NO_CODE_SOURCES: {hint}");
    }
    if store.settings.rerank_enabled {
        anyhow::bail!("rerank is not ported to the Rust read path yet (SCRYBE_RERANK=true)");
    }
    let vectors = QueryVectors { query, cache: Mutex::default() };
    let per_source = sources.iter().filter(|s| s.table_name.is_some()).map(|source| {
        let vectors = &vectors;
        async move {
            let table = source.table_name.as_deref().unwrap();
            let want = branch.map(str::to_string).unwrap_or_else(|| branches::resolve_branch(source));
            let mut inline: Option<Vec<String>> = None;
            let mut post: Option<HashSet<String>> = None;
            if !store.settings.skip_branch_filter && want != "*" {
                let Some((_, ids)) = branches::resolve_for_search(project_id, &source.source_id, &want)? else {
                    return Ok::<Vec<CodeHit>, anyhow::Error>(vec![]);
                };
                if ids.len() <= BRANCH_FILTER_INLINE_LIMIT {
                    inline = Some(ids);
                } else {
                    post = Some(ids.into_iter().collect());
                }
            }
            let vec = vectors.get(source).await?;
            let mut where_ = format!("project_id = '{}'", escape_sql(project_id));
            if let Some(ids) = inline.as_ref().filter(|i| !i.is_empty()) {
                let list: Vec<String> = ids.iter().map(|id| format!("'{}'", escape_sql(id))).collect();
                where_ += &format!(" AND chunk_id IN ({})", list.join(", "));
            }
            let mut results = if store.settings.hybrid_enabled {
                let (v, f) = tokio::join!(store.vector_search(table, &vec, &where_, top_k), store.fts_search(table, query, &where_, top_k));
                let v = code_rows(&v?, true);
                let f = match f {
                    Ok(rows) => code_rows(&rows, false),
                    Err(e) if fts_missing(&e) => vec![],
                    Err(e) => return Err(e),
                };
                if f.is_empty() { v } else { merge_rrf(&[v, f], store.settings.rrf_k, |h| h.chunk_id.clone(), |h, s| h.score = s) }
            } else {
                code_rows(&store.vector_search(table, &vec, &where_, top_k).await?, true)
            };
            // Runs after the limit, so it can return fewer than top_k. Kept to match the TypeScript.
            if let Some(ids) = &post {
                results.retain(|r| ids.contains(&r.chunk_id));
            }
            for r in &mut results {
                r.source_id = source.source_id.clone();
            }
            Ok(results)
        }
    });
    let all = try_join_all(per_source).await?;
    let merged = if all.len() == 1 {
        all.into_iter().next().unwrap()
    } else {
        merge_rrf(&all, store.settings.rrf_k, |h| h.chunk_id.clone(), |h, s| h.score = s)
    };
    let mut hits: Vec<CodeHit> = merged.into_iter().take(top_k).collect();

    let mut by_source: HashMap<String, Vec<String>> = HashMap::new();
    for h in &hits {
        by_source.entry(h.source_id.clone()).or_default().push(h.chunk_id.clone());
    }
    let mut chunk_branches: HashMap<String, Vec<String>> = HashMap::new();
    for (sid, ids) in &by_source {
        chunk_branches.extend(branches::branches_for_chunks(project_id, sid, ids)?);
    }
    for h in &mut hits {
        h.branches = chunk_branches.get(&h.chunk_id).cloned().unwrap_or_default();
    }
    Ok(hits)
}

pub async fn search_knowledge(store: &Store, query: &str, project_id: &str, top_k: usize, source_id: Option<&str>, item_types: Option<&[String]>) -> Result<Vec<KnowledgeHit>> {
    let Some(project) = registry::get_project(project_id) else {
        anyhow::bail!("Project '{project_id}' not found");
    };
    let mut sources = knowledge_sources(&project);
    if let Some(sid) = source_id {
        sources.retain(|s| s.source_id == sid);
        if sources.is_empty() {
            anyhow::bail!("NO_KNOWLEDGE_SOURCES: No knowledge source with id '{sid}' found");
        }
    }
    if sources.is_empty() {
        let hint = if code_sources(&project).is_empty() {
            "Project has no indexed knowledge sources".to_string()
        } else {
            format!("Project '{project_id}' has no knowledge sources; it has code sources: use search_code")
        };
        anyhow::bail!("NO_KNOWLEDGE_SOURCES: {hint}");
    }
    if store.settings.rerank_enabled {
        anyhow::bail!("rerank is not ported to the Rust read path yet (SCRYBE_RERANK=true)");
    }
    let key = |h: &KnowledgeHit| format!("{}:{}:{}:{}", h.project_id, h.source_id, h.item_path, js_slice(&h.content, 40));
    let vectors = QueryVectors { query, cache: Mutex::default() };
    let per_source = sources.iter().filter(|s| s.table_name.is_some()).map(|source| {
        let vectors = &vectors;
        async move {
            let table = source.table_name.as_deref().unwrap();
            let vec = vectors.get(source).await?;
            let where_ = format!("project_id = '{}'", escape_sql(project_id));
            let mut results = if store.settings.hybrid_enabled {
                let (v, f) = tokio::join!(store.vector_search(table, &vec, &where_, top_k), store.fts_search(table, query, &where_, top_k));
                let v = knowledge_rows(&v?, true);
                let f = match f {
                    Ok(rows) => knowledge_rows(&rows, false),
                    Err(e) if fts_missing(&e) => vec![],
                    Err(e) => return Err(e),
                };
                if f.is_empty() { v } else { merge_rrf(&[v, f], store.settings.rrf_k, key, |h, s| h.score = s) }
            } else {
                knowledge_rows(&store.vector_search(table, &vec, &where_, top_k).await?, true)
            };
            if let Some(types) = item_types.filter(|t| !t.is_empty()) {
                results.retain(|r| types.contains(&r.item_type));
            }
            Ok::<_, anyhow::Error>(results)
        }
    });
    let all = try_join_all(per_source).await?;
    let merged = if all.len() == 1 {
        all.into_iter().next().unwrap()
    } else {
        merge_rrf(&all, store.settings.rrf_k, key, |h, s| h.score = s)
    };
    Ok(merged.into_iter().take(top_k).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct H(&'static str, f64);

    fn merge(lists: &[Vec<H>]) -> Vec<H> {
        merge_rrf(lists, 60.0, |h| h.0.to_string(), |h, s| h.1 = s)
    }

    #[test]
    fn rrf_adds_ranks_and_keeps_first_seen_order_on_ties() {
        let out = merge(&[vec![H("a", 0.0), H("b", 0.0)], vec![H("c", 0.0), H("a", 0.0)]]);
        assert_eq!(out.iter().map(|h| h.0).collect::<Vec<_>>(), ["a", "c", "b"]);
        assert_eq!(out[0].1, 1.0 / 61.0 + 1.0 / 62.0);
        // "b" and "c" tie only by rank value; c (rank 0) outranks b (rank 1).
        assert_eq!(out[1].1, 1.0 / 61.0);
    }

    #[test]
    fn rrf_tie_broken_by_insertion() {
        let out = merge(&[vec![H("x", 0.0)], vec![H("y", 0.0)]]);
        assert_eq!(out.iter().map(|h| h.0).collect::<Vec<_>>(), ["x", "y"]);
    }

    #[test]
    fn js_slice_counts_utf16_units() {
        assert_eq!(js_slice("abc", 2), "ab");
        assert_eq!(js_slice("😀x", 2), "😀");
    }
}

/// Parity diagnostics: the two ranked lists before fusion, for one code source.
pub async fn debug_lists(store: &Store, query: &str, project_id: &str, top_k: usize) -> Result<serde_json::Value> {
    let Some(project) = registry::get_project(project_id) else { anyhow::bail!("Project '{project_id}' not found") };
    let mut out = vec![];
    for source in code_sources(&project) {
        let Some(table) = source.table_name.as_deref() else { continue };
        let want = branches::resolve_branch(source);
        let mut where_ = format!("project_id = '{}'", escape_sql(project_id));
        let mut filtered_ids = 0;
        if want != "*" {
            if let Some((_, ids)) = branches::resolve_for_search(project_id, &source.source_id, &want)? {
                filtered_ids = ids.len();
                if ids.len() <= BRANCH_FILTER_INLINE_LIMIT {
                    let list: Vec<String> = ids.iter().map(|id| format!("'{}'", escape_sql(id))).collect();
                    where_ += &format!(" AND chunk_id IN ({})", list.join(", "));
                }
            }
        }
        let emb = registry::resolve_embedding(source)?;
        let (model, prefix) = (emb.model, emb.query_prefix);
        let tokens = embed::tokens(&model, &format!("{prefix}{query}"))?;
        let vec = embed::embed_query(&model, &prefix, query).await?;
        let v = store.vector_search(table, &vec, &where_, top_k).await?;
        let (f, fts_error) = match store.fts_search(table, query, &where_, top_k).await {
            Ok(rows) => (Some(rows), None),
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        let vlist: Vec<_> = v.iter().map(|r| serde_json::json!([r.string("chunk_id"), r.number("_distance")])).collect();
        let flist: Vec<_> = f.iter().flat_map(|rows| rows.iter()).map(|r| serde_json::json!([r.string("chunk_id"), r.number("_score")])).collect();
        out.push(serde_json::json!({ "source": source.source_id, "branch": want, "filtered_ids": filtered_ids, "tokens": tokens, "vector": vec, "vlist": vlist, "flist": flist, "fts_error": fts_error }));
    }
    Ok(serde_json::json!(out))
}
