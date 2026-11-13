//! `add_source`. Mirrors `addSourceTool` in `src/tools/source.ts` as it runs inside the server:
//! check the token, save the source, queue its first run.
use crate::gitlab_issues::TicketConfig;
use crate::jobs::{Queue, Request};
use crate::registry;
use crate::{github_issues, gitlab_issues};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::sync::Arc;

fn text(a: &Value, key: &str) -> Option<String> {
    a[key].as_str().map(String::from)
}

/// `resolveTicketFields`: the generic fields win over the deprecated `gitlab_*` ones.
pub(crate) fn ticket_fields(a: &Value) -> (String, String, String, String) {
    let alias = |old: &str, new: &str, key: &str| {
        let v = text(a, key);
        if v.is_some() {
            eprintln!("[scrybe] --{old} is deprecated. Use --{new} instead. The --gitlab-* flags will be removed in a future major version.");
        }
        v
    };
    let url = text(a, "url").or(alias("gitlab-url", "url", "gitlab_url"));
    let project = text(a, "project").or(alias("gitlab-project-id", "project", "gitlab_project_id"));
    let token = text(a, "token").or(alias("gitlab-token", "token", "gitlab_token"));
    (text(a, "provider").unwrap_or_else(|| "gitlab".into()), url.unwrap_or_default(), project.unwrap_or_default(), token.unwrap_or_default())
}

/// `buildSourceConfig`.
fn build_config(a: &Value) -> Value {
    match a["source_type"].as_str().unwrap_or("") {
        "code" => {
            let langs: Vec<String> = match &a["languages"] {
                Value::Array(l) => l.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).collect(),
                Value::String(s) if !s.is_empty() => s.split(',').map(|s| s.trim().to_string()).collect(),
                _ => vec![],
            };
            json!({ "type": "code", "root_path": text(a, "root_path").unwrap_or_default(), "languages": langs })
        }
        "ticket" => {
            let (provider, url, project, token) = ticket_fields(a);
            json!({ "type": "ticket", "provider": provider, "base_url": url, "project_id": project, "token": token })
        }
        other => json!({ "type": other }),
    }
}

fn ticket_config(config: &Value) -> TicketConfig {
    let field = |k: &str| config.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    TicketConfig { base_url: field("base_url"), project_id: field("project_id"), token: field("token") }
}

/// `validateToken`: GitHub has its own check, every other provider is read as GitLab.
async fn validate_token(config: &Value) -> Result<()> {
    if config["type"] != "ticket" {
        return Ok(());
    }
    let cfg = ticket_config(config);
    if config["provider"] == "github" {
        github_issues::validate_token(&cfg, true).await
    } else {
        gitlab_issues::validate_token(&cfg, true).await
    }
}

/// What `add` settles before it writes anything: the embedding setup and the token are fine.
pub async fn prepare(a: &Value) -> Result<Value> {
    let status = registry::embedding_status();
    if status["config_error"] == true {
        bail!("{}", status["config_error_message"].as_str().unwrap_or("embedding config error"));
    }
    let config = build_config(a);
    validate_token(&config).await?;
    Ok(config)
}

/// Saves the source `prepare` approved.
pub fn save(a: &Value, config: Value) -> Result<()> {
    let (project, source_id) = (text(a, "project_id").unwrap_or_default(), text(a, "source_id").unwrap_or_default());
    registry::add_source(&project, json!({ "source_id": source_id, "source_config": config }))
}

pub async fn add(queue: &Arc<Queue>, a: &Value) -> Result<Value> {
    let config = prepare(a).await?;
    save(a, config)?;
    submit(queue, &text(a, "project_id").unwrap_or_default(), &text(a, "source_id").unwrap_or_default())
}

