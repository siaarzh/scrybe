//! `projects.json` and `config.json`. Mirrors `src/registry.ts` and the preset lookups it needs.
use crate::config::data_dir;
use crate::presets;
use anyhow::{Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Source {
    pub source_id: String,
    pub source_config: Value,
    pub table_name: Option<String>,
    pub last_indexed: Option<String>,
    pub pinned_branches: Option<Vec<String>>,
}

impl Source {
    /// `None` without a usable id. Any other field of the wrong type counts as absent.
    fn from_json(v: &Value) -> Option<Self> {
        let text = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(String::from);
        Some(Source {
            source_id: v["source_id"].as_str()?.to_string(),
            source_config: v["source_config"].clone(),
            table_name: text("table_name"),
            last_indexed: text("last_indexed"),
            pinned_branches: v["pinned_branches"].as_array().map(|b| b.iter().filter_map(|b| b.as_str().map(String::from)).collect()),
        })
    }

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

#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub description: Option<String>,
    pub sources: Vec<Source>,
}

impl Project {
    fn from_json(v: &Value) -> Option<Self> {
        let sources = v["sources"].as_array().into_iter().flatten().filter_map(Source::from_json).collect();
        Some(Project { id: v["id"].as_str()?.to_string(), description: v["description"].as_str().map(String::from), sources })
    }
}

fn projects_path() -> PathBuf {
    data_dir().join("projects.json")
}

/// The file as it stands: no file is an empty list, one that doesn't parse is `None`, anything but a list is an error.
fn parse_list(text: Option<&[u8]>) -> Result<Option<Vec<Value>>> {
    let Some(bytes) = text else { return Ok(None) };
    match serde_json::from_str(&String::from_utf8_lossy(bytes)) {
        Ok(Value::Array(list)) => Ok(Some(list)),
        Ok(_) => anyhow::bail!("projects.json is not a list"),
        Err(_) => Ok(None),
    }
}

fn read_list() -> Result<Option<Vec<Value>>> {
    let path = projects_path();
    if !path.exists() {
        return Ok(Some(vec![]));
    }
    parse_list(std::fs::read(path).ok().as_deref())
}

/// The old flat shape becomes one source named `primary`. Returns the ids it changed.
fn migrate(list: &mut [Value]) -> Vec<String> {
    let mut changed = vec![];
    for p in list.iter_mut().filter_map(Value::as_object_mut) {
        if p.get("sources").is_some_and(Value::is_array) {
            continue;
        }
        let given = |k: &str| p.get(k).filter(|v| !v.is_null()).cloned();
        let config = given("source_config").unwrap_or_else(|| serde_json::json!({ "type": "code", "root_path": given("root_path").unwrap_or_else(|| "".into()), "languages": given("languages").unwrap_or_else(|| Value::Array(vec![])) }));
        let mut source = serde_json::json!({ "source_id": "primary", "source_config": config });
        if let Some(at) = p.get("last_indexed") {
            source["last_indexed"] = at.clone();
        }
        p.insert("sources".into(), Value::Array(vec![source]));
        for k in ["root_path", "languages", "source_config", "last_indexed"] {
            p.shift_remove(k);
        }
        changed.push(p.get("id").and_then(Value::as_str).unwrap_or("undefined").to_string());
    }
    changed
}

/// `load` for a reader: `None` when the file can't be read as a list. A flat project is saved in its new shape.
fn load() -> Option<Vec<Value>> {
    let mut list = read_list().ok()??;
    if !migrate(&mut list).is_empty() && crate::index::refuse_live_data_dir().is_ok() {
        // A writer holding the lock saves the new shape itself.
        if let Ok(_guard) = WRITE.try_lock() {
            if let Err(e) = load_list() {
                eprintln!("[scrybe] could not save the migrated projects.json: {e:#}");
            }
        }
    }
    Some(list)
}

fn load_projects() -> Option<Vec<Project>> {
    Some(load()?.iter().filter_map(Project::from_json).collect())
}

pub fn list_projects() -> Vec<Project> {
    load_projects().unwrap_or_default()
}

/// The registry as read now: `None` when there is no file, an error when it can't be read or parsed.
pub fn read_projects() -> Result<Option<Vec<Project>>> {
    if !projects_path().exists() {
        return Ok(None);
    }
    load_projects().context("projects.json can't be read as a list").map(Some)
}

/// Project ids, or `None` when projects.json exists and can't be read as a list.
pub fn project_ids_if_readable() -> Option<Vec<String>> {
    Some(load()?.iter().filter_map(|p| p["id"].as_str().map(String::from)).collect())
}

pub fn get_project(id: &str) -> Option<Project> {
    list_projects().into_iter().find(|p| p.id == id)
}

/// A project as it is stored, fields this code doesn't know included.
pub fn raw_project(id: &str) -> Option<Value> {
    load()?.into_iter().find(|p| p["id"] == id)
}

/// The preset name assigned to a slot, if one is.
pub fn assigned<'a>(cfg: &'a Value, slot: &str) -> Option<&'a str> {
    cfg["assignments"][slot].as_str().filter(|n| !n.is_empty())
}

