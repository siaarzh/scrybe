//! The embedding preset tools. Mirrors `src/tools/model-mcp.ts`, `runPresetAdd` and `runAssign` in
//! `src/tools/model.ts`, `src/preset-resolver.ts`, the catalog in `src/providers.ts` and the config.json
//! reader and writer in `src/config.ts`. The file is edited as JSON so fields this code doesn't know survive.
use crate::config::data_dir;
use crate::registry;
use crate::store::db_path;
use anyhow::{bail, Result};
use serde_json::{json, Map, Value};

pub struct ModelSpec {
    pub dim: i32,
    pub profile: &'static str,
}

/// `PROVIDERS[*].embedding_models`: provider, model, dimensions, profile.
const MODELS: &[(&str, &str, i32, &str)] = &[
    ("voyage", "voyage-code-3", 1024, "code"),
    ("voyage", "voyage-3", 1024, "text"),
    ("voyage", "voyage-3-large", 1024, "text"),
    ("voyage", "voyage-3.5", 1024, "text"),
    ("voyage", "voyage-3.5-lite", 1024, "text"),
    ("voyage", "voyage-4", 1024, "text"),
    ("voyage", "voyage-4-lite", 1024, "text"),
    ("voyage", "voyage-4-large", 1024, "text"),
    ("openai", "text-embedding-3-small", 1536, "text"),
    ("openai", "text-embedding-3-large", 3072, "text"),
    ("local", "Xenova/multilingual-e5-small", 384, "text"),
    ("local", "Xenova/all-MiniLM-L6-v2", 384, "text"),
    ("local", "jinaai/jina-embeddings-v2-base-code", 768, "code"),
];

/// `getProvider` succeeds for these four.
fn provider_known(provider: &str) -> bool {
    matches!(provider, "voyage" | "openai" | "local" | "custom")
}

/// The catalog's embedding base URL; the local provider has none and the custom one takes it from the preset.
pub fn provider_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "voyage" => Some("https://api.voyageai.com/v1"),
        "openai" => Some("https://api.openai.com/v1"),
        "local" => Some(""),
        _ => None,
    }
}

pub fn model_spec(provider: &str, model: &str) -> Option<ModelSpec> {
    MODELS.iter().find(|(p, m, _, _)| *p == provider && *m == model).map(|(_, _, dim, profile)| ModelSpec { dim: *dim, profile })
}

// ─── config.json ─────────────────────────────────────────────────────────────

fn config_path() -> std::path::PathBuf {
    data_dir().join("config.json")
}

/// `validateScrybeConfig`: the first problem, in the same words.
fn validate(cfg: &Value) -> Option<String> {
    if cfg.is_array() {
        return Some("config.json: missing or non-numeric schema_version".into());
    }
    let Some(c) = cfg.as_object() else { return Some("config.json is not a JSON object".into()) };
    if !c.get("schema_version").is_some_and(Value::is_number) {
        return Some("config.json: missing or non-numeric schema_version".into());
    }
    let Some(presets) = c.get("embedding_presets").and_then(Value::as_object) else { return Some("config.json: missing embedding_presets".into()) };
    for (name, preset) in presets {
        let Some(p) = preset.as_object() else { return Some(format!("config.json: embedding_presets.{name} is not an object")) };
        if !p.get("provider").is_some_and(Value::is_string) {
            return Some(format!("config.json: embedding_presets.{name}.provider missing"));
        }
        if !p.get("model").is_some_and(Value::is_string) {
            return Some(format!("config.json: embedding_presets.{name}.model missing"));
        }
        if let Some(pt) = p.get("prompt_template") {
            let Some(pt) = pt.as_object() else { return Some(format!("config.json: embedding_presets.{name}.prompt_template must be an object")) };
            for field in ["query", "passage"] {
                if !pt.get(field).is_some_and(Value::is_string) {
                    return Some(format!("config.json: embedding_presets.{name}.prompt_template.{field} must be a string"));
                }
            }
        }
        if p.get("max_input_tokens").is_some_and(|v| !v.is_number()) {
            return Some(format!("config.json: embedding_presets.{name}.max_input_tokens must be a number"));
        }
        for field in ["credentials", "credentials_from"] {
            if p.get(field).is_some_and(|v| !v.is_string()) {
                return Some(format!("config.json: embedding_presets.{name}.{field} must be a string"));
            }
        }
        if let Some(f) = p.get("encoding_format") {
            if f != "float" {
                return Some(format!("config.json: embedding_presets.{name}.encoding_format must be \"float\"; omit it for the SDK base64 default"));
            }
            if p["provider"] != "custom" {
                return Some(format!("config.json: embedding_presets.{name}.encoding_format is only valid for a custom provider"));
            }
        }
    }
    let Some(a) = c.get("assignments").and_then(Value::as_object) else { return Some("config.json: missing assignments".into()) };
    for slot in ["code_preset", "text_preset"] {
        if !a.get(slot).is_some_and(Value::is_string) {
            return Some(format!("config.json: assignments.{slot} missing"));
        }
    }
    None
}

