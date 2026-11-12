//! The GitLab issues ticket source. Mirrors `src/plugins/gitlab-issues.ts`, including its known defects.
use crate::chunk::{chunk_id, chunk_lines, Sizes};
use crate::embed_api::client;
use crate::jsstr::{js_trim, normalize_content};
use crate::registry::{resolve_env_ref, unset_token_error, Source};
use anyhow::{anyhow, bail, Result};
use serde_json::Value;

/// A knowledge-table row before its vector: what `RawKnowledgeChunk` plus `stampChunkId` give.
#[derive(Clone, Debug, PartialEq)]
pub struct KnowledgeChunk {
    pub chunk_id: String,
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

pub(crate) struct TicketConfig {
    pub base_url: String,
    pub project_id: String,
    pub token: String,
}

pub(crate) fn ticket_config(source: &Source) -> Result<TicketConfig> {
    if source.kind() != "ticket" {
        bail!("Source \"{}\" is not a ticket source", source.source_id);
    }
    let field = |k: &str| source.source_config.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(TicketConfig { base_url: field("base_url"), project_id: field("project_id"), token: field("token") })
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn gitlab_fetch(url: &str, token: &str, project_id: &str) -> Result<Value> {
    let res = client()
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| anyhow::Error::new(e).context("fetch failed"))?;
    let status = res.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!(
            "GitLab token for project \"{project_id}\" is expired or invalid (HTTP {}). Update it with: scrybe update-source --project-id {project_id} --source-id <source-id> --gitlab-token <new-token>",
            status.as_u16()
        );
    }
    if !status.is_success() {
        bail!("GitLab API error {} {} for {url}", status.as_u16(), status.canonical_reason().unwrap_or(""));
    }
    res.json::<Value>().await.map_err(|e| anyhow::Error::new(e).context("Unexpected end of JSON input"))
}

/// `validateGitlabToken`: one authenticated read of the project, as `scrybe source add` does before saving.
pub async fn validate_token(cfg: &TicketConfig, in_daemon: bool) -> Result<()> {
    let token = resolve_env_ref(&cfg.token).map_err(|_| unset_token_error("GitLab", &cfg.project_id, &cfg.token, in_daemon))?;
    gitlab_fetch(&format!("{}/api/v4/projects/{}", cfg.base_url, encode_uri_component(&cfg.project_id)), &token, &cfg.project_id).await?;
    Ok(())
}

async fn fetch_all_pages(base_url: &str, token: &str, project_id: &str) -> Result<Vec<Value>> {
    let mut results = vec![];
    let mut page = 1;
    loop {
        let sep = if base_url.contains('?') { "&" } else { "?" };
        let url = format!("{base_url}{sep}per_page=100&page={page}");
        let batch = gitlab_fetch(&url, token, project_id).await?;
        let Value::Array(items) = batch else { bail!("batch is not iterable") };
        let n = items.len();
        results.extend(items);
        if n < 100 {
            break;
        }
        page += 1;
    }
    Ok(results)
}

/// JS truthiness of a JSON value.
pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `${value}` in a JS template literal.
pub(crate) fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

pub(crate) fn field_str(v: &Value, key: &str) -> String {
    v.get(key).map_or_else(|| "undefined".to_string(), js_str)
}

/// `x.author.username`, which throws when `author` is missing.
fn username(v: &Value) -> Result<String> {
    match v.get("author") {
        Some(a) if !a.is_null() => Ok(field_str(a, "username")),
        _ => bail!("Cannot read properties of undefined (reading 'username')"),
    }
}

pub(crate) struct Meta {
    pub state: String,
    pub labels: String,
    pub assignees: String,
    pub milestone: String,
    pub confidential: String,
}