pub fn slot(source: &Source) -> &'static str {
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
    /// The variable that may hold the key instead of the preset.
    pub key_env: String,
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

/// `${VAR}` in a config value.
pub const ENV_REF: &str = r"\$\{([A-Z_][A-Z0-9_]*)\}";

/// What a `${VAR}` with no value says.
pub fn unset_env_error(name: &str) -> anyhow::Error {
    anyhow::Error::new(CallerFacing(format!("env var {name} not set (referenced in scrybe config){}", env_ref_remedy(name, false, crate::config::in_server()))))
}

/// `resolveEnvRef`: every `${VAR}` must be set.
pub fn resolve_env_ref(value: &str) -> Result<String> {
    let re = regex::Regex::new(ENV_REF)?;
    let mut out = String::new();
    let mut last = 0;
    for cap in re.captures_iter(value) {
        let (whole, name) = (cap.get(0).context("match")?, &cap[1]);
        let Ok(v) = std::env::var(name) else {
            return Err(unset_env_error(name));
        };
        out.push_str(&value[last..whole.start()]);
        out.push_str(&v);
        last = whole.end();
    }
    out.push_str(&value[last..]);
    Ok(out)
}

/// `daemonEnvRefRemedy`, empty outside the server. `unsaved`: the token is checked before it is saved.
pub fn env_ref_remedy(name: &str, unsaved: bool, in_daemon: bool) -> String {
    if !in_daemon {
        return String::new();
    }
    if unsaved && cfg!(target_os = "linux") {
        return format!(". The daemon only receives variables your saved config already references, so restarting it alone won't help here: name the variable SCRYBE_<something>, list {name} in SCRYBE_DAEMON_ENV_PASSTHROUGH, or put it in <DATA_DIR>/.env, then run `scrybe daemon stop`; or run `scrybe daemon stop`, then add the source with `scrybe source add` from a terminal that has {name} set");
    }
    let passthrough = if cfg!(target_os = "linux") { ". Names starting with SCRYBE_, and names listed in SCRYBE_DAEMON_ENV_PASSTHROUGH, reach the daemon even before config references them" } else { "" };
    format!(". The daemon only has the environment it was started with: run `scrybe daemon stop` and the next scrybe call starts one that has {name}, as long as that call's environment (or <DATA_DIR>/.env) has it{passthrough}")
}

/// An error whose text is meant for the caller, like `markCallerFacing`.
#[derive(Debug)]
pub struct CallerFacing(pub String);

impl std::fmt::Display for CallerFacing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CallerFacing {}

/// What the token check says when the token is a `${VAR}` that isn't set.
pub fn unset_token_error(label: &str, project_id: &str, token: &str, in_daemon: bool) -> anyhow::Error {
    let found = regex::Regex::new(ENV_REF).ok().and_then(|re| re.captures(token).map(|c| c[1].to_string()));
    let name = found.clone().unwrap_or_else(|| token.to_string());
    let remedy = if found.is_some() { env_ref_remedy(&name, true, in_daemon) } else { String::new() };
    anyhow::Error::new(CallerFacing(format!("Token for {label} source \"{project_id}\" references env var {name} which is not set. Set it in your environment or in <DATA_DIR>/.env: {name}=<your-token>{remedy}")))
}

