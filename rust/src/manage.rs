//! Project, source and private-ignore tools. Mirrors `src/tools/project.ts`, the `update_source`, `remove_source`
//! and `list_branches` tools, `src/tools/private-ignores.ts` and `src/private-ignore.ts`.
//! Every error here is plain, so the server masks it like today's does.
use crate::config::data_dir;
use crate::jobs::Queue;
use crate::jsstr::js_trim;
use crate::registry::{self, Source};
use crate::source_add;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A string argument that counts as given in JavaScript: present and not empty.
fn truthy(a: &Value, key: &str) -> bool {
    a[key].as_str().is_some_and(|s| !s.is_empty())
}

fn ids(a: &Value) -> (String, String) {
    (a["project_id"].as_str().unwrap_or("").to_string(), a["source_id"].as_str().unwrap_or("").to_string())
}

fn project_of(id: &str) -> Result<registry::Project> {
    registry::get_project(id).ok_or_else(|| anyhow!("Project '{id}' not found"))
}

fn source_of(project: &registry::Project, id: &str) -> Result<Source> {
    project.sources.iter().find(|s| s.source_id == id).cloned().ok_or_else(|| anyhow!("Source '{id}' not found in project '{}'", project.id))
}

// ─── Projects ────────────────────────────────────────────────────────────────

pub fn add_project(a: &Value) -> Result<Value> {
    let (id, _) = ids(a);
    registry::add_project(&id, a["description"].as_str().unwrap_or(""))?;
    Ok(json!({ "ok": true, "project_id": id }))
}

pub fn update_project(a: &Value) -> Result<Value> {
    let (id, _) = ids(a);
    registry::update_project(&id, a.get("description").cloned())
}

/// `removeProject` up to the notifications: returns how many jobs it cancelled.
pub async fn remove_project(queue: &Arc<Queue>, id: &str) -> Result<usize> {
    let project = project_of(id)?;
    let cancelled = cancel_jobs(queue, id);
    for source in &project.sources {
        wipe_and_drop(queue, id, source).await;
    }
    registry::remove_project_entry(id)?;
    Ok(cancelled)
}

/// `cancelJobsForProject`: running jobs are told to stop, then every open row is closed.
fn cancel_jobs(queue: &Arc<Queue>, project: &str) -> usize {
    let open = queue.rows.open_jobs(project);
    for (job, _) in open.iter().filter(|(_, status)| status == "running") {
        queue.cancel(job, None);
    }
    open.iter().filter(|(job, _)| queue.rows.cancel_removed(job)).count()
}

// ─── Sources ─────────────────────────────────────────────────────────────────

pub fn update_source(a: &Value) -> Result<Value> {
    let (project_id, source_id) = ids(a);
    let existing = registry::get_project(&project_id).and_then(|p| p.sources.into_iter().find(|s| s.source_id == source_id)).ok_or_else(|| anyhow!("Source '{source_id}' not found in project '{project_id}'"))?;
    let mut patch = serde_json::Map::new();
    match existing.kind() {
        "ticket" => {
            let (_, url, project, token) = source_add::ticket_fields(a);
            if truthy(a, "token") || truthy(a, "gitlab_token") {
                patch.insert("token".into(), json!(token));
            }
            if truthy(a, "url") || truthy(a, "gitlab_url") {
                patch.insert("base_url".into(), json!(url));
            }
            if truthy(a, "project") || truthy(a, "gitlab_project_id") {
                patch.insert("project_id".into(), json!(project));
            }
        }
        "code" => {
            if truthy(a, "root_path") {
                patch.insert("root_path".into(), a["root_path"].clone());
            }
            // The tool's schema says a list and its code splits a string: the command line sends a string, the server a list that fails.
            match &a["languages"] {
                Value::Null => {}
                Value::String(s) if s.is_empty() => {}
                Value::String(s) => {
                    patch.insert("languages".into(), json!(s.split(',').map(js_trim).collect::<Vec<_>>()));
                }
                _ => bail!("input.languages.split is not a function"),
            }
        }
        _ => {}
    }
    let updated = !patch.is_empty();
    if updated {
        let mut config = existing.source_config.clone();
        for (k, v) in patch {
            config[&k] = v;
        }
        registry::update_source(&project_id, &source_id, &[("source_config", config)])?;
    }
    Ok(json!({ "ok": true, "project_id": project_id, "source_id": source_id, "updated": updated }))
}

