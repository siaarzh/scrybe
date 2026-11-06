//! Tool handlers and their error envelope. Mirrors `src/tools/search.ts`, `lookup.ts`, `project.ts`
//! and `classifyError` in `src/mcp-server.ts`.
use crate::branches;
use crate::collate::locale_compare;
use crate::registry;
use crate::search::{self, js_slice, CodeHit, KnowledgeHit};
use crate::store::{escape_sql, needs_migration, Store};
use futures::future::try_join_all;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const BRANCH_FILTER_INLINE_LIMIT: usize = 5000;

#[derive(Debug)]
pub struct ToolError {
    pub message: String,
    pub error_type: Option<&'static str>,
    pub details: Option<Value>,
}

impl From<anyhow::Error> for ToolError {
    fn from(e: anyhow::Error) -> Self {
        ToolError { message: format!("{e:#}"), error_type: None, details: None }
    }
}

impl ToolError {
    /// Port of `classifyError`.
    pub fn to_json(&self) -> Value {
        if let Some(t) = self.error_type {
            return json!({ "error": self.message, "error_type": t, "details": self.details });
        }
        let m = &self.message;
        let low = m.to_lowercase();
        if m.contains("429") {
            return json!({ "error": "Embedding API rate limit exceeded. The reindex or search cannot proceed right now. Wait a minute and retry, or check your embedding provider's rate limit tier (e.g. Voyage AI requires a payment method on file to unlock standard limits).", "error_type": "rate_limit" });
        }
        if m.contains("401") || low.contains("unauthorized") || low.contains("api key") || low.contains("apikey") || low.contains("api_key") || low.contains("api-key") {
            return json!({ "error": "Embedding API authentication failed. Check that SCRYBE_CODE_EMBEDDING_API_KEY is set correctly.", "error_type": "auth" });
        }
        if let Some(rest) = m.strip_prefix("NO_CODE_SOURCES") {
            return json!({ "error": rest.trim_start_matches(':').trim_start(), "error_type": "no_code_sources" });
        }
        if let Some(rest) = m.strip_prefix("NO_KNOWLEDGE_SOURCES") {
            return json!({ "error": rest.trim_start_matches(':').trim_start(), "error_type": "no_knowledge_sources" });
        }
        if m.contains("Unknown embedding provider") {
            return json!({ "error": m, "error_type": "unknown_provider" });
        }
        if ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "No such file", "Permission denied"].iter().any(|s| m.contains(s)) {
            return json!({ "error": m, "error_type": "file_system" });
        }
        if low.contains("corrupt") || low.contains("malformed") || low.contains("unexpected token") {
            return json!({ "error": m, "error_type": "data_corruption" });
        }
        json!({ "error": m, "error_type": "internal" })
    }
}

type ToolResult<T> = Result<T, ToolError>;

/// `checkProjectHealth`, minus the manifest-level corruption probe, which isn't ported yet.
fn check_health(project_id: &str, only: Option<&str>) -> ToolResult<()> {
    let Some(project) = registry::get_project(project_id) else { return Ok(()) };
    for s in &project.sources {
        if only.is_some_and(|o| o != s.source_id) {
            continue;
        }
        let Some(table) = &s.table_name else { continue };
        if needs_migration(table) {
            let cmd = format!("scrybe migrate --source-id {} --project-id {project_id}", s.source_id);
            return Err(ToolError {
                message: format!("Source '{project_id}/{}' uses an old chunk-ID scheme. Run: {cmd}", s.source_id),
                error_type: Some("needs_migration"),
                details: Some(json!({ "project_id": project_id, "source_id": s.source_id, "table_name": table, "migrate_command": cmd })),
            });
        }
    }
    Ok(())
}

pub async fn search_code(store: &Store, project_id: &str, query: &str, top_k: usize, branch: Option<&str>) -> ToolResult<Vec<CodeHit>> {
    check_health(project_id, None)?;
    Ok(search::search_code(store, query, project_id, top_k, branch).await?)
}

#[derive(Serialize)]
pub struct ParsedKnowledge {
    pub score: f64,
    pub project_id: String,
    pub source_id: String,
    pub item_path: String,
    pub item_url: String,
    pub item_type: String,
    pub author: String,
    pub timestamp: String,
    pub content: String,
    pub state: Option<String>,
    pub labels: Vec<Value>,
    pub assignees: Vec<Value>,
    pub milestone: Option<Value>,
    pub confidential: bool,
}

fn json_array(raw: &str) -> Vec<Value> {
    let text = if raw.is_empty() { "[]" } else { raw };
    match serde_json::from_str(text) {
        Ok(Value::Array(a)) => a,
        _ => vec![],
    }
}