/// The variable `_injectCredential` uses for a preset.
fn key_env(preset: &str) -> String {
    let plain = |c: char| if c.is_ascii_uppercase() || c.is_ascii_digit() { c.to_string() } else { "_".repeat(c.len_utf16()) };
    format!("SCRYBE_PRESET_{}", preset.to_uppercase().chars().map(plain).collect::<String>())
}

/// `resolveEmbeddingConfig` plus `resolvePreset`.
pub fn resolve_embedding(source: &Source) -> Result<EmbedConfig> {
    let Some(cfg) = presets::read_scrybe_config()? else {
        anyhow::bail!("scrybe is not configured — run 'scrybe init'");
    };
    let Some(name) = assigned(&cfg, slot(source)) else {
        anyhow::bail!("scrybe is not configured — run 'scrybe init'");
    };
    let resolved = presets::resolve_preset(name, slot(source), &cfg, true)?;
    let preset = &cfg["embedding_presets"][name];
    let local = resolved.provider == "local";
    let Some(dimensions) = resolved.dim.as_f64() else { anyhow::bail!("preset \"{name}\" has a \"dim\" that isn't a number") };
    let key_env = key_env(name);
    let template = |k: &str| preset["prompt_template"][k].as_str().unwrap_or("").to_string();
    Ok(EmbedConfig {
        local,
        base_url: resolved.base_url,
        model: resolved.model,
        dimensions: dimensions as i32,
        credentials: std::env::var(&key_env).unwrap_or(resolved.credentials),
        key_env,
        encoding_float: preset["encoding_format"] == "float",
        max_input_tokens: preset["max_input_tokens"].as_f64().map(|n| n as usize),
        query_prefix: template("query"),
        passage_prefix: template("passage"),
    })
}

/// `configuredEmbeddingStatus`, for a config.json setup.
pub fn embedding_status() -> Value {
    let failed = |message: String| serde_json::json!({ "config_present": true, "code_provider_type": "", "code_model": "", "text_provider_type": "", "text_model": "", "api_key_present": false, "config_error": true, "config_error_message": message, "credential_error_message": null });
    let cfg = match presets::read_scrybe_config() {
        Ok(Some(c)) => c,
        Ok(None) => return serde_json::json!({ "config_present": false, "code_provider_type": "", "code_model": "", "text_provider_type": "", "text_model": "", "api_key_present": false, "config_error": false, "config_error_message": null, "credential_error_message": null }),
        Err(e) => return failed(e.to_string()),
    };
    let resolve = |slot: &str, credentials: bool| presets::resolve_preset(cfg["assignments"][slot].as_str().unwrap_or(""), slot, &cfg, credentials);
    let (code, text) = match (resolve("code_preset", false), resolve("text_preset", false)) {
        (Ok(code), Ok(text)) => (code, text),
        (Err(e), _) | (_, Err(e)) => return failed(e.to_string()),
    };
    let provider_type = |p: &str| if p == "local" { "local" } else { "api" };
    let mut key_present = code.provider == "local";
    let mut errors = vec![];
    for slot in ["code_preset", "text_preset"] {
        match resolve(slot, true) {
            Ok(r) if slot == "code_preset" => key_present = r.provider == "local" || !r.credentials.is_empty(),
            Ok(_) => {}
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

/// `assignTableName`: the source's table, named and saved if it had none.
pub fn assign_table(project: &str, source: &Source, emb: &EmbedConfig) -> Result<String> {
    if let Some(t) = &source.table_name {
        return Ok(t.clone());
    }
    let name = table_name_for(project, source, emb);
    update_source(project, &source.source_id, &[("table_name", serde_json::json!(name))])?;
    Ok(name)
}

/// `assignTableName` for a reader: `None` when the source has no table and none of its name is on disk either.
pub fn table_to_read(project: &str, source: &Source, emb: &EmbedConfig) -> Result<Option<String>> {
    if source.table_name.is_none() {
        let on_disk = crate::store::db_path().join(format!("{}.lance", table_name_for(project, source, emb))).exists();
        if !on_disk || crate::index::refuse_live_data_dir().is_err() {
            return Ok(None);
        }
    }
    assign_table(project, source, emb).map(Some)
}

// One writer at a time, so two calls can't each read the old list and drop the other's change.
static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE.lock().unwrap_or_else(|e| e.into_inner())
}

/// `load` for a caller that holds the write lock: no file or one that doesn't parse is an empty list, and a flat
/// project is saved in its new shape first. Entries stay JSON so fields this code doesn't know survive.
fn load_list() -> Result<Vec<Value>> {
    let mut list = read_list()?.unwrap_or_default();
    let changed = migrate(&mut list);
    for id in &changed {
        eprintln!("[scrybe] Migrated project '{id}' to multi-source model (source_id: \"primary\"). Run a full reindex to rebuild its vector table.");
    }
    if !changed.is_empty() {
        save_list(&list)?;
    }
    Ok(list)
}

/// `save`: writes beside the file, then renames over it.
fn save_list(list: &[Value]) -> Result<()> {
    let path = projects_path();
    std::fs::create_dir_all(data_dir())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(list)?).with_context(|| format!("could not write '{}'", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("could not replace '{}'", path.display()))
}

fn entry<'a>(list: &'a mut [Value], project: &str) -> Result<&'a mut Value> {
    list.iter_mut().find(|p| p["id"] == project).with_context(|| format!("Project '{project}' not found"))
}