/// `readScrybeConfig`: `None` when there is no file, an error when it can't be read or doesn't validate.
fn read_scrybe_config() -> Result<Option<Value>> {
    let path = config_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| anyhow::anyhow!("Failed to read config.json: {e}"))?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("config.json is not valid JSON: {e}"))?;
    if let Some(problem) = validate(&parsed) {
        bail!(problem);
    }
    Ok(Some(parsed))
}

/// `writeScrybeConfig`: two-space JSON and a final newline, renamed into place.
fn write_scrybe_config(cfg: &Value) -> Result<()> {
    std::fs::create_dir_all(data_dir())?;
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg)? + "\n")?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ─── add_embedding_preset ────────────────────────────────────────────────────

/// A key counts as given when it is in the arguments at all, as `!== undefined` does.
fn given(a: &Value, key: &str) -> bool {
    a.get(key).is_some()
}

/// A string argument that is truthy in JavaScript.
fn text<'a>(a: &'a Value, key: &str) -> Option<&'a str> {
    a.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// What the first preset is added to when there is no config.json.
fn starter_config() -> Value {
    json!({ "schema_version": 1, "embedding_presets": {}, "assignments": { "code_preset": "", "text_preset": "" } })
}

fn add_inner(a: &Value) -> Result<()> {
    let name = a["name"].as_str().unwrap_or("");
    let provider = a["provider"].as_str().unwrap_or("");
    let model = a["model"].as_str().unwrap_or("");
    let custom = provider == "custom";
    if !custom {
        if !provider_known(provider) {
            bail!("Unknown provider: \"{provider}\". Run 'scrybe model list' to see available providers.");
        }
        if given(a, "base_url") {
            bail!("--base-url is only valid for custom providers. Catalog providers derive base_url from the catalog.");
        }
        if given(a, "dim") {
            bail!("--dim is only valid for custom providers. Catalog providers derive dim from the model spec.");
        }
        if given(a, "encoding_format") {
            bail!("--encoding-format is only valid for custom providers.");
        }
        if model_spec(provider, model).is_none() {
            bail!("Model \"{model}\" not found in provider \"{provider}\". Run 'scrybe model list' to see available models.");
        }
    } else {
        if text(a, "base_url").is_none() {
            bail!("--base-url is required for custom providers.");
        }
        if !given(a, "dim") {
            bail!("--dim is required for custom providers.");
        }
        if given(a, "encoding_format") && a["encoding_format"] != "float" {
            bail!("--encoding-format must be \"float\"; omit it for the OpenAI-compatible default.");
        }
    }

    let _guard = registry::write_lock();
    let mut cfg = read_scrybe_config()?.unwrap_or_else(starter_config);
    if cfg["embedding_presets"].as_object().is_some_and(|p| p.contains_key(name)) {
        bail!("Preset '{name}' already exists. Edit its config.json entry, or add a new preset and assign it.");
    }
    let mut preset = Map::new();
    preset.insert("provider".into(), json!(provider));
    preset.insert("model".into(), json!(model));
    if let Some(c) = text(a, "credentials") {
        preset.insert("credentials".into(), json!(c));
    }
    if let Some(c) = text(a, "credentials_from") {
        preset.insert("credentials_from".into(), json!(c));
    }
    if custom {
        preset.insert("base_url".into(), a["base_url"].clone());
        preset.insert("dim".into(), a["dim"].clone());
        if a["encoding_format"] == "float" {
            preset.insert("encoding_format".into(), json!("float"));
        }
    }
    if let Some(presets) = cfg["embedding_presets"].as_object_mut() {
        presets.insert(name.to_string(), Value::Object(preset));
    }
    write_scrybe_config(&cfg)
}

pub fn add_embedding_preset(a: &Value) -> Value {
    let name = a["name"].as_str().unwrap_or("");
    match add_inner(a) {
        Ok(()) => json!({ "ok": true, "preset_name": name }),
        Err(e) => json!({ "ok": false, "preset_name": name, "error": e.to_string() }),
    }
}

// ─── assign_preset ───────────────────────────────────────────────────────────

