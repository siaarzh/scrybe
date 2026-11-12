//! `index_ephemeral` and `drop_ephemeral`. Mirrors the two tools in `src/tools/reindex.ts`.
//! Plain errors, so the server masks them like today's does.
use crate::jobs::{now_ms, Queue, Request};
use crate::{index, registry};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const PREFIX: &str = "_ephemeral/";

/// `planEphemeralIndex`: the label to store and the ref to read, whatever form `branch` came in.
pub fn plan(branch: &str, label: Option<&str>) -> (String, String) {
    let full_ref = branch.starts_with("refs/") || branch.starts_with("origin/");
    let content_ref = if full_ref { branch.to_string() } else { format!("origin/{branch}") };
    let base = match label.filter(|l| !l.is_empty()) {
        Some(l) => l.to_string(),
        None if full_ref => format!("mr-{}", branch.split('/').rfind(|s| !s.is_empty()).unwrap_or(branch)),
        None => format!("mr-{branch}"),
    };
    let label = if base.starts_with(PREFIX) { base } else { format!("{PREFIX}{base}") };
    (label, content_ref)
}

fn text<'a>(a: &'a Value, key: &str) -> &'a str {
    a[key].as_str().unwrap_or("")
}

/// A job's row once it has finished, or the last one seen when the wait runs out.
async fn wait_for(queue: &Arc<Queue>, job: &str, limit: Duration) -> Option<Value> {
    let deadline = Instant::now() + limit;
    let mut row = queue.rows.get(job);
    while Instant::now() < deadline {
        row = queue.rows.get(job);
        if row.as_ref().is_some_and(|r| matches!(r["status"].as_str(), Some("done" | "failed" | "cancelled"))) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    row
}

pub async fn index_branch(queue: &Arc<Queue>, a: &Value) -> Result<Value> {
    let project = text(a, "project_id");
    if registry::get_project(project).is_none() {
        bail!("Project '{project}' not found");
    }
    let source = a["source_id"].as_str().unwrap_or("primary");
    let (label, content_ref) = plan(text(a, "branch"), a["label"].as_str());
    let started = now_ms();
    let submitted = queue.submit(Request { project: project.to_string(), source: Some(source.to_string()), branch: Some(label.clone()), content_ref: Some(content_ref), ..Default::default() });
    if submitted.status == "rejected" {
        bail!("Daemon returned no job");
    }
    let row = wait_for(queue, &submitted.job_id, Duration::from_secs(600)).await;
    let Some(row) = row else { bail!("Job '{}' status unavailable", submitted.job_id) };
    if row["status"] == "failed" {
        bail!("{}", row["error_message"].as_str().map_or_else(|| format!("index_ephemeral failed for label '{label}'"), String::from));
    }
    let duration = match (row["started_at"].as_i64(), row["finished_at"].as_i64()) {
        (Some(s), Some(f)) => f - s,
        _ => now_ms() - started,
    };
    // Per-task chunk counts aren't kept for a job, so both stay 0 as they do today.
    Ok(json!({ "label": label, "chunks_new": 0, "chunks_reused": 0, "duration_ms": duration }))
}

/// What `drop_ephemeral` settles before any gc: the ids, and whether the label held rows.
pub struct Dropped {
    pub project: String,
    pub source: String,
    pub label: String,
    pub existed: bool,
}

/// The label's tags, state and hash file go; the rows only it used stay until a gc.
pub fn drop_label(queue: &Arc<Queue>, a: &Value) -> Result<Dropped> {
    let project = text(a, "project_id");
    let label = text(a, "label");
    if registry::get_project(project).is_none() {
        bail!("Project '{project}' not found");
    }
    if !label.starts_with(PREFIX) {
        bail!("drop_ephemeral refuses to drop '{label}' — only labels under '{PREFIX}' can be dropped (safety: this verb must never remove a real branch like 'dev' or 'master').");
    }
    let source = a["source_id"].as_str().unwrap_or("primary");
    let existed = queue.rows.branch_has_chunks(project, source, label);
    queue.rows.delete_branch(project, source, label)?;
    let hashes = index::hashes_path(project, source, label);
    if hashes.exists() {
        std::fs::remove_file(hashes)?;
    }
    Ok(Dropped { project: project.to_string(), source: source.to_string(), label: label.to_string(), existed })
}

/// Waits for the gc job and reports what it freed; a gc that didn't finish reports zeros.
pub async fn drop_result(queue: &Arc<Queue>, job: &str, d: &Dropped) -> Value {
    let row = wait_for(queue, job, Duration::from_secs(300)).await;
    let freed = row.filter(|r| r["status"] == "done").and_then(|r| r["result"].as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()));
    let (orphans, bytes) = freed.map_or((json!(0), json!(0)), |r| (r["orphans_deleted"].clone(), r["bytes_freed"].clone()));
    json!({ "label": d.label, "dropped": d.existed, "orphans_deleted": orphans, "bytes_freed": bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_branch_is_read_from_origin_and_labelled_mr() {
        assert_eq!(plan("feature-x", None), ("_ephemeral/mr-feature-x".into(), "origin/feature-x".into()));
        assert_eq!(plan("feat/x", None), ("_ephemeral/mr-feat/x".into(), "origin/feat/x".into()));
    }

    #[test]
    fn a_full_ref_is_read_as_given_and_labelled_by_its_last_segment() {
        assert_eq!(plan("refs/scrybe-ephemeral/mr-42", None), ("_ephemeral/mr-mr-42".into(), "refs/scrybe-ephemeral/mr-42".into()));
        assert_eq!(plan("origin/feature-x", None), ("_ephemeral/mr-feature-x".into(), "origin/feature-x".into()));
        assert_eq!(plan("origin/feature-x/", None).0, "_ephemeral/mr-feature-x");
    }

    #[test]
    fn a_label_override_is_always_put_under_the_prefix_and_never_doubled() {
        assert_eq!(plan("b", Some("review-1")).0, "_ephemeral/review-1");
        assert_eq!(plan("b", Some("_ephemeral/review-1")).0, "_ephemeral/review-1");
        assert_eq!(plan("b", Some("")).0, "_ephemeral/mr-b");
        assert_eq!(plan("refs/heads/b", Some("x")), ("_ephemeral/x".into(), "refs/heads/b".into()));
    }
}
