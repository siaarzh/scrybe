//! The GitHub issues ticket source. Mirrors `src/plugins/github-issues.ts`, including its known defects.
use crate::chunk::Sizes;
use crate::embed_api::client;
use crate::gitlab_issues::{encode_uri_component, field_str, js_str, ticket_config, truthy, Emit, KnowledgeChunk, Meta, TicketConfig};
use crate::jsstr::{js_trim, normalize_content};
use crate::registry::{resolve_env_ref, unset_token_error, Source};
use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_BASE_URL: &str = "https://api.github.com";
const SCOPES: &str = "Ensure the token has Issues: Read-only and Metadata: Read-only scopes (fine-grained PAT) or repo/public_repo (classic PAT).";

/// `parseInt(s, 10)`: the leading integer, or NaN.
fn parse_int(s: &str) -> f64 {
    let t = s.trim_start();
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `setTimeout` semantics: NaN, below 1 or above 2^31-1 ms all become 1 ms.
async fn delay(ms: f64) {
    let ms = if ms.is_finite() && (1.0..=2_147_483_647.0).contains(&ms) { ms as u64 } else { 1 };
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

fn header(res: &reqwest::Response, name: &str) -> Option<String> {
    res.headers().get(name).and_then(|v| v.to_str().ok()).map(String::from)
}

async fn github_fetch(url: &str, token: &str, project_id: &str) -> Result<Value> {
    let max_retries = 3;
    let mut retry_count = 0;
    loop {
        let res = client()
            .get(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|e| anyhow::Error::new(e).context("fetch failed"))?;
        let status = res.status();

        let limited = status.as_u16() == 429 || (status.as_u16() == 403 && header(&res, "x-ratelimit-remaining").as_deref() == Some("0"));
        if limited {
            let mut wait_ms = 60_000.0;
            match (header(&res, "Retry-After").filter(|h| !h.is_empty()), header(&res, "x-ratelimit-reset").filter(|h| !h.is_empty())) {
                (Some(after), _) => wait_ms = parse_int(&after) * 1000.0,
                (None, Some(reset)) => {
                    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
                    let left = parse_int(&reset) * 1000.0 - now;
                    wait_ms = if left.is_nan() { left } else { left.max(0.0) } + 1000.0;
                }
                _ => {}
            }
            if retry_count < max_retries {
                delay(wait_ms).await;
                retry_count += 1;
                continue;
            }
            bail!("GitHub API rate limit exceeded for project \"{project_id}\". Retry after {}s.", (wait_ms / 1000.0).ceil());
        }

        if status.as_u16() == 401 {
            bail!("GitHub token for project \"{project_id}\" is invalid or expired (HTTP 401). {SCOPES}");
        }
        if status.as_u16() == 403 {
            bail!("GitHub token for project \"{project_id}\" lacks required permissions (HTTP 403). {SCOPES}");
        }

        if !status.is_success() {
            let error = anyhow!("GitHub API error {} {} for {url}", status.as_u16(), status.canonical_reason().unwrap_or(""));
            if retry_count < max_retries {
                delay(1000.0 * f64::from(retry_count + 1)).await;
                retry_count += 1;
                continue;
            }
            return Err(error);
        }

        return res.json::<Value>().await.map_err(|e| anyhow::Error::new(e).context("Unexpected end of JSON input"));
    }
}

/// `validateGithubToken`: a cheap authenticated read of `/user`, as `scrybe source add` does before saving.
pub async fn validate_token(cfg: &TicketConfig, in_daemon: bool) -> Result<()> {
    let token = resolve_env_ref(&cfg.token).map_err(|_| unset_token_error("GitHub", &cfg.project_id, &cfg.token, in_daemon))?;
    let base_url = if cfg.base_url.is_empty() { DEFAULT_BASE_URL } else { cfg.base_url.as_str() };
    let res = client()
        .get(format!("{base_url}/user"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| anyhow::Error::new(e).context("fetch failed"))?;
    let status = res.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!("GitHub token for project \"{}\" is invalid or lacks required permissions (HTTP {}). {SCOPES}", cfg.project_id, status.as_u16());
    }
    if !status.is_success() {
        bail!("GitHub API error {} {} during token validation", status.as_u16(), status.canonical_reason().unwrap_or(""));
    }
    Ok(())
}

async fn fetch_all_pages(base_url: &str, token: &str, project_id: &str) -> Result<Vec<Value>> {
    let mut results = vec![];
    let mut page = 1;
    loop {
        let sep = if base_url.contains('?') { "&" } else { "?" };
        let url = format!("{base_url}{sep}per_page=100&page={page}");
        let batch = github_fetch(&url, token, project_id).await?;
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

/// `isPullRequest`: the `pull_request` key is present.
fn is_pull_request(issue: &Value) -> bool {
    issue.get("pull_request").is_some()
}

/// `(list ?? []).map((x) => x[key])`, JSON-encoded.
fn names(v: Option<&Value>, key: &str) -> Result<String> {
    match v {
        None | Some(Value::Null) => Ok("[]".into()),
        Some(Value::Array(items)) => {
            let mut out = vec![];
            for item in items {
                if item.is_null() {
                    bail!("Cannot read properties of null (reading '{key}')");
                }
                out.push(item.get(key).cloned().unwrap_or(Value::Null));
            }
            Ok(Value::Array(out).to_string())
        }
        Some(_) => bail!("(issue.labels ?? []).map is not a function"),
    }
}

/// `serializeIssueMetadata`: everything is a string, the multi-value fields JSON-encoded.
fn serialize_issue_metadata(issue: &Value) -> Result<Meta> {
    let milestone = match issue.get("milestone").filter(|m| truthy(m)) {
        Some(m) => match m.get("title") {
            Some(t) => format!("{{\"title\":{t},\"due_date\":null}}"),
            None => "{\"due_date\":null}".to_string(),
        },
        None => String::new(),
    };
    Ok(Meta {
        state: field_str(issue, "state"),
        labels: names(issue.get("labels"), "name")?,
        assignees: names(issue.get("assignees"), "login")?,
        milestone,
        confidential: "false".into(),
    })
}

/// `owner/repo` split on the first two slashes; a missing repo reads as "undefined".
fn repo_path(project_id: &str) -> String {
    let mut parts = project_id.split('/');
    let owner = parts.next().unwrap_or("");
    format!("{owner}/{}", parts.next().unwrap_or("undefined"))
}

/// `x.user?.login ?? "unknown"`.
fn login(v: &Value) -> String {
    match v.get("user").and_then(|u| u.get("login")) {
        Some(l) if !l.is_null() => js_str(l),
        _ => "unknown".into(),
    }
}

/// `scanSources`: issue key to `updated_at`, pull requests left out, first-seen order, the last value winning.
pub async fn scan_sources(project_id: &str, source: &Source, cursor: Option<&str>) -> Result<Vec<(String, String)>> {
    let cfg = ticket_config(source)?;
    let token = resolve_env_ref(&cfg.token)?;
    let base_url = if cfg.base_url.is_empty() { DEFAULT_BASE_URL } else { cfg.base_url.as_str() };
    let repo = repo_path(&cfg.project_id);
    let since = match cursor.filter(|c| !c.is_empty()) {
        Some(c) => {
            let at = chrono::DateTime::parse_from_rfc3339(c).map_err(|_| anyhow!("Invalid time value"))?;
            Some((at.to_utc() - chrono::Duration::seconds(60)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        }
        None => None,
    };
    let url = match since {
        Some(s) => format!("{base_url}/repos/{repo}/issues?state=all&since={}", encode_uri_component(&s)),
        None => format!("{base_url}/repos/{repo}/issues?state=all"),
    };
    let issues = fetch_all_pages(&url, &token, project_id).await?;
    let mut map: Vec<(String, String)> = vec![];
    for issue in &issues {
        if is_pull_request(issue) {
            continue;
        }
        let key = format!("issues/{}", field_str(issue, "number"));
        let updated = field_str(issue, "updated_at");
        match map.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = updated,
            None => map.push((key, updated)),
        }
    }
    Ok(map)
}

/// One issue's chunks, or None for a 404, which `fetchChunks` skips with a warning. The caller sleeps
/// 50 ms after each issue it consumed.
pub async fn fetch_issue_chunks(project_id: &str, source: &Source, key: &str, sizes: Sizes) -> Result<Option<Vec<KnowledgeChunk>>> {
    let cfg = ticket_config(source)?;
    let token = resolve_env_ref(&cfg.token)?;
    let base_url = if cfg.base_url.is_empty() { DEFAULT_BASE_URL } else { cfg.base_url.as_str() };
    let repo = repo_path(&cfg.project_id);
    let number = key.replacen("issues/", "", 1);
    let issue_url = format!("{base_url}/repos/{repo}/issues/{number}");
    let comments_url = format!("{issue_url}/comments");
    match build_chunks(project_id, source, &token, &issue_url, &comments_url, sizes).await {
        Err(e) if e.to_string().contains("404") => {
            eprintln!("[scrybe] GitHub issue '{key}' not found (404) — skipping");
            Ok(None)
        }
        other => other.map(Some),
    }
}

async fn build_chunks(project_id: &str, source: &Source, token: &str, issue_url: &str, comments_url: &str, sizes: Sizes) -> Result<Vec<KnowledgeChunk>> {
    // Both requests go out together, as in the TypeScript's Promise.all.
    let (issue, comments) = futures::join!(github_fetch(issue_url, token, project_id), fetch_all_pages(comments_url, token, project_id));
    let (issue, comments) = (issue?, comments?);
    if is_pull_request(&issue) {
        return Ok(vec![]);
    }
    let meta = serialize_issue_metadata(&issue)?;
    let emit = Emit { project_id, source_id: &source.source_id, meta: &meta, sizes };
    let number = field_str(&issue, "number");
    let html_url = field_str(&issue, "html_url");
    let updated_at = field_str(&issue, "updated_at");
    let title = field_str(&issue, "title");
    let body = match issue.get("body") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js_trim(s).to_string(),
        Some(_) => bail!("issue.body?.trim is not a function"),
    };
    let text = normalize_content(js_trim(&format!("# {title}\n\n{body}")));
    let mut out = emit.chunks(&format!("issues/{number}"), &text, &login(&issue), &updated_at, "ticket", &html_url);
    for comment in &comments {
        let raw = match comment.get("body") {
            None | Some(Value::Null) => "",
            Some(Value::String(s)) => s.as_str(),
            Some(_) => bail!("comment.body?.trim is not a function"),
        };
        let text = normalize_content(js_trim(raw));
        if text.is_empty() {
            continue;
        }
        let id = field_str(comment, "id");
        let created = comment.get("created_at").filter(|c| truthy(c)).map_or_else(|| updated_at.clone(), js_str);
        out.extend(emit.chunks(&format!("issues/{number}#comment_{id}"), &text, &login(comment), &created, "ticket_comment", &format!("{html_url}#issuecomment-{id}")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_int_follows_javascript() {
        assert_eq!(parse_int("30"), 30.0);
        assert_eq!(parse_int("  -4s"), -4.0);
        assert!(parse_int("soon").is_nan());
        assert!(parse_int("").is_nan());
    }

    #[test]
    fn repo_path_splits_like_the_typescript() {
        assert_eq!(repo_path("acme/widgets"), "acme/widgets");
        assert_eq!(repo_path("acme/widgets/extra"), "acme/widgets");
        assert_eq!(repo_path("acme"), "acme/undefined");
    }

    #[test]
    fn metadata_is_serialized_like_the_typescript() {
        let issue = json!({
            "state": "open",
            "labels": [{ "name": "Bug" }, { "name": "ü" }],
            "assignees": [{ "login": "alice" }],
            "milestone": { "title": "M1", "due_date": "2026-12-01" },
        });
        let m = serialize_issue_metadata(&issue).unwrap();
        assert_eq!((m.state.as_str(), m.labels.as_str(), m.assignees.as_str()), ("open", "[\"Bug\",\"ü\"]", "[\"alice\"]"));
        assert_eq!((m.milestone.as_str(), m.confidential.as_str()), ("{\"title\":\"M1\",\"due_date\":null}", "false"));
        let bare = serialize_issue_metadata(&json!({ "state": "closed", "milestone": null })).unwrap();
        assert_eq!((bare.labels.as_str(), bare.assignees.as_str(), bare.milestone.as_str()), ("[]", "[]", ""));
    }

    #[test]
    fn pull_requests_are_recognised_by_their_key() {
        assert!(is_pull_request(&json!({ "number": 1, "pull_request": { "url": "x" } })));
        assert!(!is_pull_request(&json!({ "number": 1 })));
    }
}