/// `addSource`.
pub fn add_source(project: &str, source: Value) -> Result<()> {
    let _guard = write_lock();
    let mut list = load_list()?;
    let p = entry(&mut list, project)?;
    let sources = p["sources"].as_array_mut().context("sources is not a list")?;
    if sources.iter().any(|s| s["source_id"] == source["source_id"]) {
        anyhow::bail!("Source '{}' already exists in project '{project}'", source["source_id"].as_str().unwrap_or(""));
    }
    sources.push(source);
    save_list(&list)
}

/// `updateSource`.
pub fn update_source(project: &str, source: &str, patch: &[(&str, Value)]) -> Result<()> {
    let _guard = write_lock();
    let mut list = load_list()?;
    let found = entry(&mut list, project)?["sources"].as_array_mut().and_then(|s| s.iter_mut().find(|s| s["source_id"] == source));
    let s = found.with_context(|| format!("Source '{source}' not found in project '{project}'"))?;
    for (k, v) in patch {
        s[*k] = v.clone();
    }
    save_list(&list)
}

/// `addProject`.
pub fn add_project(id: &str, description: &str) -> Result<()> {
    let _guard = write_lock();
    let mut list = load_list()?;
    if list.iter().any(|p| p["id"] == id) {
        anyhow::bail!("Project '{id}' already exists");
    }
    list.push(serde_json::json!({ "id": id, "description": description, "sources": [] }));
    save_list(&list)
}

/// `updateProject`: sets the description when one is given and returns the whole project.
pub fn update_project(id: &str, description: Option<Value>) -> Result<Value> {
    let _guard = write_lock();
    let mut list = load_list()?;
    let p = entry(&mut list, id)?;
    if let Some(d) = description {
        p["description"] = d;
    }
    let out = p.clone();
    save_list(&list)?;
    Ok(out)
}

/// The last step of `removeProject`: the entry leaves the file.
pub fn remove_project_entry(id: &str) -> Result<()> {
    let _guard = write_lock();
    let mut list = load_list()?;
    list.retain(|p| p["id"] != id);
    save_list(&list)
}

/// The last step of `removeSource`: the source leaves its project's list.
pub fn remove_source_entry(project: &str, source: &str) -> Result<()> {
    let _guard = write_lock();
    let mut list = load_list()?;
    if let Some(sources) = entry(&mut list, project)?["sources"].as_array_mut() {
        sources.retain(|s| s["source_id"] != source);
    }
    save_list(&list)
}