/// Names a JavaScript object answers to before anything is stored in it, which `in` finds.
fn inherited(name: &str) -> bool {
    matches!(name, "constructor" | "toString" | "valueOf" | "hasOwnProperty" | "isPrototypeOf" | "propertyIsEnumerable" | "toLocaleString" | "__proto__" | "__defineGetter__" | "__defineSetter__" | "__lookupGetter__" | "__lookupSetter__")
}

/// `name in table`.
fn has(table: Option<&Map<String, Value>>, name: &str) -> bool {
    table.is_some_and(|t| t.contains_key(name)) || inherited(name)
}

/// What `credentials` turns into: every `${VAR}` must be set, and a daemon says how to fix it.
fn check_env_refs(value: &str) -> Result<()> {
    let re = regex::Regex::new(r"\$\{([A-Z_][A-Z0-9_]*)\}")?;
    for cap in re.captures_iter(value) {
        let name = &cap[1];
        if std::env::var_os(name).is_none() {
            let passthrough = if cfg!(target_os = "linux") { ". Names starting with SCRYBE_, and names listed in SCRYBE_DAEMON_ENV_PASSTHROUGH, reach the daemon even before config references them" } else { "" };
            bail!("env var {name} not set (referenced in scrybe config). The daemon only has the environment it was started with: run `scrybe daemon stop` and the next scrybe call starts one that has {name}, as long as that call's environment (or <DATA_DIR>/.env) has it{passthrough}");
        }
    }
    Ok(())
}

#[derive(Debug)]
struct Resolved {
    provider: String,
    model: String,
    dim: Value,
}

/// `resolvePreset` for an embedding slot, credentials included.
fn resolve_preset(name: &str, slot: &str, cfg: &Value) -> Result<Resolved> {
    let presets = cfg["embedding_presets"].as_object();
    let Some(preset) = presets.and_then(|p| p.get(name)) else {
        if inherited(name) {
            bail!("unknown provider: \"undefined\"");
        }
        bail!("embedding preset \"{name}\" not found in config");
    };
    let provider = preset["provider"].as_str().unwrap_or("");
    let model = preset["model"].as_str().unwrap_or("");
    let dim = if provider == "custom" {
        let Some(dim) = preset.get("dim") else { bail!("custom preset \"{name}\" is missing required field \"dim\"") };
        if text(preset, "base_url").is_none() {
            bail!("custom preset \"{name}\" is missing required field \"base_url\"");
        }
        dim.clone()
    } else {
        if !provider_known(provider) {
            bail!("unknown provider: \"{provider}\"");
        }
        let Some(spec) = model_spec(provider, model) else { bail!("model \"{model}\" not found in provider \"{provider}\"") };
        let required = if slot == "code_preset" { "code" } else { "text" };
        if spec.profile != required && provider != "local" {
            bail!("preset \"{name}\" uses model \"{model}\" with profile \"{}\", but it is assigned to slot \"{slot}\" which requires profile \"{required}\"", spec.profile);
        }
        json!(spec.dim)
    };
    if let Some(from) = text(preset, "credentials_from") {
        let Some(source) = presets.and_then(|p| p.get(from)) else {
            bail!("preset \"{name}\" references credentials_from \"{from}\", but that preset does not exist");
        };
        if let Some(next) = text(source, "credentials_from") {
            bail!("preset \"{name}\" references credentials_from \"{from}\", which itself has credentials_from \"{next}\". credentials_from chains deeper than 1 level are not supported");
        }
        if let Some(c) = text(source, "credentials") {
            check_env_refs(c)?;
        }
    } else if let Some(c) = text(preset, "credentials") {
        check_env_refs(c)?;
    }
    Ok(Resolved { provider: provider.to_string(), model: model.to_string(), dim })
}

/// The `(model, dim, provider)` an embedding is stamped with.
struct Triple {
    model: String,
    dim: Value,
    provider: String,
}

fn same_dim(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

fn triples_equal(a: &Option<Triple>, b: &Option<Triple>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.model == b.model && a.provider == b.provider && same_dim(&a.dim, &b.dim),
        _ => false,
    }
}

/// A preset's triple as the tool works it out: custom ones from their own fields, catalog ones by resolving.
fn triple_of(name: &str, slot: &str, cfg: &Value) -> Option<Triple> {
    let preset = cfg["embedding_presets"].as_object()?.get(name)?;
    if preset["provider"] != "custom" {
        return resolve_preset(name, slot, cfg).ok().map(|r| Triple { model: r.model, dim: r.dim, provider: r.provider });
    }
    let dim = preset.get("dim")?;
    text(preset, "base_url")?;
    Some(Triple { model: preset["model"].as_str()?.to_string(), dim: dim.clone(), provider: "custom".into() })
}