pub async fn remove_source(queue: &Arc<Queue>, a: &Value) -> Result<Value> {
    let (project_id, source_id) = ids(a);
    let project = project_of(&project_id)?;
    let source = source_of(&project, &source_id)?;
    wipe_and_drop(queue, &project_id, &source).await;
    registry::remove_source_entry(&project_id, &source_id)?;
    Ok(json!({ "ok": true, "project_id": project_id, "source_id": source_id }))
}

/// What `removeProject` and `removeSource` both do first. A failure is reported and the rest goes on.
async fn wipe_and_drop(queue: &Arc<Queue>, project: &str, source: &Source) {
    if let Err(e) = wipe_source(queue, project, &source.source_id) {
        eprintln!("[scrybe] Failed to wipe source '{}': {e:#}", source.source_id);
    }
    if let Some(table) = &source.table_name {
        if let Err(e) = queue.store().drop_table(table).await {
            eprintln!("[scrybe] Failed to drop table '{table}': {e:#}");
        }
    }
}

/// `wipeSource`: branch rows, then the cursor, batch-size memory and hash files, each best effort.
fn wipe_source(queue: &Arc<Queue>, project: &str, source: &str) -> Result<()> {
    queue.rows.wipe_source(project, source)?;
    let _ = std::fs::remove_file(crate::index::cursor_path(project, source));
    let _ = crate::embed_api::delete_entries_for_source(project, source);
    let prefix = format!("{project}__{source}__");
    for entry in std::fs::read_dir(data_dir().join("hashes")).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".json") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

// ─── Branches ────────────────────────────────────────────────────────────────

pub fn list_branches(queue: &Arc<Queue>, a: &Value) -> Result<Value> {
    let (project_id, _) = ids(a);
    let project = project_of(&project_id)?;
    let only = a["source_id"].as_str().filter(|s| !s.is_empty());
    let entries: Vec<Value> = project
        .sources
        .iter()
        .filter(|s| only.is_none_or(|id| id == s.source_id))
        .map(|s| {
            let branches = if s.kind() == "code" { queue.rows.list_branches(&project_id, &s.source_id) } else { vec!["*".to_string()] };
            json!({ "source_id": s.source_id, "branches": branches })
        })
        .collect();
    Ok(Value::Array(entries))
}

// ─── Private ignore rules ────────────────────────────────────────────────────

fn ignore_path(project: &str, source: &str) -> PathBuf {
    data_dir().join("ignores").join(project).join(format!("{source}.gitignore"))
}

fn text_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `loadPrivateIgnore`: None when there is no file.
fn load(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn rule_lines(content: &str) -> impl Iterator<Item = &str> {
    content.split('\n').map(str::trim).filter(|t| !t.is_empty() && !t.starts_with('#'))
}

/// `countRules`.
fn count_rules(content: Option<&str>) -> usize {
    content.map_or(0, |c| rule_lines(c).count())
}

/// `isMissingOrEmpty`: no file, or only blank and comment lines.
fn missing_or_empty(content: Option<&str>) -> bool {
    content.is_none_or(|c| rule_lines(c).next().is_none())
}

/// What `set_private_ignore` does to the file at `path`, and the word for it.
fn apply(path: &Path, content: &str) -> Result<&'static str> {
    let previous = load(path);
    if missing_or_empty(Some(content)) {
        if missing_or_empty(previous.as_deref()) {
            return Ok("unchanged");
        }
        std::fs::remove_file(path)?;
        return Ok("deleted");
    }
    if previous.as_deref() == Some(content) {
        return Ok("unchanged");
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, content)?;
    Ok("written")
}

