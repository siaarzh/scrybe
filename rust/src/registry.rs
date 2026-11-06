//! Read-only view of `projects.json` and `config.json`. Mirrors `src/registry.ts` and the preset
//! lookups it needs. Old flat-shape projects are shown, never rewritten.
use crate::config::data_dir;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
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
    #[serde(default)]
    pub dim: Option<i32>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub encoding_format: Option<String>,
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

/// What `resolveEmbeddingConfig` returns, for a config.json setup. The legacy env-only setup isn't ported.
#[derive(Clone, Debug)]
pub struct EmbedConfig {
    pub local: bool,
    pub base_url: String,
    pub model: String,
    pub dimensions: i32,
    pub credentials: String,
    pub encoding_float: bool,
    pub max_input_tokens: Option<usize>,
    pub query_prefix: String,
    pub passage_prefix: String,
}

impl EmbedConfig {
    /// `getCharCap`: 4 characters per token, or the 8,000-token default.
    pub fn char_cap(&self) -> usize {
        self.max_input_tokens.map_or(8000 * 4, |t| t * 4)
    }
}

/// The catalog in `src/providers.ts`: base URL and dimensions.
fn catalog(provider: &str, model: &str) -> Result<(String, i32)> {
    let (base, models): (&str, &[(&str, i32)]) = match provider {
        "voyage" => ("https://api.voyageai.com/v1", &[("voyage-code-3", 1024), ("voyage-3", 1024), ("voyage-3-large", 1024), ("voyage-3.5", 1024), ("voyage-3.5-lite", 1024), ("voyage-4", 1024), ("voyage-4-lite", 1024), ("voyage-4-large", 1024)]),
        "openai" => ("https://api.openai.com/v1", &[("text-embedding-3-small", 1536), ("text-embedding-3-large", 3072)]),
        "local" => ("", &[("Xenova/multilingual-e5-small", 384), ("Xenova/all-MiniLM-L6-v2", 384)]),
        other => anyhow::bail!("unknown provider \"{other}\""),
    };
    let Some((_, dim)) = models.iter().find(|(m, _)| *m == model) else {
        anyhow::bail!("model \"{model}\" not found in provider \"{provider}\"");
    };
    Ok((base.to_string(), *dim))
}

/// `resolveEnvRef`: every `${VAR}` must be set.
fn resolve_env_ref(value: &str) -> Result<String> {
    let re = regex::Regex::new(r"\$\{([A-Z_][A-Z0-9_]*)\}")?;
    let mut out = String::new();
    let mut last = 0;
    for cap in re.captures_iter(value) {
        let (whole, name) = (cap.get(0).context("match")?, &cap[1]);
        let Ok(v) = std::env::var(name) else {
            anyhow::bail!("env var {name} not set (referenced in scrybe config)");
        };
        out.push_str(&value[last..whole.start()]);
        out.push_str(&v);
        last = whole.end();
    }
    out.push_str(&value[last..]);
    Ok(out)
}

/// `resolveEmbeddingConfig` plus `resolvePreset`.
pub fn resolve_embedding(source: &Source) -> Result<EmbedConfig> {
    let Some(cfg) = read_config()? else {
        anyhow::bail!("scrybe is not configured — run 'scrybe init'");
    };
    let Some(name) = cfg.assignments.get(slot(source)) else {
        anyhow::bail!("scrybe is not configured — run 'scrybe init'");
    };
    let Some(preset) = cfg.embedding_presets.get(name) else {
        anyhow::bail!("embedding preset \"{name}\" not found in config");
    };
    let (base_url, dimensions) = if preset.provider == "custom" {
        let Some(dim) = preset.dim else { anyhow::bail!("custom preset \"{name}\" is missing required field \"dim\"") };
        let Some(url) = preset.base_url.clone().filter(|u| !u.is_empty()) else { anyhow::bail!("custom preset \"{name}\" is missing required field \"base_url\"") };
        (url, dim)
    } else {
        catalog(&preset.provider, &preset.model)?
    };
    let raw = match &preset.credentials_from {
        Some(from) => {
            let Some(other) = cfg.embedding_presets.get(from) else {
                anyhow::bail!("preset \"{name}\" references credentials_from \"{from}\", but that preset does not exist");
            };
            if let Some(next) = &other.credentials_from {
                anyhow::bail!("preset \"{name}\" references credentials_from \"{from}\", which itself has credentials_from \"{next}\". credentials_from chains deeper than 1 level are not supported");
            }
            other.credentials.clone()
        }
        None => preset.credentials.clone(),
    };
    let credentials = raw.map(|r| resolve_env_ref(&r)).transpose()?.unwrap_or_default();
    let local = preset.provider == "local";
    if !local && credentials.is_empty() {
        anyhow::bail!("No API key found for model \"{}\".", preset.model);
    }
    let template = preset.prompt_template.clone().unwrap_or_default();
    Ok(EmbedConfig {
        local,
        base_url,
        model: preset.model.clone(),
        dimensions,
        credentials,
        encoding_float: preset.encoding_format.as_deref() == Some("float"),
        max_input_tokens: preset.max_input_tokens,
        query_prefix: template.query,
        passage_prefix: template.passage,
    })
}

