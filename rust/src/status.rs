//! `status`. Mirrors the command of that name in `src/cli.ts`. It reads the data dir itself and, when a server answers, asks it for its state.
use crate::cli::{finish, show};
use crate::jobs::Queue;
use crate::ops::{client, fmt_size, pidfile};
use crate::store::{db_path, needs_migration, Health, Store};
use crate::{config, registry};
use anyhow::Result;
use clap::Args;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[derive(Args)]
pub struct StatusArgs {
    /// Show single-project info (JSON)
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
    /// Machine-readable output (schemaVersion: 1)
    #[arg(long)]
    json: bool,
    /// Hide daemon section, show only project registry
    #[arg(long)]
    projects: bool,
    /// Show all projects (no truncation)
    #[arg(short = 'a', long)]
    all: bool,
    /// Live dashboard (not available in this build)
    #[arg(long)]
    watch: bool,
}

struct Src {
    source_id: String,
    chunks: usize,
    last_indexed: Option<String>,
    size_bytes: u64,
    version_count: usize,
    flags: Vec<&'static str>,
    health_flag: Option<String>,
}

struct Summary {
    id: String,
    sources: Vec<Src>,
}

/// The live-data message for a dashboard this build doesn't have.
pub(crate) fn no_dashboard() -> ! {
    eprintln!("[scrybe] The live dashboard (--watch) is not available in this build yet. Use 'scrybe status' without it.");
    std::process::exit(1)
}

fn project_info(id: &str) -> Result<Value> {
    let raw = std::fs::read_to_string(config::data_dir().join("projects.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let Some(mut project) = raw.as_ref().and_then(Value::as_array).and_then(|a| a.iter().find(|p| p["id"] == id)).cloned() else {
        eprintln!("Project '{id}' not found");
        std::process::exit(1);
    };
    let queue_rows = crate::jobs::Rows::open()?;
    if let Some(sources) = project["sources"].as_array_mut() {
        for s in sources {
            let branches = if s["source_config"]["type"] == "code" {
                queue_rows.list_branches(id, s["source_id"].as_str().unwrap_or(""))
            } else {
                vec!["*".to_string()]
            };
            s["branches_indexed"] = json!(branches);
        }
    }
    Ok(project)
}

/// What a running server says about itself, or `{running: false}`.
async fn daemon_info() -> Value {
    let Some((_, port)) = pidfile().filter(|(_, port)| *port > 0) else { return json!({ "running": false }) };
    let Ok(http) = client(Duration::from_secs(2)) else { return json!({ "running": false }) };
    let Ok(res) = http.get(format!("http://127.0.0.1:{port}/status")).send().await else { return json!({ "running": false }) };
    let Ok(s) = res.json::<Value>().await else { return json!({ "running": false }) };
    let active = s["queue"]["active"].as_i64().unwrap_or(0) + s["queue"]["pending"].as_i64().unwrap_or(0);
    json!({
        "running": true,
        "pid": s["pid"],
        "uptimeMs": s["uptimeMs"],
        "activeJobs": active,
        "clientCount": if s["clientCount"].is_null() { json!(0) } else { s["clientCount"].clone() },
        "mode": if s["mode"].is_null() { json!("on-demand") } else { s["mode"].clone() },
        "gracePeriodRemainingMs": s["gracePeriodRemainingMs"].clone(),
        "draining": s["draining"] == true,
    })
}

/// `model_mismatch`: the table's recorded model, size and provider differ from what the assigned preset says now.
fn model_mismatch(source: &registry::Source, table: &str, text: bool) -> bool {
    let Ok(Some(cfg)) = registry::read_config() else { return false };
    let Some(meta) = std::fs::read_to_string(db_path().join(format!("{table}-meta.json"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return false };
    let (Some(model), Some(dim), Some(provider)) = (meta["model"].as_str(), meta["dim"].as_i64(), meta["provider"].as_str()) else { return false };
    let Some(preset) = cfg.assignments.get(if text { "text_preset" } else { "code_preset" }).and_then(|n| cfg.embedding_presets.get(n)) else { return false };
    let Ok(resolved) = registry::resolve_embedding(source) else { return false };
    !(model == preset.model && dim == i64::from(resolved.dimensions) && provider == preset.provider)
}

async fn summarise(store: &Store, projects: &[registry::Project]) -> Vec<Summary> {
    let threshold = std::env::var("SCRYBE_LANCE_COMPACT_THRESHOLD").ok().and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(10);
    let mut out = vec![];
    for p in projects {
        let mut sources = vec![];
        for s in &p.sources {
            let (size_bytes, version_count) = match &s.table_name {
                Some(t) => store.table_stats(t).await,
                None => (0, 0),
            };
            let mut flags = vec![];
            if version_count > 2 * threshold {
                flags.push("bloat");
            }
            let mut health_flag = None;
            let mut chunks = 0;
            if let Some(table) = &s.table_name {
                let text = s.profile() == Some("text");
                if needs_migration(table) {
                    flags.push("needs_migration");
                }
                if let Ok(cfg) = registry::resolve_embedding(s) {
                    if let Health::Corrupt(reason) = store.table_health(table, Some(crate::index::expected_dimensions(&cfg, text))).await {
                        flags.push("corrupt");
                        health_flag = Some(reason);
                    }
                }
                if model_mismatch(s, table, text) {
                    flags.push("model_mismatch");
                }
                chunks = store.count_rows(table).await.unwrap_or(0);
            }
            sources.push(Src { source_id: s.source_id.clone(), chunks, last_indexed: s.last_indexed.clone(), size_bytes, version_count, flags, health_flag });
        }
        out.push(Summary { id: p.id.clone(), sources });
    }
    out
}

/// What `readdirSync(dir, { recursive: true })` plus `statSync(...).size` adds up to: every entry, folders included.
fn data_dir_bytes(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            let own = std::fs::metadata(e.path()).map_or(0, |m| m.len());
            own + if e.file_type().is_ok_and(|t| t.is_dir()) { data_dir_bytes(&e.path()) } else { 0 }
        })
        .sum()
}

fn uptime(ms: i64) -> String {
    let s = ms / 1000;
    let (d, h, m) = (s / 86400, (s % 86400) / 3600, (s % 3600) / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

fn relative_ms(then_ms: i64) -> String {
    let s = (chrono::Utc::now().timestamp_millis() - then_ms).div_euclid(1000);
    if s < 60 {
        return "just now".into();
    }
    let m = s / 60;
    if m < 60 {
        return format!("{m}m ago");
    }
    let h = m / 60;
    if h < 24 { format!("{h}h ago") } else { format!("{}d ago", h / 24) }
}

fn relative_iso(iso: Option<&str>) -> String {
    match iso.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
        Some(t) => relative_ms(t.timestamp_millis()),
        None => "never".into(),
    }
}

/// `n.toLocaleString()` in English: thousands separated by commas.
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn env_number(name: &str) -> Option<f64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| n.is_finite() && *n > 0.0)
}