pub fn set_private_ignore(a: &Value) -> Result<Value> {
    let (project_id, source_id) = ids(a);
    let project = project_of(&project_id)?;
    let source = source_of(&project, &source_id)?;
    if source.kind() != "code" {
        bail!("Source '{source_id}' in project '{project_id}' is a '{}' source. Private ignore rules only apply to code sources. Knowledge source ignores are on the roadmap.", source.kind());
    }
    let path = ignore_path(&project_id, &source_id);
    let action = apply(&path, a["content"].as_str().unwrap_or(""))?;
    let hint = format!("To apply changes, run: scrybe index -P {project_id} -S {source_id} --incremental\n  (or via MCP: reindex_source with project_id=\"{project_id}\", source_id=\"{source_id}\", mode=\"incremental\")");
    Ok(json!({ "ok": true, "path": text_of(&path), "action": action, "hint": hint }))
}

pub fn get_private_ignore(a: &Value) -> Result<Value> {
    let (project_id, source_id) = ids(a);
    let project = project_of(&project_id)?;
    source_of(&project, &source_id)?;
    let path = ignore_path(&project_id, &source_id);
    let content = load(&path);
    Ok(json!({ "project_id": project_id, "source_id": source_id, "content": content, "path": text_of(&path), "rule_count": count_rules(content.as_deref()) }))
}

pub fn list_private_ignores(a: &Value) -> Result<Value> {
    let projects = match a["project_id"].as_str().filter(|s| !s.is_empty()) {
        Some(id) => vec![project_of(id)?],
        None => registry::list_projects(),
    };
    let mut out = vec![];
    for project in &projects {
        for source in project.sources.iter().filter(|s| s.kind() == "code") {
            let path = ignore_path(&project.id, &source.source_id);
            let content = load(&path);
            if missing_or_empty(content.as_deref()) {
                continue;
            }
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
            out.push(json!({ "project_id": project.id, "source_id": source.source_id, "path": text_of(&path), "rule_count": count_rules(content.as_deref()), "mtime": mtime }));
        }
    }
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scrybe-manage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn only_rule_lines_are_counted() {
        assert_eq!(count_rules(None), 0);
        assert_eq!(count_rules(Some("")), 0);
        assert_eq!(count_rules(Some("# note\n\n  \r\nvendor/\r\n*.log\n  # indented note\n")), 2);
        assert!(missing_or_empty(None));
        assert!(missing_or_empty(Some("# only\n\n")));
        assert!(!missing_or_empty(Some("# a\nvendor/")));
    }

    #[test]
    fn setting_rules_writes_changes_and_clears_them() {
        let dir = scratch("set");
        let path = dir.join("ignores/p/s.gitignore");
        assert_eq!(apply(&path, "vendor/\n").unwrap(), "written");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "vendor/\n");
        assert_eq!(apply(&path, "vendor/\n").unwrap(), "unchanged");
        assert_eq!(apply(&path, "vendor/\n*.log\n").unwrap(), "written");
        assert_eq!(apply(&path, "# nothing here\n").unwrap(), "deleted");
        assert!(!path.exists());
        assert_eq!(apply(&path, "").unwrap(), "unchanged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_of_only_comments_is_left_alone_by_a_clear() {
        let dir = scratch("template");
        let path = dir.join("t.gitignore");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "# template\n").unwrap();
        assert_eq!(apply(&path, "").unwrap(), "unchanged");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_value_counts_as_given_only_when_it_is_a_non_empty_string() {
        let a = json!({ "a": "x", "b": "", "c": null, "d": ["x"] });
        assert!(truthy(&a, "a"));
        assert!(!truthy(&a, "b") && !truthy(&a, "c") && !truthy(&a, "d") && !truthy(&a, "missing"));
    }
}