fn parse_knowledge(h: KnowledgeHit) -> ParsedKnowledge {
    let labels = json_array(&h.labels);
    let assignees = json_array(&h.assignees);
    let milestone = if h.milestone.is_empty() {
        None
    } else {
        serde_json::from_str::<Value>(&h.milestone).ok().filter(|v| v.is_object() || v.is_array())
    };
    ParsedKnowledge {
        score: h.score,
        project_id: h.project_id,
        source_id: h.source_id,
        item_path: h.item_path,
        item_url: h.item_url,
        item_type: h.item_type,
        author: h.author,
        timestamp: h.timestamp,
        content: h.content,
        state: if h.state.is_empty() { None } else { Some(h.state) },
        labels,
        assignees,
        milestone,
        confidential: h.confidential == "true",
    }
}

pub async fn search_knowledge(store: &Store, project_id: &str, query: &str, top_k: usize, source_id: Option<&str>, item_types: Option<&[String]>) -> ToolResult<Vec<ParsedKnowledge>> {
    check_health(project_id, source_id)?;
    let hits = search::search_knowledge(store, query, project_id, top_k, source_id, item_types).await?;
    Ok(hits.into_iter().map(parse_knowledge).collect())
}

#[derive(Clone, Debug, Serialize)]
pub struct LookupHit {
    pub chunk_id: String,
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

fn symbol_predicate(name: &str, exact: bool, case_sensitive: bool) -> String {
    let e = escape_sql(name);
    match (exact, case_sensitive) {
        (true, true) => format!("symbol_name = '{e}'"),
        (true, false) => format!("LOWER(symbol_name) = LOWER('{e}')"),
        (false, true) => format!("(symbol_name = '{e}' OR symbol_name LIKE '%.{e}')"),
        (false, false) => format!("(LOWER(symbol_name) = LOWER('{e}') OR LOWER(symbol_name) LIKE LOWER('%.{e}'))"),
    }
}

pub struct LookupInput<'a> {
    pub project_id: &'a str,
    pub symbol_name: &'a str,
    pub exact: bool,
    pub branch: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub case_sensitive: bool,
    pub limit: usize,
}

pub async fn lookup_symbol(store: &Store, input: LookupInput<'_>) -> ToolResult<Vec<LookupHit>> {
    let trimmed = input.symbol_name.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("symbol_name must be non-empty after trimming").into());
    }
    if input.limit > 200 {
        return Err(anyhow::anyhow!("limit must be ≤ 200").into());
    }
    let project_id = input.project_id;
    let Some(project) = registry::get_project(project_id) else {
        return Err(anyhow::anyhow!("Project '{project_id}' not found").into());
    };
    let mut sources = search::code_sources(&project);
    if let Some(sid) = input.source_id {
        sources.retain(|s| s.source_id == sid);
    }
    let predicate = symbol_predicate(trimmed, input.exact, input.case_sensitive);
    let limit = input.limit;
    let branch = input.branch;
    let per_source = sources.iter().filter(|s| s.table_name.is_some()).map(|source| {
        let predicate = &predicate;
        async move {
            let Some(table) = store.open(source.table_name.as_deref().unwrap()).await? else {
                return Ok::<Vec<LookupHit>, anyhow::Error>(vec![]);
            };
            let mut where_ = format!("symbol_name != '' AND project_id = '{}' AND {predicate}", escape_sql(project_id));
            let mut post: Option<HashSet<String>> = None;
            if let Some(b) = branch {
                let Some((_, ids)) = branches::resolve_for_search(project_id, &source.source_id, b)? else {
                    return Ok(vec![]);
                };
                if ids.len() <= BRANCH_FILTER_INLINE_LIMIT {
                    let list: Vec<String> = ids.iter().map(|id| format!("'{}'", escape_sql(id))).collect();
                    where_ += &format!(" AND chunk_id IN ({})", list.join(", "));
                } else {
                    post = Some(ids.into_iter().collect());
                }
            }
            let rows = store.plain_query(&table, &where_, limit).await?;
            let mut out: Vec<LookupHit> = rows
                .iter()
                .map(|r| LookupHit {
                    chunk_id: r.string("chunk_id"),
                    project_id: r.string("project_id"),
                    source_id: source.source_id.clone(),
                    item_path: r.string("item_path"),
                    start_line: r.number("start_line") as i64,
                    end_line: r.number("end_line") as i64,
                    language: r.string("language"),
                    symbol_name: r.string("symbol_name"),
                    content: r.string("content"),
                    branches: vec![],
                })
                .collect();
            if let Some(ids) = &post {
                out.retain(|h| ids.contains(&h.chunk_id));
            }
            Ok(out)
        }
    });
    let mut merged: Vec<LookupHit> = try_join_all(per_source).await?.into_iter().flatten().collect();
    merged.sort_by(|a, b| {
        locale_compare(&a.language, &b.language)
            .then_with(|| locale_compare(&a.item_path, &b.item_path))
            .then_with(|| a.start_line.cmp(&b.start_line))
    });
    merged.truncate(limit);
    let mut by_source: HashMap<String, Vec<String>> = HashMap::new();
    for h in &merged {
        by_source.entry(h.source_id.clone()).or_default().push(h.chunk_id.clone());
    }
    let mut chunk_branches: HashMap<String, Vec<String>> = HashMap::new();
    for (sid, ids) in &by_source {
        chunk_branches.extend(branches::branches_for_chunks(project_id, sid, ids).map_err(ToolError::from)?);
    }
    for h in &mut merged {
        h.branches = chunk_branches.get(&h.chunk_id).cloned().unwrap_or_default();
    }
    Ok(merged)
}