fn padded(s: &str, width: usize) -> String {
    format!("{s:<width$}")
}

fn render(args: &StatusArgs, daemon: &Value, summaries: &[Summary], store_queue: &Arc<Queue>) {
    let dir = config::data_dir().to_string_lossy().into_owned();
    println!("{}DATA_DIR: {dir}", padded(&format!("Scrybe v{}", config::VERSION), 40));
    println!();
    if !args.projects {
        if daemon["running"] == true {
            let jobs = daemon["activeJobs"].as_i64().unwrap_or(0);
            let clients = daemon["clientCount"].as_i64().unwrap_or(0);
            let client_text = if clients == 1 { "1 client".to_string() } else { format!("{clients} clients") };
            let grace = daemon["gracePeriodRemainingMs"].as_f64().map_or(String::new(), |g| format!(" · grace in ~{}m", (g / 60000.0).ceil()));
            let draining = if daemon["draining"] == true { " · DRAINING (finishing in-flight work, then exiting)" } else { "" };
            println!("Daemon         ● running · PID {} · uptime {} · {client_text}{grace} · {jobs} jobs active{draining}", daemon["pid"], uptime(daemon["uptimeMs"].as_i64().unwrap_or(0)));
            println!("Mode           {}", daemon["mode"].as_str().unwrap_or("on-demand"));
        } else {
            println!("Daemon         ○ not running");
        }
        if std::env::var("SCRYBE_AUTO_GC").as_deref() != Ok("0") {
            let idle_ms = env_number("SCRYBE_AUTO_GC_IDLE_MS").unwrap_or(300_000.0);
            let ratio = env_number("SCRYBE_AUTO_GC_RATIO").unwrap_or(0.15);
            let idle = if idle_ms >= 60_000.0 { format!("{}m idle", (idle_ms / 60_000.0 + 0.5).floor()) } else { format!("{}s idle", (idle_ms / 1000.0 + 0.5).floor()) };
            println!("Auto-GC        ● enabled · {idle} / {}% ratio", (ratio * 100.0 + 0.5).floor());
        } else {
            println!("Auto-GC        ○ disabled (SCRYBE_AUTO_GC=0)");
        }
    }
    let shown = if args.all { summaries.len() } else { summaries.len().min(5) };
    println!("Projects       {} registered", summaries.len());
    if summaries[..shown].iter().any(|p| !p.sources.is_empty()) {
        println!("  {}{}{}  {}{}{}LAST GC", padded("PROJECT", 20), padded("SOURCE", 18), format!("{:>8}", "CHUNKS"), padded("SIZE", 10), padded("HEALTH", 12), padded("LAST INDEXED", 14));
    }
    for p in &summaries[..shown] {
        let last_gc = store_queue.rows.last_good_gc(&p.id).map_or("—".to_string(), relative_ms);
        for s in &p.sources {
            let size = if s.size_bytes > 0 { fmt_size(s.size_bytes) } else { "—".into() };
            let health = if s.flags.contains(&"corrupt") {
                "Corrupt *"
            } else if s.flags.contains(&"needs_migration") {
                "Migrate (chunk-id)"
            } else if s.flags.contains(&"bloat") {
                "Bloated *"
            } else {
                "Healthy"
            };
            let id: String = p.id.chars().take(19).collect();
            let sid: String = s.source_id.chars().take(17).collect();
            println!("  {}{}{:>8}  {}{}{}{last_gc}", padded(&id, 20), padded(&sid, 18), grouped(s.chunks), padded(&size, 10), padded(health, 12), padded(&relative_iso(s.last_indexed.as_deref()), 14));
        }
    }
    if summaries.len() > shown {
        println!("  ({} more — use --all)", summaries.len() - shown);
    }
    let with = |flag: &str| -> Vec<(&Summary, &Src)> { summaries.iter().flat_map(|p| p.sources.iter().filter(|s| s.flags.iter().any(|f| *f == flag)).map(move |s| (p, s))).collect() };
    let migrate = with("needs_migration");
    if !migrate.is_empty() {
        let names: Vec<String> = migrate.iter().map(|(p, s)| format!("{}/{}", p.id, s.source_id)).collect();
        println!("\n  Migrate (chunk-id): {} — run 'scrybe migrate --all' to upgrade", names.join(", "));
    }
    let corrupt = with("corrupt");
    if !corrupt.is_empty() {
        let names: Vec<String> = corrupt
            .iter()
            .map(|(p, s)| {
                let badge = match s.health_flag.as_deref() {
                    Some("manifest_missing_data") => "manifest".to_string(),
                    Some("dimensions_mismatch") => "dim".to_string(),
                    Some("schema_unreadable") => "schema".to_string(),
                    Some(other) => other.to_string(),
                    None => "corrupt".to_string(),
                };
                format!("{}/{} ({badge})", p.id, s.source_id)
            })
            .collect();
        println!("\n  * Corrupt: {} — run 'scrybe doctor --repair' or 'scrybe index -P <id> -S <id> --full'", names.join(", "));
    }
    if !with("bloat").is_empty() {
        println!("\n  * run 'scrybe gc' to reclaim disk space");
    }
}