/// `serializeIssueMetadata`: everything is a string, the multi-value fields JSON-encoded.
fn serialize_issue_metadata(issue: &Value) -> Meta {
    let state = if issue.get("state").and_then(Value::as_str) == Some("opened") { "open" } else { "closed" };
    let list = |v: Option<&Value>| match v {
        Some(Value::Null) | None => "[]".to_string(),
        Some(other) => other.to_string(),
    };
    let assignees = match issue.get("assignees") {
        Some(Value::Array(a)) => Value::Array(a.iter().map(|x| x.get("username").cloned().unwrap_or(Value::Null)).collect()).to_string(),
        _ => "[]".to_string(),
    };
    let milestone = match issue.get("milestone").filter(|m| truthy(m)) {
        Some(m) => {
            // Built by hand: a JSON map would sort `due_date` before `title`.
            let mut parts = vec![];
            if let Some(t) = m.get("title") {
                parts.push(format!("\"title\":{t}"));
            }
            let due = m.get("due_date").filter(|d| !d.is_null()).cloned().unwrap_or(Value::Null);
            parts.push(format!("\"due_date\":{due}"));
            format!("{{{}}}", parts.join(","))
        }
        None => String::new(),
    };
    let confidential = if issue.get("confidential").is_some_and(truthy) { "true" } else { "false" };
    Meta { state: state.into(), labels: list(issue.get("labels")), assignees, milestone, confidential: confidential.into() }
}

/// `scanSources`: issue key to `updated_at`, in first-seen order, the last value winning.
pub async fn scan_sources(project_id: &str, source: &Source, cursor: Option<&str>) -> Result<Vec<(String, String)>> {
    let cfg = ticket_config(source)?;
    let token = resolve_env_ref(&cfg.token)?;
    let encoded = encode_uri_component(&cfg.project_id);
    let since = match cursor.filter(|c| !c.is_empty()) {
        Some(c) => {
            let at = chrono::DateTime::parse_from_rfc3339(c).map_err(|_| anyhow!("Invalid time value"))?;
            Some((at.to_utc() - chrono::Duration::seconds(60)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        }
        None => None,
    };
    let url = match since {
        Some(s) => format!("{}/api/v4/projects/{encoded}/issues?state=all&updated_after={}", cfg.base_url, encode_uri_component(&s)),
        None => format!("{}/api/v4/projects/{encoded}/issues?state=all", cfg.base_url),
    };
    let issues = fetch_all_pages(&url, &token, project_id).await?;
    let mut map: Vec<(String, String)> = vec![];
    for issue in &issues {
        let key = format!("issues/{}", field_str(issue, "iid"));
        let updated = field_str(issue, "updated_at");
        match map.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = updated,
            None => map.push((key, updated)),
        }
    }
    Ok(map)
}

pub(crate) struct Emit<'a> {
    pub project_id: &'a str,
    pub source_id: &'a str,
    pub meta: &'a Meta,
    pub sizes: Sizes,
}

impl Emit<'_> {
    pub fn chunks(&self, item_path: &str, content: &str, author: &str, timestamp: &str, item_type: &str, item_url: &str) -> Vec<KnowledgeChunk> {
        let lines: Vec<String> = content.split('\n').map(|l| format!("{l}\n")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        chunk_lines(&refs, 0, None, self.sizes)
            .into_iter()
            .map(|w| KnowledgeChunk {
                chunk_id: chunk_id(self.project_id, self.source_id, item_path, item_url, item_type, &w.content),
                project_id: self.project_id.to_string(),
                source_id: self.source_id.to_string(),
                item_path: item_path.to_string(),
                item_url: item_url.to_string(),
                item_type: item_type.to_string(),
                author: author.to_string(),
                timestamp: timestamp.to_string(),
                content: w.content,
                state: self.meta.state.clone(),
                labels: self.meta.labels.clone(),
                assignees: self.meta.assignees.clone(),
                milestone: self.meta.milestone.clone(),
                confidential: self.meta.confidential.clone(),
            })
            .collect()
    }
}

