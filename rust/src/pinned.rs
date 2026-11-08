//! Per-source pinned branches. Mirrors `src/pinned-branches.ts`, plus the ignore-coverage check from `src/private-ignore.ts`.
use crate::config::data_dir;
use crate::git;
use crate::registry::{self, Source};
use serde_json::{json, Value};
use std::path::Path;

const WARNING_THRESHOLD: usize = 20;

#[derive(Debug, PartialEq)]
pub enum PinError {
    InvalidSourceType(String, String),
    SourceNotFound(String, String),
    ProjectNotFound(String),
}

impl PinError {
    pub fn message(&self) -> String {
        match self {
            PinError::InvalidSourceType(p, s) => format!("Source '{s}' in project '{p}' is not a code source. Pinned branches only apply to code sources."),
            PinError::SourceNotFound(p, s) => format!("Source '{s}' not found in project '{p}'"),
            PinError::ProjectNotFound(p) => format!("Project '{p}' not found"),
        }
    }

    pub fn error_type(&self) -> &'static str {
        match self {
            PinError::InvalidSourceType(..) => "invalid_source_type",
            PinError::SourceNotFound(..) => "source_not_found",
            PinError::ProjectNotFound(_) => "project_not_found",
        }
    }

    /// The status the HTTP route answers with.
    pub fn status(&self) -> &'static str {
        match self {
            PinError::InvalidSourceType(..) => "400 Bad Request",
            _ => "404 Not Found",
        }
    }
}

fn code_source(project: &str, source: &str) -> Result<Source, PinError> {
    let p = registry::get_project(project).ok_or_else(|| PinError::ProjectNotFound(project.to_string()))?;
    let s = p.sources.into_iter().find(|s| s.source_id == source).ok_or_else(|| PinError::SourceNotFound(project.to_string(), source.to_string()))?;
    if s.kind() != "code" {
        return Err(PinError::InvalidSourceType(project.to_string(), source.to_string()));
    }
    Ok(s)
}

fn save(project: &str, source: &str, branches: &[String]) {
    // Like today, a failed write is not reported back to the caller of the pure helpers.
    let _ = registry::update_source(project, source, &[("pinned_branches", json!(branches))]);
}

pub fn list(project: &str, source: &str) -> Result<Vec<String>, PinError> {
    Ok(code_source(project, source)?.pinned_branches.unwrap_or_default())
}

pub struct Added {
    pub branches: Vec<String>,
    pub added: Vec<String>,
    pub warnings: Vec<String>,
}

impl Added {
    pub fn to_json(&self) -> Value {
        json!({ "branches": self.branches, "added": self.added, "warnings": self.warnings })
    }
}

pub fn add(project: &str, source: &str, branches: &[String], set: bool) -> Result<Added, PinError> {
    let existing = code_source(project, source)?.pinned_branches.unwrap_or_default();
    let (next, added) = if set {
        let mut next: Vec<String> = vec![];
        for b in branches {
            if !next.contains(b) {
                next.push(b.clone());
            }
        }
        let added = next.iter().filter(|b| !existing.contains(b)).cloned().collect();
        (next, added)
    } else {
        let incoming: Vec<String> = branches.iter().filter(|b| !existing.contains(b)).cloned().collect();
        let mut next = existing;
        next.extend(incoming.iter().cloned());
        (next, incoming)
    };
    save(project, source, &next);
    let warnings = if next.len() > WARNING_THRESHOLD {
        vec![format!(
            "Project '{project}' source '{source}' has {} pinned branches. Indexing many branches increases disk usage and fetch time. Review with: scrybe pin list --project-id {project} --source-id {source}",
            next.len()
        )]
    } else {
        vec![]
    };
    Ok(Added { branches: next, added, warnings })
}

pub struct Removed {
    pub branches: Vec<String>,
    pub removed: Vec<String>,
}

impl Removed {
    pub fn to_json(&self) -> Value {
        json!({ "branches": self.branches, "removed": self.removed })
    }
}