async fn status_inner(store: Store, args: StatusArgs) -> Result<()> {
    if let Some(id) = args.project_id.as_deref().filter(|p| !p.is_empty()) {
        show(&project_info(id)?)?;
        println!("Data dir: {}", config::data_dir().to_string_lossy());
        return Ok(());
    }
    if args.watch {
        no_dashboard();
    }
    let daemon = daemon_info().await;
    let projects = registry::list_projects();
    let store = Arc::new(store);
    let summaries = summarise(&store, &projects).await;
    if args.json {
        let dir = config::data_dir();
        let size = if dir.exists() { data_dir_bytes(&dir) } else { 0 };
        let listed: Vec<Value> = summaries
            .iter()
            .map(|p| {
                let sources: Vec<Value> = p
                    .sources
                    .iter()
                    .map(|s| json!({ "sourceId": s.source_id, "chunks": s.chunks, "lastIndexed": s.last_indexed, "sizeBytes": s.size_bytes, "versionCount": s.version_count, "flags": s.flags, "healthFlag": s.health_flag }))
                    .collect();
                json!({ "id": p.id, "sources": sources })
            })
            .collect();
        return show(&json!({ "schemaVersion": 1, "scrybeVersion": config::VERSION, "dataDir": { "path": dir.to_string_lossy(), "sizeBytes": size }, "daemon": daemon, "projects": listed }));
    }
    let queue = Queue::new(store)?;
    render(&args, &daemon, &summaries, &queue);
    Ok(())
}

pub async fn status(store: Store, args: StatusArgs) {
    finish(status_inner(store, args).await);
}