/// One issue's chunks, or None for a 404, which `fetchChunks` skips with a warning. The caller sleeps
/// 50 ms after each issue it consumed.
pub async fn fetch_issue_chunks(project_id: &str, source: &Source, key: &str, sizes: Sizes) -> Result<Option<Vec<KnowledgeChunk>>> {
    let cfg = ticket_config(source)?;
    let token = resolve_env_ref(&cfg.token)?;
    let encoded = encode_uri_component(&cfg.project_id);
    let iid = key.replacen("issues/", "", 1);
    let issue_url = format!("{}/api/v4/projects/{encoded}/issues/{iid}", cfg.base_url);
    let notes_url = format!("{}/api/v4/projects/{encoded}/issues/{iid}/notes", cfg.base_url);
    match build_chunks(project_id, source, &token, &issue_url, &notes_url, sizes).await {
        Err(e) if e.to_string().contains("404") => {
            eprintln!("[scrybe] Issue '{key}' not found (404) — skipping");
            Ok(None)
        }
        other => other.map(Some),
    }
}

async fn build_chunks(project_id: &str, source: &Source, token: &str, issue_url: &str, notes_url: &str, sizes: Sizes) -> Result<Vec<KnowledgeChunk>> {
    // Both requests go out together, as in the TypeScript's Promise.all.
    let (issue, notes) = futures::join!(gitlab_fetch(issue_url, token, project_id), fetch_all_pages(notes_url, token, project_id));
    let (issue, notes) = (issue?, notes?);
    let meta = serialize_issue_metadata(&issue);
    let emit = Emit { project_id, source_id: &source.source_id, meta: &meta, sizes };
    let iid = field_str(&issue, "iid");
    let web_url = field_str(&issue, "web_url");
    let updated_at = field_str(&issue, "updated_at");
    let title = field_str(&issue, "title");
    let description = match issue.get("description") {
        Some(d) if truthy(d) => js_trim(&js_str(d)).to_string(),
        _ => String::new(),
    };
    let body = normalize_content(js_trim(&format!("# {title}\n\n{description}")));
    let mut out = emit.chunks(&format!("issues/{iid}"), &body, &username(&issue)?, &updated_at, "ticket", &web_url);
    for note in &notes {
        if note.get("system").is_some_and(truthy) {
            continue;
        }
        let raw = match note.get("body") {
            Some(Value::String(s)) => s.as_str(),
            _ => bail!("Cannot read properties of undefined (reading 'trim')"),
        };
        let text = normalize_content(js_trim(raw));
        if text.is_empty() {
            continue;
        }
        let id = field_str(note, "id");
        let created = note.get("created_at").filter(|c| truthy(c)).map_or_else(|| updated_at.clone(), js_str);
        out.extend(emit.chunks(&format!("issues/{iid}#note_{id}"), &text, &username(note)?, &created, "ticket_comment", &format!("{web_url}#note_{id}")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uri_encoding_matches_javascript() {
        assert_eq!(encode_uri_component("group/proj name"), "group%2Fproj%20name");
        assert_eq!(encode_uri_component("2026-11-09T10:00:00.000Z"), "2026-11-09T10%3A00%3A00.000Z");
        assert_eq!(encode_uri_component("é!'()*~"), "%C3%A9!'()*~");
    }

    #[test]
    fn metadata_is_serialized_like_the_typescript() {
        let issue = json!({
            "state": "opened",
            "labels": ["Bug", "ü"],
            "assignees": [{ "username": "alice" }],
            "milestone": { "title": "M1", "due_date": null },
            "confidential": true,
        });
        let m = serialize_issue_metadata(&issue);
        assert_eq!(m.state, "open");
        assert_eq!(m.labels, "[\"Bug\",\"ü\"]");
        assert_eq!(m.assignees, "[\"alice\"]");
        assert_eq!(m.milestone, "{\"title\":\"M1\",\"due_date\":null}");
        assert_eq!(m.confidential, "true");
        let bare = serialize_issue_metadata(&json!({ "state": "closed", "milestone": null }));
        assert_eq!((bare.state.as_str(), bare.labels.as_str(), bare.assignees.as_str(), bare.milestone.as_str(), bare.confidential.as_str()), ("closed", "[]", "[]", "", "false"));
    }

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!truthy(&json!(0)) && !truthy(&json!("")) && !truthy(&Value::Null));
        assert!(truthy(&json!([])) && truthy(&json!({})) && truthy(&json!("x")));
    }
}
