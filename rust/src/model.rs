//! The `model` command. Mirrors `src/tools/model.ts`.
use crate::cli::{finish, need};
use crate::index::{self, Mode, Options, Progress, ProgressSink};
use crate::jsstr::parse_int;
use crate::ops::confirm;
use crate::presets::{self, text};
use crate::registry::{self, Source};
use crate::status::grouped;
use crate::store::{db_path, Store};
use anyhow::{bail, Result};
use clap::Subcommand;
use serde_json::{json, Map, Value};
use std::io::{IsTerminal, Write};
use std::sync::Arc;

#[derive(Subcommand)]
pub enum ModelAction {
    /// Show all available providers and models from the built-in catalog
    List,
    /// Show current assignments and resolved embedding configuration
    Show,
    /// Manage named embedding presets
    Preset {
        #[command(subcommand)]
        action: PresetAction,
    },
    /// Assign presets to embedding slots (code, text, rerank)
    Assign {
        #[arg(long, value_name = "preset")]
        code: Option<String>,
        #[arg(long, value_name = "preset")]
        text: Option<String>,
        #[arg(long, value_name = "preset|none")]
        rerank: Option<String>,
    },
    /// Drop and reindex all sources of a given type using the current preset assignment
    Switch {
        #[arg(long = "source-type", value_name = "type")]
        source_type: Option<String>,
        #[arg(short = 'y', long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub enum PresetAction {
    /// Add a new embedding preset to config.json
    Add {
        name: String,
        #[arg(long, value_name = "provider")]
        provider: Option<String>,
        #[arg(long, value_name = "model")]
        model: Option<String>,
        #[arg(long, value_name = "ref")]
        credentials: Option<String>,
        #[arg(long = "credentials-from", value_name = "preset")]
        credentials_from: Option<String>,
        #[arg(long = "base-url", value_name = "url")]
        base_url: Option<String>,
        #[arg(long, value_name = "n")]
        dim: Option<String>,
        #[arg(long = "encoding-format", value_name = "format")]
        encoding_format: Option<String>,
    },
    /// Remove an embedding preset from config.json
    #[command(visible_alias = "remove")]
    Rm { name: String },
}

/// Provider, the name it is shown by, its rerank models.
const PROVIDERS: &[(&str, &str, &[&str])] = &[("voyage", "Voyage AI", &["rerank-2.5", "rerank-2"]), ("openai", "OpenAI", &[]), ("local", "Local (in-process)", &[])];
/// What a chunk is taken to cost when a switch is estimated.
const TOKENS_PER_CHUNK: usize = 500;

fn configurable_dim(model: &str) -> bool {
    model.starts_with("voyage-3.5") || model.starts_with("voyage-4") || model.starts_with("text-embedding-3-")
}

fn catalog() -> String {
    let row = |provider: &str, model: &str, dim: &str, profile: &str, notes: &str| format!("{provider:<20}{model:<32}{dim:<6}{profile:<8}{notes}\n");
    let header = row("Provider", "Model", "Dim", "Profile", "Notes");
    let mut out = format!("{header}{}\n", "-".repeat(header.trim_end_matches('\n').len()));
    for (provider, name, rerankers) in PROVIDERS {
        let mut label = *name;
        for (_, model, dim, profile) in presets::MODELS.iter().filter(|m| m.0 == *provider) {
            out += &row(std::mem::take(&mut label), model, &dim.to_string(), profile, if configurable_dim(model) { "configurable dim" } else { "" });
        }
        for model in *rerankers {
            out += &row(std::mem::take(&mut label), model, "-", "rerank", "");
        }
    }
    out + &row("Custom (OpenAI-compatible)", "(user-defined)", "-", "-", "base_url + dim required")
}

/// A reference is shown as it is, a secret never.
fn masked(credentials: Option<&str>) -> &str {
    match credentials {
        None | Some("") => "<unset>",
        Some(c) if c.starts_with("${") => c,
        Some(_) => "<set>",
    }
}

fn credentials_of(preset: &Value, embedding: &Value) -> String {
    match text(preset, "credentials_from") {
        Some(from) => format!("from '{from}': {}", masked(embedding[from]["credentials"].as_str())),
        None => masked(preset["credentials"].as_str()).to_string(),
    }
}

/// A value as JavaScript puts it in a text.
fn shown(v: &Value) -> String {
    v.as_str().map_or_else(|| v.to_string(), String::from)
}

fn or_missing(v: Option<&Value>) -> String {
    v.filter(|v| !v.is_null()).map_or("(missing)".into(), shown)
}

/// Whether a preset's credentials can be read. Voyage's own variable counts as there.
fn resolution(name: &str, slot: &str, cfg: &Value) -> String {
    const VOYAGE: &str = "SCRYBE_VOYAGE_API_KEY";
    match presets::resolve_preset(name, slot, cfg, true) {
        Ok(_) => "ok".into(),
        Err(e) if std::env::var_os(VOYAGE).is_none() && e.to_string().starts_with(&format!("env var {VOYAGE} not set")) => "ok".into(),
        Err(e) => format!("ERROR — {e}"),
    }
}

fn show(cfg: &Value) -> String {
    let (assignments, embedding) = (&cfg["assignments"], &cfg["embedding_presets"]);
    let assigned = |slot: &str| assignments[slot].as_str().unwrap_or("");
    let rerank = assignments.get("rerank_preset").filter(|v| !v.is_null());
    let mut out = format!("=== Current Assignments ===\n\n  code_preset   : {}\n  text_preset   : {}\n  rerank_preset : {}\n\n", assigned("code_preset"), assigned("text_preset"), rerank.map_or("(none)".into(), shown));
    for (label, slot) in [("code", "code_preset"), ("text", "text_preset")] {
        let name = assigned(slot);
        let Some(preset) = embedding.get(name) else {
            out += &format!("=== {label} preset: '{name}' (NOT FOUND) ===\n\n");
            continue;
        };
        let (provider, model) = (preset["provider"].as_str().unwrap_or(""), preset["model"].as_str().unwrap_or(""));
        out += &format!("=== {label} preset: '{name}' ===\n\n  provider    : {provider}\n  model       : {model}\n");
        if provider == "custom" {
            out += &format!("  base_url    : {}\n  dim         : {}\n", or_missing(preset.get("base_url")), or_missing(preset.get("dim")));
        } else if let Some(spec) = presets::model_spec(provider, model) {
            let url = presets::provider_base_url(provider).filter(|u| !u.is_empty()).unwrap_or("(local)");
            out += &format!("  base_url    : {url}\n  dim         : {}\n  profile     : {}\n", spec.dim, spec.profile);
        } else {
            out += "  (catalog lookup failed)\n";
        }
        out += &format!("  credentials : {}\n  resolved    : {}\n\n", credentials_of(preset, embedding), resolution(name, slot, cfg));
    }
    if let Some(name) = text(assignments, "rerank_preset") {
        out += &format!("=== rerank preset: '{name}' ===\n\n");
        match cfg["reranker_presets"].get(name) {
            None => out += "  (NOT FOUND in reranker_presets)\n\n",
            Some(p) => out += &format!("  provider    : {}\n  model       : {}\n  credentials : {}\n\n", or_undefined(&p["provider"]), or_undefined(&p["model"]), credentials_of(p, embedding)),
        }
    }
    out
}

fn or_undefined(v: &Value) -> String {
    if v.is_null() { "undefined".into() } else { shown(v) }
}

/// Merges fields into a table's sidecar.
fn stamp(table: &str, fields: &Value) -> Result<()> {
    std::fs::create_dir_all(db_path())?;
    let path = db_path().join(format!("{table}-meta.json"));
    let mut meta: Map<String, Value> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    meta.extend(fields.as_object().cloned().unwrap_or_default());
    std::fs::write(path, serde_json::to_string_pretty(&meta)? + "\n")?;
    Ok(())
}

async fn reindex(store: &Store, project: &str, source: &Source, label: &str, fields: &Value) -> Result<()> {
    let line = label.to_string();
    let progress = ProgressSink(Arc::new(move |p| {
        match p {
            Progress::Scan(n) => print!("\r  {line}... scanning {n} files"),
            Progress::Embed(n) => print!("\r  {line}... embedding {n} chunks"),
            Progress::Download(_) => return,
        }
        let _ = std::io::stdout().flush();
    }));
    let done = index::index_source(store, project, &source.source_id, Mode::Full, &Options { progress: Some(progress), ..Default::default() }).await;
    println!();
    done?;
    match &source.table_name {
        Some(table) => stamp(table, fields),
        None => Ok(()),
    }
}

async fn switch(store: &Store, kind: &str, yes: bool) -> Result<()> {
    let Some(cfg) = presets::read_scrybe_config()? else { bail!("No config.json found. Run 'scrybe model preset add' and assign presets first.") };
    let slot = if kind == "code" { "code_preset" } else { "text_preset" };
    let name = cfg["assignments"][slot].as_str().unwrap_or("").to_string();
    if name.is_empty() {
        bail!("No {kind} preset assigned. Run 'scrybe model assign --{kind} <preset>' first.");
    }
    let resolved = presets::resolve_preset(&name, slot, &cfg, true)?;
    let projects = registry::list_projects();
    let mut targets = vec![];
    for p in &projects {
        for s in &p.sources {
            let Some(profile) = s.profile() else { bail!("No plugin registered for source type \"{}\"", s.kind()) };
            if profile != kind {
                continue;
            }
            let chunks = match &s.table_name {
                Some(table) => store.count_rows(table).await.unwrap_or(0),
                None => 0,
            };
            targets.push((p, s, chunks));
        }
    }
    if targets.is_empty() {
        println!("No {kind} sources found. Nothing to switch.");
        return Ok(());
    }
    println!("\nSwitching {} {kind} source(s) to preset '{name}':\n  Provider : {}\n  Model    : {}\n  Dim      : {}\n", targets.len(), resolved.provider, resolved.model, shown(&resolved.dim));
    for (p, s, chunks) in &targets {
        println!("  {}/{}  ({chunks} chunks currently indexed)", p.id, s.source_id);
    }
    let total: usize = targets.iter().map(|t| t.2).sum();
    if resolved.provider != "local" && total > 0 {
        println!("\n  Estimated tokens to re-embed: ~{} ({total} chunks × {TOKENS_PER_CHUNK} tokens avg). Check your provider's pricing for cost.", grouped(total * TOKENS_PER_CHUNK));
    }
    println!("\n  This will drop and fully reindex the affected tables. All existing vectors will be replaced.");
    if !yes {
        if !std::io::stdin().is_terminal() {
            bail!("Non-interactive input. Pass --yes to confirm without a prompt.");
        }
        if !confirm(&format!("\nSwitch {} source(s)? [y/N] ", targets.len()))? {
            println!("Aborted.");
            return Ok(());
        }
    }
    println!("\nReindexing...");
    let mut failed = 0;
    for (p, s, _) in &targets {
        let label = format!("{}/{}", p.id, s.source_id);
        print!("  {label}...");
        let _ = std::io::stdout().flush();
        let fields = json!({ "model": resolved.model, "dim": resolved.dim, "provider": resolved.provider, "preset_at_index_time": name, "indexed_at": crate::jobs::now_iso() });
        match Box::pin(reindex(store, &p.id, s, &label, &fields)).await {
            Ok(()) => println!("    Done."),
            Err(e) => {
                eprintln!("    Failed: {e:#}");
                failed += 1;
            }
        }
    }
    if failed > 0 {
        eprintln!("\n{failed} source(s) failed. Run 'scrybe doctor' for diagnostics.");
        std::process::exit(1);
    }
    println!("\nAll {} source(s) reindexed with preset '{name}'.", targets.len());
    println!("\nTables recreated. If an MCP client (Claude Code, Cline) is connected, restart it to pick up the new tables.");
    Ok(())
}

fn stop(message: &str) -> ! {
    eprintln!("[scrybe] {message}");
    std::process::exit(1)
}

async fn model_inner(store: &Store, action: ModelAction) -> Result<()> {
    match action {
        ModelAction::List => print!("{}", catalog()),
        ModelAction::Show => match presets::read_scrybe_config()? {
            Some(cfg) => print!("{}", show(&cfg)),
            None => println!("No config.json found. Run 'scrybe model preset add' to create one."),
        },
        ModelAction::Preset { action: PresetAction::Add { name, provider, model, credentials, credentials_from, base_url, dim, encoding_format } } => {
            let provider = need(provider, "--provider <provider>");
            let model = need(model, "--model <model>");
            let mut a = json!({ "name": name, "provider": provider, "model": model });
            for (key, value) in [("credentials", credentials), ("credentials_from", credentials_from), ("base_url", base_url), ("encoding_format", encoding_format)] {
                if let Some(v) = value {
                    a[key] = json!(v);
                }
            }
            if let Some(dim) = dim {
                a["dim"] = parse_int(&dim).map_or(Value::Null, |n| json!(n as i64));
            }
            presets::add_preset(&a)?;
            println!("Preset '{name}' added to config.json.");
        }
        ModelAction::Preset { action: PresetAction::Rm { name } } => {
            presets::remove_preset(&name)?;
            println!("Preset '{name}' removed from config.json.");
        }
        ModelAction::Assign { code, text, rerank } => {
            if [&code, &text, &rerank].iter().all(|o| o.as_deref().unwrap_or("").is_empty()) {
                stop("At least one of --code, --text, or --rerank must be specified.");
            }
            if presets::assign_presets(code.as_deref(), text.as_deref(), rerank.as_deref())? {
                println!("Rerank preset cleared.");
            }
            println!("Assignments updated in config.json.");
        }
        ModelAction::Switch { source_type, yes } => {
            let kind = need(source_type, "--source-type <type>");
            if kind != "code" && kind != "text" {
                stop(&format!("--source-type must be 'code' or 'text', got: '{kind}'"));
            }
            switch(store, &kind, yes).await?;
        }
    }
    Ok(())
}

pub async fn model(store: Store, action: ModelAction) {
    finish(model_inner(&store, action).await);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_is_a_table_that_names_a_provider_once() {
        let table = catalog();
        let lines: Vec<&str> = table.lines().collect();
        assert_eq!(lines[0], "Provider            Model                           Dim   Profile Notes");
        assert_eq!(lines[1], "-".repeat(71));
        assert_eq!(lines[2], "Voyage AI           voyage-code-3                   1024  code    ");
        assert_eq!(lines[5], "                    voyage-3.5                      1024  text    configurable dim");
        assert_eq!(table.matches("Voyage AI").count(), 1);
        assert!(table.contains("\n                    rerank-2.5                      -     rerank  \n"));
        assert!(table.contains("                    jinaai/jina-embeddings-v2-base-code768   code    \n"));
        assert!(table.ends_with("Custom (OpenAI-compatible)(user-defined)                  -     -       base_url + dim required\n"));
    }

    #[test]
    fn secrets_are_not_shown_and_references_are() {
        assert_eq!([masked(None), masked(Some("")), masked(Some("${KEY}")), masked(Some("sk-1"))], ["<unset>", "<unset>", "${KEY}", "<set>"]);
        let presets = json!({ "a": { "credentials": "sk-1" }, "b": { "credentials_from": "a" }, "c": { "credentials_from": "gone" } });
        assert_eq!(credentials_of(&presets["b"], &presets), "from 'a': <set>");
        assert_eq!(credentials_of(&presets["c"], &presets), "from 'gone': <unset>");
    }

    #[test]
    fn both_slots_are_shown_with_what_they_resolve_to() {
        let cfg = json!({
            "embedding_presets": { "mine": { "provider": "custom", "model": "m", "base_url": "http://x/v1", "dim": 8 } },
            "reranker_presets": { "rr": { "provider": "voyage", "model": "rerank-2.5" } },
            "assignments": { "code_preset": "mine", "text_preset": "gone", "rerank_preset": "rr" }
        });
        assert_eq!(show(&cfg), "=== Current Assignments ===\n\n  code_preset   : mine\n  text_preset   : gone\n  rerank_preset : rr\n\n=== code preset: 'mine' ===\n\n  provider    : custom\n  model       : m\n  base_url    : http://x/v1\n  dim         : 8\n  credentials : <unset>\n  resolved    : ok\n\n=== text preset: 'gone' (NOT FOUND) ===\n\n=== rerank preset: 'rr' ===\n\n  provider    : voyage\n  model       : rerank-2.5\n  credentials : <unset>\n\n");
    }
}