/// `configuredEmbeddingStatus`, for a config.json setup.
pub fn embedding_status() -> Value {
    let failed = |message: String| serde_json::json!({ "config_present": true, "code_provider_type": "", "code_model": "", "text_provider_type": "", "text_model": "", "api_key_present": false, "config_error": true, "config_error_message": message, "credential_error_message": null });
    let cfg = match read_config() {
        Ok(Some(c)) => c,
        Ok(None) => return serde_json::json!({ "config_present": false, "code_provider_type": "", "code_model": "", "text_provider_type": "", "text_model": "", "api_key_present": false, "config_error": false, "config_error_message": null, "credential_error_message": null }),
        Err(e) => return failed(e.to_string()),
    };
    let provider_type = |p: &str| if p == "local" { "local" } else { "api" };
    let (Some(code), Some(text)) = (cfg.assignments.get("code_preset").and_then(|n| cfg.embedding_presets.get(n)), cfg.assignments.get("text_preset").and_then(|n| cfg.embedding_presets.get(n))) else {
        return failed("scrybe is not configured — run 'scrybe init'".to_string());
    };
    let mut key_present = code.provider == "local";
    let mut errors = vec![];
    for (slot, preset) in [("code_preset", code), ("text_preset", text)] {
        let raw = preset.credentials_from.as_ref().and_then(|f| cfg.embedding_presets.get(f)).map_or(&preset.credentials, |o| &o.credentials);
        match raw.as_deref().map(resolve_env_ref).transpose() {
            Ok(value) => {
                if slot == "code_preset" {
                    key_present = preset.provider == "local" || value.is_some_and(|v| !v.is_empty());
                }
            }
            Err(e) => errors.push(format!("{slot}: {e}")),
        }
    }
    serde_json::json!({
        "config_present": true,
        "code_provider_type": provider_type(&code.provider),
        "code_model": code.model,
        "text_provider_type": provider_type(&text.provider),
        "text_model": text.model,
        "api_key_present": key_present,
        "config_error": false,
        "config_error_message": null,
        "credential_error_message": if errors.is_empty() { None } else { Some(errors.join("; ")) },
    })
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The name `assignTableName` gives a source that has none.
pub fn table_name_for(project: &str, source: &Source, emb: &EmbedConfig) -> String {
    let prefix = if source.profile() == Some("text") { "knowledge" } else { "code" };
    let hash = sha256_hex(&format!("{project}:{}:{}:{}", source.source_id, emb.model, emb.dimensions));
    format!("{prefix}_{}", &hash[..12])
}

/// `updateSource`: patches the registry as JSON so fields this code doesn't know survive.
pub fn update_source(project: &str, source: &str, patch: &[(&str, Value)]) -> Result<()> {
    let path = data_dir().join("projects.json");
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    for p in doc.as_array_mut().context("projects.json is not a list")? {
        if p["id"] != project {
            continue;
        }
        for s in p["sources"].as_array_mut().into_iter().flatten() {
            if s["source_id"] == source {
                for (k, v) in patch {
                    s[*k] = v.clone();
                }
            }
        }
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
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
