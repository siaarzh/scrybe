//! Read-only view of `projects.json` and `config.json`. Mirrors `src/registry.ts` and the preset
//! lookups it needs. Old flat-shape projects are shown, never rewritten.
use crate::config::data_dir;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
pub struct Source {
    pub source_id: String,
    #[serde(default)]
    pub source_config: Value,
    #[serde(default)]
    pub table_name: Option<String>,
    #[serde(default)]
    pub last_indexed: Option<String>,
}

impl Source {
    pub fn kind(&self) -> &str {
        self.source_config.get("type").and_then(Value::as_str).unwrap_or("unknown")
    }
    /// "code", "text", or None for a type no plugin handles.
    pub fn profile(&self) -> Option<&'static str> {
        match self.kind() {
            "code" => Some("code"),
            "ticket" => Some("text"),
            _ => None,
        }
    }
    pub fn root_path(&self) -> Option<&str> {
        self.source_config.get("root_path").and_then(Value::as_str)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

pub fn list_projects() -> Vec<Project> {
    let Ok(text) = std::fs::read_to_string(data_dir().join("projects.json")) else { return vec![] };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn get_project(id: &str) -> Option<Project> {
    list_projects().into_iter().find(|p| p.id == id)
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PromptTemplate {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub passage: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Preset {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt_template: Option<PromptTemplate>,
    #[serde(default)]
    pub max_input_tokens: Option<usize>,
    #[serde(default)]
    pub credentials: Option<String>,
    #[serde(default)]
    pub credentials_from: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScrybeConfig {
    #[serde(default)]
    pub embedding_presets: HashMap<String, Preset>,
    #[serde(default)]
    pub assignments: HashMap<String, String>,
}

pub fn read_config() -> Result<Option<ScrybeConfig>> {
    let p = data_dir().join("config.json");
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&p).context("Failed to read config.json")?;
    Ok(Some(serde_json::from_str(&raw).context("Failed to parse config.json")?))
}

fn slot(source: &Source) -> &'static str {
    if source.profile() == Some("text") { "text_preset" } else { "code_preset" }
}

/// Local embedding settings for a source. API providers aren't ported yet.
pub fn resolve_local_model(source: &Source) -> Result<(String, String)> {
    let Some(cfg) = read_config()? else {
        anyhow::bail!("scrybe is not configured — run 'scrybe init'");
    };
    let Some(name) = cfg.assignments.get(slot(source)) else {
        anyhow::bail!("scrybe is not configured — run 'scrybe init'");
    };
    let Some(preset) = cfg.embedding_presets.get(name) else {
        anyhow::bail!("Preset \"{name}\" not found in config — run 'scrybe init'");
    };
    if preset.provider != "local" {
        anyhow::bail!("Unknown embedding provider: the Rust read path only serves local embedding so far (preset \"{name}\" uses \"{}\")", preset.provider);
    }
    let prefix = preset.prompt_template.as_ref().map(|t| t.query.clone()).unwrap_or_default();
    Ok((preset.model.clone(), prefix))
}

pub fn passage_prefix(source: &Source) -> Result<String> {
    let cfg = read_config()?.unwrap_or_default();
    let preset = cfg.assignments.get(slot(source)).and_then(|n| cfg.embedding_presets.get(n));
    Ok(preset.and_then(|p| p.prompt_template.as_ref()).map(|t| t.passage.clone()).unwrap_or_default())
}

/// `getCharCap`: 4 characters per token, or the 8,000-token default.
pub fn char_cap(source: &Source) -> Result<usize> {
    let cfg = read_config()?.unwrap_or_default();
    let tokens = cfg.assignments.get(slot(source)).and_then(|n| cfg.embedding_presets.get(n)).and_then(|p| p.max_input_tokens);
    Ok(tokens.map(|t| t * 4).unwrap_or(8000 * 4))
}

/// Mirrors `isSearchable`.
pub fn is_searchable(source: &Source) -> (bool, Option<String>) {
    if source.table_name.is_none() {
        return (false, Some("Never indexed — run a full index first".into()));
    }
    let cfg = match read_config() {
        Ok(Some(c)) => c,
        Ok(None) => return (true, None),
        Err(e) => return (false, Some(e.to_string())),
    };
    let Some(name) = cfg.assignments.get(slot(source)) else {
        return (false, Some("scrybe is not configured — run 'scrybe init'".into()));
    };
    let Some(preset) = cfg.embedding_presets.get(name) else {
        return (false, Some(format!("Preset \"{name}\" not found in config — run 'scrybe init'")));
    };
    if preset.provider == "local" {
        return (true, None);
    }
    let raw = match &preset.credentials_from {
        Some(from) => cfg.embedding_presets.get(from).and_then(|p| p.credentials.clone()),
        None => preset.credentials.clone(),
    };
    let Some(raw) = raw else { return (true, None) };
    let Some(var) = raw.strip_prefix("${").and_then(|r| r.strip_suffix('}')) else { return (true, None) };
    let valid = !var.is_empty()
        && var.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !var.starts_with(|c: char| c.is_ascii_digit());
    if !valid {
        return (true, None);
    }
    if std::env::var(var).unwrap_or_default().is_empty() {
        return (false, Some(format!("Requires env var {var} (model: {}) — not set in current environment", preset.model)));
    }
    (true, None)
}