/// Queues the first run of a saved source.
pub fn submit(queue: &Arc<Queue>, project: &str, source_id: &str) -> Result<Value> {
    let (project, source_id) = (project.to_string(), source_id.to_string());
    let r = queue.submit(Request { project: project.clone(), source: Some(source_id.clone()), ..Default::default() });
    if r.status == "rejected" {
        let (pending, max) = queue.depth();
        bail!("Queue at capacity ({pending}/{max})");
    }
    let mut out = json!({ "ok": true, "project_id": project, "source_id": source_id, "job_id": r.job_id, "status": r.status });
    if let Some(q) = r.queue_position {
        out["queue_position"] = json!(q);
    }
    if r.duplicate_of_pending {
        out["duplicate_of_pending"] = json!(true);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{channel, Receiver};

    /// Answers one request with `status` and an empty JSON object. Returns its address and the request it saw.
    fn serve_once(status: &'static str) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
            }
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
            let _ = tx.send(String::from_utf8_lossy(&seen).to_lowercase());
        });
        (url, rx)
    }

    fn ticket(provider: &str, url: &str, token: &str) -> Value {
        json!({ "type": "ticket", "provider": provider, "base_url": url, "project_id": "acme/widgets", "token": token })
    }

    #[tokio::test]
    async fn github_checks_the_user_endpoint_with_the_token() {
        let (url, seen) = serve_once("200 OK");
        validate_token(&ticket("github", &url, "literal-token")).await.unwrap();
        let request = seen.recv().unwrap();
        assert!(request.starts_with("get /user http/1.1"), "{request}");
        assert!(request.contains("authorization: bearer literal-token"));
        assert!(request.contains("accept: application/vnd.github+json"));
        assert!(request.contains("x-github-api-version: 2022-11-28"));
    }

    #[tokio::test]
    async fn github_refuses_a_rejected_token_with_the_scopes_to_grant() {
        for status in ["401 Unauthorized", "403 Forbidden"] {
            let (url, _) = serve_once(status);
            let e = validate_token(&ticket("github", &url, "t")).await.unwrap_err().to_string();
            let code = &status[..3];
            assert_eq!(e, format!("GitHub token for project \"acme/widgets\" is invalid or lacks required permissions (HTTP {code}). Ensure the token has Issues: Read-only and Metadata: Read-only scopes (fine-grained PAT) or repo/public_repo (classic PAT)."));
        }
    }

    #[tokio::test]
    async fn github_names_any_other_failure() {
        let (url, _) = serve_once("500 Internal Server Error");
        let e = validate_token(&ticket("github", &url, "t")).await.unwrap_err().to_string();
        assert_eq!(e, "GitHub API error 500 Internal Server Error during token validation");
    }

    #[tokio::test]
    async fn gitlab_reads_the_project_with_the_token() {
        let (url, seen) = serve_once("200 OK");
        validate_token(&ticket("gitlab", &url, "literal-token")).await.unwrap();
        let request = seen.recv().unwrap();
        assert!(request.starts_with("get /api/v4/projects/acme%2fwidgets http/1.1"), "{request}");
        assert!(request.contains("authorization: bearer literal-token"));
    }

    #[tokio::test]
    async fn gitlab_refuses_a_rejected_token_with_the_fix() {
        for status in ["401 Unauthorized", "403 Forbidden"] {
            let (url, _) = serve_once(status);
            let e = validate_token(&ticket("gitlab", &url, "t")).await.unwrap_err().to_string();
            let code = &status[..3];
            assert_eq!(e, format!("GitLab token for project \"acme/widgets\" is expired or invalid (HTTP {code}). Update it with: scrybe update-source --project-id acme/widgets --source-id <source-id> --gitlab-token <new-token>"));
        }
    }

    #[tokio::test]
    async fn an_unset_variable_is_told_to_the_caller_before_any_request() {
        let token = "${SCRYBE_TEST_TOKEN_THAT_IS_NOT_SET}";
        for provider in ["github", "gitlab"] {
            let e = validate_token(&ticket(provider, "http://127.0.0.1:1", token)).await.unwrap_err();
            assert!(e.downcast_ref::<registry::CallerFacing>().is_some());
            let label = if provider == "github" { "GitHub" } else { "GitLab" };
            assert!(e.to_string().starts_with(&format!("Token for {label} source \"acme/widgets\" references env var SCRYBE_TEST_TOKEN_THAT_IS_NOT_SET which is not set. Set it in your environment or in <DATA_DIR>/.env: SCRYBE_TEST_TOKEN_THAT_IS_NOT_SET=<your-token>. The daemon only")), "{e}");
        }
    }

    #[test]
    fn the_remedy_is_empty_outside_the_server_and_names_the_variable_inside() {
        assert_eq!(registry::env_ref_remedy("X_TOKEN", false), "");
        let inside = registry::env_ref_remedy("X_TOKEN", true);
        assert!(inside.starts_with(". The daemon only "), "{inside}");
        assert!(inside.contains("X_TOKEN"));
        assert!(inside.contains("scrybe daemon stop"));
    }

    #[test]
    fn a_token_that_is_not_a_reference_is_named_as_it_is() {
        let e = registry::unset_token_error("GitLab", "7", "plain", true).to_string();
        assert_eq!(e, "Token for GitLab source \"7\" references env var plain which is not set. Set it in your environment or in <DATA_DIR>/.env: plain=<your-token>");
    }

    #[test]
    fn a_ticket_source_defaults_to_gitlab_and_the_old_names_still_work() {
        let c = build_config(&json!({ "source_type": "ticket", "gitlab_url": "https://a.example.invalid", "gitlab_project_id": "7", "gitlab_token": "${T}" }));
        assert_eq!(c, json!({ "type": "ticket", "provider": "gitlab", "base_url": "https://a.example.invalid", "project_id": "7", "token": "${T}" }));
        let c = build_config(&json!({ "source_type": "ticket", "provider": "github", "url": "u", "gitlab_url": "old", "project": "acme/widgets" }));
        assert_eq!(c["base_url"], "u");
        assert_eq!(c["token"], "");
    }

    #[test]
    fn a_code_source_takes_its_languages_as_a_list_or_a_string() {
        let c = build_config(&json!({ "source_type": "code", "root_path": "/r", "languages": ["ts", " vue "] }));
        assert_eq!(c, json!({ "type": "code", "root_path": "/r", "languages": ["ts", "vue"] }));
        assert_eq!(build_config(&json!({ "source_type": "code", "root_path": "/r", "languages": "py, go" }))["languages"], json!(["py", "go"]));
        assert_eq!(build_config(&json!({ "source_type": "code" }))["languages"], json!([]));
    }
}