/// `getTripleFromStamp`.
fn triple_from_stamp(stamp: &Value) -> Option<Triple> {
    let model = stamp.get("model").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let provider = stamp.get("provider").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    Some(Triple { model: model.to_string(), dim: stamp.get("dim")?.clone(), provider: provider.to_string() })
}

/// True when an indexed source of this slot's profile carries a stamp that disagrees with the new triple.
fn stamp_disagrees(slot: &str, new: &Option<Triple>) -> bool {
    for project in registry::list_projects() {
        for source in &project.sources {
            let profile = if source.kind() == "code" { "code" } else { "text" };
            if (slot == "code" && profile != "code") || (slot == "text" && profile != "text") {
                continue;
            }
            let Some(table) = &source.table_name else { continue };
            let Some(stamp) = std::fs::read_to_string(db_path().join(format!("{table}-meta.json"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
            if let Some(stamped) = triple_from_stamp(&stamp) {
                if !triples_equal(&Some(stamped), new) {
                    return true;
                }
            }
        }
    }
    false
}

fn assign_inner(a: &Value) -> Result<Value> {
    let slot = a["slot"].as_str().unwrap_or("");
    let name = a["preset_name"].as_str().unwrap_or("");
    let _guard = registry::write_lock();
    let Some(mut cfg) = read_scrybe_config()? else { bail!("No config.json found. Run 'scrybe model preset add' first.") };
    let key = match slot {
        "code" => "code_preset",
        "text" => "text_preset",
        _ => "rerank_preset",
    };
    let mut requires_reindex = false;
    if slot == "rerank" {
        if name != "none" && !has(cfg["reranker_presets"].as_object(), name) {
            bail!("Reranker preset '{name}' not found in reranker_presets.");
        }
    } else {
        if !has(cfg["embedding_presets"].as_object(), name) {
            bail!("Preset '{name}' not found in embedding_presets.");
        }
        resolve_preset(name, key, &cfg)?;
        let current = cfg["assignments"][key].as_str().filter(|s| !s.is_empty()).and_then(|n| triple_of(n, key, &cfg));
        let new = triple_of(name, key, &cfg);
        if current.is_some() && !triples_equal(&current, &new) {
            requires_reindex = true;
        }
        if !requires_reindex {
            requires_reindex = stamp_disagrees(slot, &new);
        }
    }
    let assignments = cfg["assignments"].as_object_mut().ok_or_else(|| anyhow::anyhow!("config.json: missing assignments"))?;
    if slot == "rerank" && name == "none" {
        *assignments = std::mem::take(assignments).into_iter().filter(|(k, _)| k != "rerank_preset").collect();
    } else {
        assignments.insert(key.to_string(), json!(name));
    }
    write_scrybe_config(&cfg)?;
    Ok(json!({ "ok": true, "requires_reindex": requires_reindex }))
}

pub fn assign_preset(a: &Value) -> Value {
    assign_inner(a).unwrap_or_else(|e| json!({ "ok": false, "requires_reindex": false, "error": e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Value {
        json!({
            "schema_version": 1,
            "embedding_presets": {
                "fake": { "provider": "custom", "model": "m", "dim": 8, "base_url": "http://x/v1" },
                "code-local": { "provider": "local", "model": "jinaai/jina-embeddings-v2-base-code" },
                "text-api": { "provider": "voyage", "model": "voyage-4", "credentials": "${SCRYBE_TEST_PRESET_KEY}" },
                "borrow": { "provider": "voyage", "model": "voyage-code-3", "credentials_from": "text-api" }
            },
            "assignments": { "code_preset": "fake", "text_preset": "fake" }
        })
    }

    #[test]
    fn a_catalog_model_belongs_to_one_profile_and_local_fits_both_slots() {
        assert!(resolve_preset("code-local", "code_preset", &cfg()).is_ok());
        assert!(resolve_preset("code-local", "text_preset", &cfg()).is_ok());
        let e = resolve_preset("text-api", "code_preset", &cfg()).unwrap_err().to_string();
        assert_eq!(e, "preset \"text-api\" uses model \"voyage-4\" with profile \"text\", but it is assigned to slot \"code_preset\" which requires profile \"code\"");
    }

    #[test]
    fn credentials_must_resolve_and_may_be_borrowed_one_level() {
        std::env::remove_var("SCRYBE_TEST_PRESET_KEY");
        let e = resolve_preset("text-api", "text_preset", &cfg()).unwrap_err().to_string();
        assert!(e.starts_with("env var SCRYBE_TEST_PRESET_KEY not set (referenced in scrybe config). The daemon only has"), "{e}");
        assert!(resolve_preset("borrow", "code_preset", &cfg()).is_err());
        std::env::set_var("SCRYBE_TEST_PRESET_KEY", "k");
        assert!(resolve_preset("text-api", "text_preset", &cfg()).is_ok());
        assert!(resolve_preset("borrow", "code_preset", &cfg()).is_ok());
        let mut chained = cfg();
        chained["embedding_presets"]["text-api"]["credentials_from"] = json!("fake");
        let e = resolve_preset("borrow", "code_preset", &chained).unwrap_err().to_string();
        assert!(e.contains("chains deeper than 1 level are not supported"), "{e}");
        std::env::remove_var("SCRYBE_TEST_PRESET_KEY");
    }

    #[test]
    fn a_custom_preset_needs_its_own_dimensions_and_url() {
        let mut c = cfg();
        c["embedding_presets"]["fake"].as_object_mut().unwrap().remove("dim");
        assert_eq!(resolve_preset("fake", "code_preset", &c).unwrap_err().to_string(), "custom preset \"fake\" is missing required field \"dim\"");
        let mut c = cfg();
        c["embedding_presets"]["fake"]["base_url"] = json!("");
        assert_eq!(resolve_preset("fake", "code_preset", &c).unwrap_err().to_string(), "custom preset \"fake\" is missing required field \"base_url\"");
    }

    #[test]
    fn triples_compare_model_dimensions_and_provider_only() {
        let c = cfg();
        let fake = triple_of("fake", "code_preset", &c);
        assert!(triples_equal(&fake, &triple_of("fake", "text_preset", &c)));
        assert!(!triples_equal(&fake, &triple_of("code-local", "code_preset", &c)));
        assert!(!triples_equal(&fake, &None));
        let stamp = json!({ "model": "m", "dim": 8.0, "provider": "custom", "indexed_at": "x" });
        assert!(triples_equal(&triple_from_stamp(&stamp), &fake));
        assert!(triple_from_stamp(&json!({ "model": "m", "provider": "custom" })).is_none());
        assert!(triple_from_stamp(&json!({ "model": "", "dim": 8, "provider": "custom" })).is_none());
    }

    #[test]
    fn a_config_is_checked_in_the_same_words() {
        assert_eq!(validate(&cfg()), None);
        assert_eq!(validate(&json!([])).as_deref(), Some("config.json: missing or non-numeric schema_version"));
        let mut c = cfg();
        c["embedding_presets"]["fake"]["encoding_format"] = json!("float");
        assert_eq!(validate(&c), None);
        c["embedding_presets"]["code-local"]["encoding_format"] = json!("float");
        assert_eq!(validate(&c).as_deref(), Some("config.json: embedding_presets.code-local.encoding_format is only valid for a custom provider"));
        let mut c = cfg();
        c["assignments"].as_object_mut().unwrap().remove("text_preset");
        assert_eq!(validate(&c).as_deref(), Some("config.json: assignments.text_preset missing"));
    }

    #[test]
    fn names_an_object_already_answers_to_count_as_present_for_assignment() {
        assert!(has(None, "constructor"));
        assert!(has(Some(&Map::new()), "__proto__"));
        assert!(!has(Some(&Map::new()), "fake"));
        assert!(has(cfg()["embedding_presets"].as_object(), "fake"));
        assert_eq!(resolve_preset("toString", "code_preset", &cfg()).unwrap_err().to_string(), "unknown provider: \"undefined\"");
    }

    #[test]
    fn the_starter_config_reads_back_as_valid_and_is_written_in_javascript_order() {
        assert_eq!(validate(&starter_config()), None);
        let text = serde_json::to_string_pretty(&starter_config()).unwrap();
        assert_eq!(text, "{\n  \"schema_version\": 1,\n  \"embedding_presets\": {},\n  \"assignments\": {\n    \"code_preset\": \"\",\n    \"text_preset\": \"\"\n  }\n}");
    }

    #[test]
    fn the_file_keeps_its_key_order_and_unknown_fields() {
        let text = r#"{"zeta":1,"schema_version":1,"embedding_presets":{},"assignments":{"text_preset":"","code_preset":"","rerank_preset":"r"}}"#;
        let mut v: Value = serde_json::from_str(text).unwrap();
        let kept: Map<String, Value> = std::mem::take(v["assignments"].as_object_mut().unwrap()).into_iter().filter(|(k, _)| k != "rerank_preset").collect();
        v["assignments"] = Value::Object(kept);
        let out = serde_json::to_string(&v).unwrap();
        assert_eq!(out, r#"{"zeta":1,"schema_version":1,"embedding_presets":{},"assignments":{"text_preset":"","code_preset":""}}"#);
    }
}