/// Mirrors `isSearchable`.
pub fn is_searchable(source: &Source) -> (bool, Option<String>) {
    if source.table_name.is_none() {
        return (false, Some("Never indexed — run a full index first".into()));
    }
    let cfg = match presets::read_scrybe_config() {
        Ok(Some(c)) => c,
        Ok(None) => return (true, None),
        Err(e) => return (false, Some(e.to_string())),
    };
    let Some(name) = assigned(&cfg, slot(source)) else {
        return (false, Some("scrybe is not configured — run 'scrybe init'".into()));
    };
    let Some(preset) = cfg["embedding_presets"].get(name) else {
        return (false, Some(format!("Preset \"{name}\" not found in config — run 'scrybe init'")));
    };
    if preset["provider"] == "local" {
        return (true, None);
    }
    let raw = match preset["credentials_from"].as_str().filter(|f| !f.is_empty()) {
        Some(from) => cfg["embedding_presets"][from]["credentials"].as_str(),
        None => preset["credentials"].as_str(),
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
        return (false, Some(format!("Requires env var {var} (model: {}) — not set in current environment{}", preset["model"].as_str().unwrap_or(""), env_ref_remedy(var, false, crate::config::in_server()))));
    }
    (true, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_flat_project_becomes_one_primary_source_in_place() {
        let mut list = vec![
            json!({ "id": "flat", "description": "d", "root_path": "/r", "languages": ["ts"], "last_indexed": "t", "kept": 1 }),
            json!({ "id": "bare" }),
            json!({ "sources": null, "id": "own", "source_config": { "type": "ticket" }, "root_path": "/x", "last_indexed": null }),
            json!({ "id": "new", "sources": [] }),
            json!("noise"),
            Value::Null,
        ];
        assert_eq!(migrate(&mut list), ["flat", "bare", "own"]);
        let text = |v: &Value| v.to_string();
        assert_eq!(text(&list[0]), r#"{"id":"flat","description":"d","kept":1,"sources":[{"source_id":"primary","source_config":{"type":"code","root_path":"/r","languages":["ts"]},"last_indexed":"t"}]}"#);
        assert_eq!(text(&list[1]), r#"{"id":"bare","sources":[{"source_id":"primary","source_config":{"type":"code","root_path":"","languages":[]}}]}"#);
        assert_eq!(text(&list[2]), r#"{"sources":[{"source_id":"primary","source_config":{"type":"ticket"},"last_indexed":null}],"id":"own"}"#);
        assert_eq!(migrate(&mut list), [""; 0], "a second look finds nothing to do");
    }

    #[test]
    fn a_preset_names_its_key_variable() {
        assert_eq!(["fake", "my-model.2", "é😀"].map(key_env), ["SCRYBE_PRESET_FAKE", "SCRYBE_PRESET_MY_MODEL_2", "SCRYBE_PRESET____"]);
    }

    #[test]
    fn one_bad_entry_or_source_hides_nothing_else() {
        let list = json!([null, 5, "x", [], {}, { "id": 7, "sources": [] }, {
            "id": "good", "description": 3, "sources": [
                null, "x", {}, { "source_id": 9 },
                { "source_id": "odd", "source_config": "text", "table_name": 4, "last_indexed": {}, "pinned_branches": "main" },
                { "source_id": "mixed", "source_config": { "type": "code" }, "table_name": "t", "pinned_branches": ["a", 1, "b"] },
            ],
        }]);
        let found: Vec<Project> = list.as_array().unwrap().iter().filter_map(Project::from_json).collect();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].id.as_str(), &found[0].description), ("good", &None));
        let [odd, mixed] = &found[0].sources[..] else { panic!("{:?}", found[0].sources) };
        assert_eq!((odd.kind(), &odd.table_name, &odd.last_indexed, &odd.pinned_branches), ("unknown", &None, &None, &None));
        assert_eq!((mixed.kind(), mixed.table_name.as_deref(), mixed.pinned_branches.as_deref()), ("code", Some("t"), Some(&["a".to_string(), "b".to_string()][..])));
    }

    #[test]
    fn a_file_that_parses_to_anything_but_a_list_is_not_taken_for_an_empty_one() {
        assert_eq!(parse_list(Some(b"[]")).unwrap(), Some(vec![]));
        assert_eq!(parse_list(Some(b"[1,")).unwrap(), None);
        assert_eq!(parse_list(None).unwrap(), None);
        for text in ["{}", "null", "\"x\"", "5"] {
            assert!(parse_list(Some(text.as_bytes())).is_err(), "{text}");
        }
    }
}