pub fn remove(project: &str, source: &str, branches: &[String]) -> Result<Removed, PinError> {
    let existing = code_source(project, source)?.pinned_branches.unwrap_or_default();
    let removed = branches.iter().filter(|b| existing.contains(b)).cloned().collect();
    let next: Vec<String> = existing.into_iter().filter(|b| !branches.contains(b)).collect();
    save(project, source, &next);
    Ok(Removed { branches: next, removed })
}

pub fn clear(project: &str, source: &str) -> Result<Removed, PinError> {
    let removed = code_source(project, source)?.pinned_branches.unwrap_or_default();
    save(project, source, &[]);
    Ok(Removed { branches: vec![], removed })
}

/// `isMissingOrEmpty`: only blank and comment lines.
fn no_rules(content: &str) -> bool {
    content.split('\n').all(|l| {
        let t = l.trim();
        t.is_empty() || t.starts_with('#')
    })
}

/// `checkIgnoreCoverage`: the warning for a branch with neither a committed `.scrybeignore` nor private rules.
pub fn ignore_warning(root: &str, branch: &str, project: &str, source: &str) -> Option<String> {
    let committed = git::output(Path::new(root), &["show", &format!("{branch}:.scrybeignore")], None).is_some_and(|s| !s.is_empty());
    let private = std::fs::read_to_string(data_dir().join("ignores").join(project).join(format!("{source}.gitignore"))).ok();
    if committed || private.is_some_and(|c| !no_rules(&c)) {
        return None;
    }
    Some(
        [
            format!("warning: branch '{branch}' has no .scrybeignore and source '{project}/{source}' has no private ignore."),
            "         indexing will use built-in skip rules + .gitignore only.".to_string(),
            "         consider running: scrybe ignore   (to set source-level rules)".to_string(),
            format!("                       or: add .scrybeignore to the {branch} branch"),
        ]
        .join("\n"),
    )
}

/// `list_pinned_branches`: one entry per code source, or only the named one.
pub fn list_tool(project: &str, source: Option<&str>) -> Result<Value, String> {
    let p = registry::get_project(project).ok_or_else(|| PinError::ProjectNotFound(project.to_string()).message())?;
    let entries: Vec<Value> = p
        .sources
        .iter()
        .filter(|s| s.kind() == "code" && source.is_none_or(|id| id == s.source_id))
        .map(|s| json!({ "source_id": s.source_id, "branches": s.pinned_branches.clone().unwrap_or_default() }))
        .collect();
    Ok(Value::Array(entries))
}

/// `pin_branches`: the add result, plus ignore warnings for each newly pinned branch.
pub fn pin_tool(project: &str, source: &str, branches: &[String], set: bool) -> Result<Value, String> {
    let result = add(project, source, branches, set).map_err(|e| e.message())?;
    let mut out = result.to_json();
    let root = registry::get_project(project).and_then(|p| p.sources.into_iter().find(|s| s.source_id == source && s.kind() == "code")).and_then(|s| s.root_path().map(String::from));
    if let Some(root) = root {
        let warnings: Vec<String> = result.added.iter().filter_map(|b| ignore_warning(&root, b, project, source)).collect();
        if !warnings.is_empty() {
            out["ignore_warnings"] = json!(warnings);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_comment_lines_are_no_rules() {
        assert!(no_rules(""));
        assert!(no_rules("# a\n  \r\n# b\n"));
        assert!(!no_rules("# a\nvendor/\n"));
    }

    #[test]
    fn errors_carry_todays_texts_and_codes() {
        let e = PinError::InvalidSourceType("p".into(), "s".into());
        assert_eq!(e.message(), "Source 's' in project 'p' is not a code source. Pinned branches only apply to code sources.");
        assert_eq!((e.error_type(), e.status()), ("invalid_source_type", "400 Bad Request"));
        assert_eq!(PinError::SourceNotFound("p".into(), "s".into()).message(), "Source 's' not found in project 'p'");
        assert_eq!(PinError::ProjectNotFound("p".into()).status(), "404 Not Found");
    }
}
