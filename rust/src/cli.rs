//! The management commands of the command line. Mirrors the registration loop, the plural shorthands
//! and the branch group in `src/cli.ts`. Every command runs in this process, like today's does without a daemon.
use crate::jobs::{now_ms, Queue, Request};
use crate::jsstr::js_trim;
use crate::store::Store;
use crate::{ephemeral, manage, pinned, registry, source_add, tools};
use anyhow::{anyhow, bail, Result};
use clap::{Args, Subcommand};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

const PROJECT_FLAG: &str = "-P, --project-id <id>";
const SOURCE_FLAG: &str = "-S, --source-id <id>";

#[derive(Subcommand)]
pub enum ProjectAction {
    /// List all registered projects and their sources
    #[command(alias = "ls")]
    List,
    /// Register a new project container
    Add {
        #[arg(long, value_name = "id")]
        id: Option<String>,
        #[arg(long, value_name = "text")]
        desc: Option<String>,
    },
    /// Update a project's description
    Update {
        #[arg(value_name = "id")]
        target: Option<String>,
        #[arg(long, value_name = "id")]
        id: Option<String>,
        #[arg(long, value_name = "text")]
        desc: Option<String>,
    },
    /// Unregister a project and drop all its source tables
    #[command(aliases = ["rm", "delete"])]
    Remove {
        #[arg(value_name = "id")]
        target: Option<String>,
        #[arg(long, value_name = "id")]
        id: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum SourceAction {
    /// List all sources (optionally filter by project)
    #[command(alias = "ls")]
    List {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
    },
    /// Add an indexable source to a project and queue its first index
    Add {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id")]
        source_id: Option<String>,
        #[arg(long = "type", value_name = "type")]
        kind: Option<String>,
        #[arg(long, value_name = "path")]
        root: Option<String>,
        #[arg(long, value_name = "langs")]
        languages: Option<String>,
        #[arg(long, value_name = "provider")]
        provider: Option<String>,
        #[arg(long, value_name = "url")]
        url: Option<String>,
        #[arg(long, value_name = "id")]
        project: Option<String>,
        #[arg(long, value_name = "token")]
        token: Option<String>,
        #[arg(long = "gitlab-url", value_name = "url")]
        gitlab_url: Option<String>,
        #[arg(long = "gitlab-project-id", value_name = "id")]
        gitlab_project_id: Option<String>,
        #[arg(long = "gitlab-token", value_name = "token")]
        gitlab_token: Option<String>,
    },
    /// Update an existing source's config
    Update {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id")]
        source_id: Option<String>,
        #[arg(long, value_name = "url")]
        url: Option<String>,
        #[arg(long, value_name = "id")]
        project: Option<String>,
        #[arg(long, value_name = "token")]
        token: Option<String>,
        #[arg(long = "gitlab-token", value_name = "token")]
        gitlab_token: Option<String>,
        #[arg(long = "gitlab-url", value_name = "url")]
        gitlab_url: Option<String>,
        #[arg(long = "gitlab-project-id", value_name = "id")]
        gitlab_project_id: Option<String>,
        #[arg(long, value_name = "path")]
        root: Option<String>,
        #[arg(long, value_name = "langs")]
        languages: Option<String>,
    },
    /// Remove a source from a project and drop its vector table
    #[command(aliases = ["rm", "delete"])]
    Remove {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id")]
        source_id: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum JobAction {
    /// List background reindex jobs
    List {
        /// Show only running jobs
        #[arg(long)]
        running: bool,
    },
}

#[derive(Subcommand)]
pub enum BranchAction {
    /// List indexed branches, or pinned ones with --pinned
    #[command(alias = "ls")]
    List(BranchListArgs),
    /// Pin branches for background indexing
    #[command(alias = "p")]
    Pin {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id", default_value = "primary")]
        source_id: String,
        #[arg(value_name = "branches")]
        branches: Vec<String>,
    },
    /// Remove pinned branches
    #[command(alias = "u")]
    Unpin {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id", default_value = "primary")]
        source_id: String,
        /// Remove all pinned branches
        #[arg(short = 'a', long)]
        all: bool,
        /// Skip confirmation prompt (required with --all)
        #[arg(short = 'y', long)]
        yes: bool,
        #[arg(value_name = "branches")]
        branches: Vec<String>,
    },
}

#[derive(Args)]
pub struct BranchListArgs {
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
    #[arg(short = 'S', long = "source-id", value_name = "id")]
    source_id: Option<String>,
    /// Show only pinned branches
    #[arg(short = 'p', long)]
    pinned: bool,
}

#[derive(Args)]
pub struct SourcesArgs {
    /// Limit to a specific project
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
}

#[derive(Args)]
pub struct JobsArgs {
    /// Show only running jobs
    #[arg(long)]
    running: bool,
}

#[derive(Args)]
pub struct IndexEphemeralArgs {
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
    /// Already-fetched MR branch, or a full ref
    #[arg(long, value_name = "name")]
    branch: Option<String>,
    #[arg(short = 'S', long = "source-id", value_name = "id", default_value = "primary")]
    source_id: String,
    /// Override the ephemeral label (still forced under _ephemeral/)
    #[arg(long, value_name = "label")]
    label: Option<String>,
}

#[derive(Args)]
pub struct DropEphemeralArgs {
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
    /// The '_ephemeral/...' label to drop
    #[arg(long, value_name = "label")]
    label: Option<String>,
    #[arg(short = 'S', long = "source-id", value_name = "id", default_value = "primary")]
    source_id: String,
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

/// A required option that wasn't given, worded and exited like commander does.
pub(crate) fn need(value: Option<String>, flag: &str) -> String {
    value.unwrap_or_else(|| {
        eprintln!("error: required option '{flag}' not specified");
        std::process::exit(1)
    })
}

/// Errors print as `[scrybe] <message>` and exit 1.
pub(crate) fn finish(result: Result<()>) {
    if let Err(e) = result {
        eprintln!("[scrybe] {e:#}");
        std::process::exit(1);
    }
}

/// `printResult`: nothing is printed for an empty text.
pub(crate) fn say(text: &str) {
    if !text.is_empty() {
        println!("{text}");
    }
}

pub(crate) fn show(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn queue_of(store: Store) -> Result<Arc<Queue>> {
    Queue::new(Arc::new(store))
}

/// A job runs in this process, so the command ends only when it has.
async fn settle(queue: &Arc<Queue>) {
    while queue.active_count() > 0 || queue.depth().0 > 0 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(crate) enum Server {
    /// No server to use: none running, starting is switched off, or this is a container.
    Down,
    Up(u16),
    Draining,
}

/// `ensureRunning` without the starting: TS would spawn a server here when auto-start is allowed; this never does.
pub(crate) async fn server_state() -> Server {
    if std::env::var("SCRYBE_NO_AUTO_DAEMON").as_deref() == Ok("1") || crate::ops::in_container() {
        return Server::Down;
    }
    let Some(port) = std::fs::read_to_string(crate::config::data_dir().join("daemon.pid")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["port"].as_u64()) else { return Server::Down };
    let Ok(client) = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build() else { return Server::Down };
    let Ok(res) = client.get(format!("http://127.0.0.1:{port}/health")).send().await else { return Server::Down };
    if !res.status().is_success() {
        return Server::Down;
    }
    if res.json::<Value>().await.is_ok_and(|h| h["draining"] == true) {
        return Server::Draining;
    }
    Server::Up(port as u16)
}

/// The port of a live server on this data dir; a draining one is an error, as it refuses new work.
async fn live_server() -> Result<Option<u16>> {
    match server_state().await {
        Server::Down => Ok(None),
        Server::Up(port) => Ok(Some(port)),
        Server::Draining => bail!("The scrybe daemon is shutting down (finishing in-flight work) and is not accepting new jobs.\nRetry in a moment — a replacement daemon starts on the next call."),
    }
}

pub(crate) async fn post(port: u16, path: &str, body: &Value) -> Result<Value> {
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(30)).build()?;
    let res = client.post(format!("http://127.0.0.1:{port}{path}")).json(body).send().await?;
    if !res.status().is_success() {
        bail!("POST {path} returned {}", res.status().as_u16());
    }
    Ok(res.json().await?)
}

/// A string option counts as given when it is not empty, like `opts.x ? ... : undefined`.
fn put(m: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        m.insert(key.to_string(), Value::String(v));
    }
}

fn text(a: &Value, key: &str) -> String {
    a[key].as_str().unwrap_or("").to_string()
}

// ─── project ─────────────────────────────────────────────────────────────────

pub async fn project(store: Store, action: ProjectAction) {
    finish(project_inner(store, action).await);
}

fn id_of(target: Option<String>, flag: Option<String>) -> Result<String> {
    match target.or(flag) {
        Some(id) if !id.is_empty() => Ok(id),
        _ => bail!("project id required (positional or --id)"),
    }
}

async fn project_inner(store: Store, action: ProjectAction) -> Result<()> {
    match action {
        ProjectAction::List => say(&tools::format_projects(&tools::list_projects())),
        ProjectAction::Add { id, desc } => {
            let id = need(id, "--id <id>");
            let mut a = Map::new();
            a.insert("project_id".into(), json!(id));
            put(&mut a, "description", desc);
            manage::add_project(&Value::Object(a))?;
            say(&format!("Added project '{id}'"));
        }
        ProjectAction::Update { target, id, desc } => {
            let id = id_of(target, id)?;
            let mut a = Map::new();
            a.insert("project_id".into(), json!(id));
            put(&mut a, "description", desc);
            let updated = manage::update_project(&Value::Object(a))?;
            say(&format!("Updated project '{}'", updated["id"].as_str().unwrap_or("")));
        }
        ProjectAction::Remove { target, id } => {
            let id = id_of(target, id)?;
            manage::remove_project(&queue_of(store)?, &id).await?;
            say(&format!("Removed project '{id}'"));
        }
    }
    Ok(())
}

// ─── source ──────────────────────────────────────────────────────────────────

pub async fn source(store: Store, action: SourceAction) {
    finish(source_inner(store, action).await);
}

async fn source_inner(store: Store, action: SourceAction) -> Result<()> {
    match action {
        SourceAction::List { project_id } => list_sources(project_id.filter(|p| !p.is_empty()))?,
        SourceAction::Add { project_id, source_id, kind, root, languages, provider, url, project, token, gitlab_url, gitlab_project_id, gitlab_token } => {
            let project_id = need(project_id, PROJECT_FLAG);
            let source_id = need(source_id, SOURCE_FLAG);
            let kind = need(kind, "--type <type>");
            let mut a = Map::new();
            a.insert("project_id".into(), json!(project_id));
            a.insert("source_id".into(), json!(source_id));
            a.insert("source_type".into(), json!(kind));
            put(&mut a, "root_path", root);
            put(&mut a, "languages", languages);
            put(&mut a, "provider", provider);
            put(&mut a, "url", url);
            put(&mut a, "project", project);
            put(&mut a, "token", token);
            put(&mut a, "gitlab_url", gitlab_url);
            put(&mut a, "gitlab_project_id", gitlab_project_id);
            put(&mut a, "gitlab_token", gitlab_token);
            let a = Value::Object(a);
            let config = source_add::prepare(&a).await?;
            let port = live_server().await?;
            source_add::save(&a, config)?;
            if let Some(port) = port {
                let sent = post(port, "/kick", &json!({ "projectId": project_id, "sourceId": source_id, "mode": "incremental" })).await?;
                let Some(job) = sent["jobs"][0]["jobId"].as_str() else { bail!("Daemon returned no job") };
                say(&format!("Added source '{source_id}' to project '{project_id}' — reindex job: {job}"));
                return Ok(());
            }
            let queue = queue_of(store)?;
            let added = source_add::submit(&queue, &project_id, &source_id)?;
            say(&format!("Added source '{source_id}' to project '{project_id}' — reindex job: {}", text(&added, "job_id")));
            settle(&queue).await;
        }
        SourceAction::Update { project_id, source_id, url, project, token, gitlab_token, gitlab_url, gitlab_project_id, root, languages } => {
            let project_id = need(project_id, PROJECT_FLAG);
            let source_id = need(source_id, SOURCE_FLAG);
            let mut a = Map::new();
            a.insert("project_id".into(), json!(project_id));
            a.insert("source_id".into(), json!(source_id));
            put(&mut a, "url", url);
            put(&mut a, "project", project);
            put(&mut a, "token", token);
            put(&mut a, "gitlab_token", gitlab_token);
            put(&mut a, "gitlab_url", gitlab_url);
            put(&mut a, "gitlab_project_id", gitlab_project_id);
            put(&mut a, "root_path", root);
            put(&mut a, "languages", languages);
            let done = manage::update_source(&Value::Object(a))?;
            if done["updated"] == true {
                say(&format!("Updated source '{source_id}' in project '{project_id}'"));
            } else {
                say("Nothing to update — specify at least one option to change.");
            }
        }
        SourceAction::Remove { project_id, source_id } => {
            let project_id = need(project_id, PROJECT_FLAG);
            let source_id = need(source_id, SOURCE_FLAG);
            let a = json!({ "project_id": project_id, "source_id": source_id });
            manage::remove_source(&queue_of(store)?, &a).await?;
            say(&format!("Removed source '{source_id}' from project '{project_id}'"));
        }
    }
    Ok(())
}

fn list_sources(only: Option<String>) -> Result<()> {
    let projects = match &only {
        Some(id) => registry::get_project(id).into_iter().collect(),
        None => registry::list_projects(),
    };
    say(&tools::format_sources(&projects));
    Ok(())
}

pub fn sources(args: SourcesArgs) {
    finish(list_sources(args.project_id.filter(|p| !p.is_empty())));
}

pub fn projects() {
    say(&tools::format_projects(&tools::list_projects()));
}

// ─── job ─────────────────────────────────────────────────────────────────────

fn list_jobs(store: Store, running: bool) -> Result<()> {
    let jobs = queue_of(store)?.list_jobs(running.then_some("running"))?;
    say(&tools::format_jobs(&jobs, now_ms()));
    Ok(())
}

pub fn job(store: Store, action: JobAction) {
    let JobAction::List { running } = action;
    finish(list_jobs(store, running));
}

pub fn jobs(store: Store, args: JobsArgs) {
    finish(list_jobs(store, args.running));
}

// ─── branch ──────────────────────────────────────────────────────────────────

fn branch_list(store: Store, args: BranchListArgs, shorthand: bool) -> Result<()> {
    let project_id = need(args.project_id, PROJECT_FLAG);
    if args.pinned {
        // `branch list --pinned` falls back to the primary source, the `branches` shorthand to every code source.
        let source = match (args.source_id, shorthand) {
            (Some(s), _) => Some(s),
            (None, false) => Some("primary".to_string()),
            (None, true) => None,
        };
        return list_pinned(&project_id, source.as_deref());
    }
    let mut a = Map::new();
    a.insert("project_id".into(), json!(project_id));
    if let Some(s) = args.source_id {
        a.insert("source_id".into(), json!(s));
    }
    show(&manage::list_branches(&queue_of(store)?, &Value::Object(a))?)
}

pub fn branches(store: Store, args: BranchListArgs) {
    finish(branch_list(store, args, true));
}

pub fn branch(store: Store, action: BranchAction) {
    finish(branch_inner(store, action));
}

/// `branch pin`: the result as JSON, then the long-list warnings; ignore-rule warnings go to stderr in yellow.
pub(crate) fn pin_branches(project_id: &str, source_id: &str, branches: &[String]) -> Result<()> {
    let result = pinned::pin_tool(project_id, source_id, branches, false).map_err(|m| anyhow!(m))?;
    for w in result["ignore_warnings"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        eprintln!("\x1b[33m{w}\x1b[0m");
    }
    let mut out = serde_json::to_string_pretty(&result)?;
    for w in result["warnings"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        out += &format!("\nwarning: {w}");
    }
    say(&out);
    Ok(())
}

pub(crate) fn unpin_branches(project_id: &str, source_id: &str, branches: &[String]) -> Result<()> {
    show(&pinned::remove(project_id, source_id, branches).map_err(|e| anyhow!(e.message()))?.to_json())
}

/// `branch unpin --all`: asks first unless `yes`.
pub(crate) fn clear_pinned(project_id: &str, source_id: &str, yes: bool) -> Result<()> {
    if !yes {
        print!("Clear all pinned branches for {project_id}/{source_id}? [y/N] ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        if js_trim(&line).to_lowercase() != "y" {
            println!("Aborted.");
            return Ok(());
        }
    }
    show(&pinned::clear(project_id, source_id).map_err(|e| anyhow!(e.message()))?.to_json())
}

/// `list_pinned_branches` as JSON.
pub(crate) fn list_pinned(project_id: &str, source_id: Option<&str>) -> Result<()> {
    show(&pinned::list_tool(project_id, source_id).map_err(|m| anyhow!(m))?)
}

fn branch_inner(store: Store, action: BranchAction) -> Result<()> {
    match action {
        BranchAction::List(args) => branch_list(store, args, false),
        BranchAction::Pin { project_id, source_id, branches } => {
            let project_id = need(project_id, PROJECT_FLAG);
            if branches.is_empty() {
                eprintln!("error: missing required argument 'branches'");
                std::process::exit(1);
            }
            pin_branches(&project_id, &source_id, &branches)
        }
        BranchAction::Unpin { project_id, source_id, all, yes, branches } => {
            let project_id = need(project_id, PROJECT_FLAG);
            if all {
                return clear_pinned(&project_id, &source_id, yes);
            }
            if branches.is_empty() {
                eprintln!("Specify branch names to unpin, or use --all to clear all.");
                std::process::exit(1);
            }
            unpin_branches(&project_id, &source_id, &branches)
        }
    }
}

// ─── ephemeral branches ──────────────────────────────────────────────────────

/// Today's command line never hands this tool its options, so the project it looks up is "undefined".
async fn index_ephemeral_inner(args: IndexEphemeralArgs) -> Result<()> {
    need(args.project_id, PROJECT_FLAG);
    need(args.branch, "--branch <name>");
    let status = registry::embedding_status();
    if status["config_error"] == true {
        bail!("{}", status["config_error_message"].as_str().unwrap_or("embedding config error"));
    }
    bail!("Project 'undefined' not found")
}

pub async fn index_ephemeral(args: IndexEphemeralArgs) {
    finish(index_ephemeral_inner(args).await);
}

async fn drop_ephemeral_inner(store: Store, args: DropEphemeralArgs) -> Result<()> {
    let project_id = need(args.project_id, PROJECT_FLAG);
    let label = need(args.label, "--label <label>");
    let queue = queue_of(store)?;
    let a = json!({ "project_id": project_id, "label": label, "source_id": args.source_id });
    let dropped = ephemeral::drop_label(&queue, &a)?;
    // With a server up the gc runs there; its job row lands in the same database this process reads.
    let job = match live_server().await? {
        Some(port) => {
            let sent = post(port, "/gc", &json!({ "scope": [dropped.project], "sourceId": dropped.source, "mode": "purge" })).await?;
            sent["jobs"][0]["jobId"].as_str().map(String::from)
        }
        None => None,
    };
    let job = job.unwrap_or_else(|| queue.submit(Request { project: dropped.project.clone(), source: Some(dropped.source.clone()), gc_purge: Some(true), ..Default::default() }).job_id);
    show(&ephemeral::drop_result(&queue, &job, &dropped).await)
}

pub async fn drop_ephemeral(store: Store, args: DropEphemeralArgs) {
    finish(drop_ephemeral_inner(store, args).await);
}