#[derive(Serialize)]
pub struct SourceRow {
    pub source_id: String,
    pub source_type: String,
    pub embedding_profile: String,
    pub last_indexed: Option<String>,
    pub searchable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub searchable_reason: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectRow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub sources: Vec<SourceRow>,
}

pub fn list_projects() -> Vec<ProjectRow> {
    registry::list_projects()
        .into_iter()
        .map(|p| ProjectRow {
            id: p.id,
            description: p.description,
            sources: p
                .sources
                .iter()
                .map(|s| {
                    let (ok, reason) = registry::is_searchable(s);
                    SourceRow {
                        source_id: s.source_id.clone(),
                        source_type: s.kind().to_string(),
                        embedding_profile: s.profile().unwrap_or("unknown").to_string(),
                        last_indexed: s.last_indexed.clone(),
                        searchable: ok,
                        searchable_reason: if ok { None } else { reason },
                    }
                })
                .collect(),
        })
        .collect()
}

// ─── CLI text, byte-compatible with each tool's formatCli ─────────────────────

pub fn format_code(hits: &[CodeHit]) -> String {
    hits.iter()
        .map(|r| {
            let sym = if r.symbol_name.is_empty() { String::new() } else { format!(" · {}", r.symbol_name) };
            let br = if r.branches.is_empty() { String::new() } else { format!("\n  Branches: {}", r.branches.join(", ")) };
            format!("\n[{:.3}] {}:{}-{} ({}){sym}{br}\n{}", r.score, r.item_path, r.start_line, r.end_line, r.language, js_slice(&r.content, 300))
        })
        .collect()
}

pub fn format_knowledge(hits: &[ParsedKnowledge]) -> String {
    hits.iter()
        .map(|r| {
            let author = if r.author.is_empty() { String::new() } else { format!("\n  Author: {}  {}", r.author, r.timestamp) };
            let mut meta: Vec<String> = vec![];
            if let Some(s) = &r.state {
                meta.push(format!("state:{s}"));
            }
            let join = |v: &[Value]| v.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(",");
            if !r.labels.is_empty() {
                meta.push(format!("labels:[{}]", join(&r.labels)));
            }
            if !r.assignees.is_empty() {
                meta.push(format!("assignees:[{}]", join(&r.assignees)));
            }
            if let Some(m) = &r.milestone {
                meta.push(match m.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    Some(t) => match m.get("due_date").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                        Some(d) => format!("milestone:{t} (due {d})"),
                        None => format!("milestone:{t}"),
                    },
                    None => format!("milestone:{m}"),
                });
            }
            if r.confidential {
                meta.push("confidential".into());
            }
            let meta = if meta.is_empty() { String::new() } else { format!("\n  {}", meta.join("  ")) };
            let head = if r.item_url.is_empty() { &r.item_path } else { &r.item_url };
            format!("\n[{:.3}] {head} ({}){author}{meta}\n{}", r.score, r.item_type, js_slice(&r.content, 300))
        })
        .collect()
}

pub fn format_projects(rows: &[ProjectRow]) -> String {
    if rows.is_empty() {
        return "No projects registered.".into();
    }
    let mut not_searchable = vec![];
    let mut out = String::new();
    for p in rows {
        out += &format!("\n{}", p.id);
        if let Some(d) = p.description.as_ref().filter(|d| !d.is_empty()) {
            out += &format!(" — {d}");
        }
        out.push('\n');
        if p.sources.is_empty() {
            out += "  (no sources)";
            continue;
        }
        let lines: Vec<String> = p
            .sources
            .iter()
            .map(|s| {
                let icon = match (&s.last_indexed, s.searchable) {
                    (None, _) => "○",
                    (_, true) => "✓",
                    _ => {
                        not_searchable.push(format!("  {}/{}: {}", p.id, s.source_id, s.searchable_reason.clone().unwrap_or_default()));
                        "✗"
                    }
                };
                let indexed = s.last_indexed.as_ref().map(|t| t.replace('T', " ").chars().take(16).collect::<String>()).unwrap_or_else(|| "never".into());
                format!("  {icon} {:<20} {:<10} {indexed}", s.source_id, s.source_type)
            })
            .collect();
        out += &lines.join("\n");
    }
    if !not_searchable.is_empty() {
        out += &format!("\n\n✗ Not searchable — missing config:\n{}", not_searchable.join("\n"));
    }
    out
}
