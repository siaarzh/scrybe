//! The `gc`, `ignore` and `daemon` commands. Mirrors the same-named commands in `src/cli.ts`.
use crate::cli::{finish, need, say, show};
use crate::jobs::Queue;
use crate::jsstr::js_trim;
use crate::store::Store;
use crate::{config, manage, registry, tools};
use anyhow::{anyhow, Result};
use clap::{Args, Subcommand};
use serde_json::{json, Value};
use std::io::{BufRead, IsTerminal, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROJECT_FLAG: &str = "-P, --project-id <id>";
const SOURCE_FLAG: &str = "-S, --source-id <id>";
/// The budget `daemon up` gives a cold start.
const COLD_START_WAIT: Duration = Duration::from_secs(15);

#[derive(Args)]
pub struct GcArgs {
    /// Limit GC to a specific project (default: all projects)
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
    /// Report orphans without deleting
    #[arg(long)]
    dry_run: bool,
}

#[derive(Subcommand)]
pub enum IgnoreAction {
    /// Edit private ignore rules for a source (interactive)
    Edit,
    /// List private ignore files across registered projects
    List {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
    },
    /// Print the private ignore file content for a source
    Get {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id")]
        source_id: Option<String>,
        /// Machine-readable output (includes path + rule_count)
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum DaemonAction {
    /// Gracefully stop the running daemon
    Stop {
        /// Abandon the drain: send a second SIGTERM so the daemon exits immediately
        #[arg(long)]
        force: bool,
    },
    /// Trigger an incremental reindex job in the running daemon
    Refresh {
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(short = 'S', long = "source-id", value_name = "id")]
        source_id: Option<String>,
        #[arg(long, value_name = "branch")]
        branch: Option<String>,
        #[arg(long, value_name = "mode", default_value = "incremental")]
        mode: String,
    },
    /// Run the daemon attached to this terminal
    Start,
    /// Stop and restart the daemon (attached, like start)
    Restart {
        /// Abandon the drain: send a second SIGTERM so the old daemon exits immediately
        #[arg(long)]
        force: bool,
    },
    /// [deprecated] Use `scrybe status` instead
    Status {
        /// Live dashboard (not available in this build)
        #[arg(long)]
        watch: bool,
    },
    /// Start the daemon if not running (idempotent, quiet by default)
    #[command(alias = "ensure-running")]
    Up {
        /// Print status to stdout
        #[arg(long)]
        verbose: bool,
    },
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

pub(crate) fn pidfile() -> Option<(i64, i64)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(config::data_dir().join("daemon.pid")).ok()?).ok()?;
    Some((v["pid"].as_i64()?, v["port"].as_i64()?))
}

fn remove_pidfile() {
    let _ = std::fs::remove_file(config::data_dir().join("daemon.pid"));
}

pub(crate) fn client(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().no_proxy().timeout(timeout).build()?)
}

#[derive(PartialEq)]
enum Probe {
    Healthy,
    Timeout,
    Refused,
}

/// `probeHealthOnce`: only a 2xx answer is healthy; a port that takes the connection and then stalls is busy, not gone.
async fn probe_once(port: i64, timeout: Duration) -> Probe {
    let Ok(port) = u16::try_from(port) else { return Probe::Refused };
    if port == 0 {
        return Probe::Refused;
    }
    match client(timeout).unwrap_or_default().get(format!("http://127.0.0.1:{port}/health")).send().await {
        Ok(r) if r.status().is_success() => Probe::Healthy,
        Ok(_) => Probe::Refused,
        Err(e) if e.is_timeout() => Probe::Timeout,
        Err(_) => Probe::Refused,
    }
}

/// `probeHealthRetried`: three probes over about a second before a port counts as gone.
async fn probe_retried(port: i64) -> Probe {
    for i in 0..3 {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
        let r = probe_once(port, Duration::from_secs(2)).await;
        if r != Probe::Refused {
            return r;
        }
    }
    Probe::Refused
}

#[cfg(unix)]
fn pid_alive(pid: i64) -> bool {
    let Ok(raw) = i32::try_from(pid) else { return false };
    if raw <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { libc::kill(raw, 0) } != 0 {
        let code = std::io::Error::last_os_error().raw_os_error();
        return code == Some(libc::EPERM) || code == Some(libc::EACCES);
    }
    if cfg!(target_os = "linux") {
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{raw}/stat")) {
            return stat.rfind(')').and_then(|i| stat.get(i + 2..)).and_then(|r| r.split_whitespace().next()) != Some("Z");
        }
    }
    true
}

/// `isPidAlive`: a process that is still running, not one that has exited and is waiting to be reaped.
#[cfg(windows)]
fn pid_alive(pid: i64) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    let Ok(raw) = u32::try_from(pid) else { return false };
    if raw == 0 {
        return false;
    }
    // SAFETY: plain Win32 calls on a handle opened here and closed here.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, raw);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code == STILL_ACTIVE
    }
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: i64) -> bool {
    false
}

enum Sent {
    Ok,
    Gone,
    Failed(String),
}

#[cfg(unix)]
fn signal(pid: i64, sig: i32) -> Sent {
    let Ok(raw) = i32::try_from(pid) else { return Sent::Failed("bad pid".into()) };
    // SAFETY: plain signal send to a pid read from our own pidfile.
    if unsafe { libc::kill(raw, sig) } == 0 {
        return Sent::Ok;
    }
    let e = std::io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::ESRCH) => Sent::Gone,
        Some(libc::EPERM) => Sent::Failed("kill EPERM".into()),
        _ => Sent::Failed(e.to_string()),
    }
}

/// Windows has no SIGTERM: like Node's `process.kill`, both signals end the process outright.
#[cfg(windows)]
fn signal(pid: i64, _sig: i32) -> Sent {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let Ok(raw) = u32::try_from(pid) else { return Sent::Failed("bad pid".into()) };
    // SAFETY: plain Win32 calls on a handle opened here and closed here.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, raw);
        if handle.is_null() {
            return match GetLastError() {
                ERROR_INVALID_PARAMETER => Sent::Gone,
                code => Sent::Failed(format!("kill failed (error {code})")),
            };
        }
        let ended = TerminateProcess(handle, 1) != 0;
        let code = GetLastError();
        CloseHandle(handle);
        if ended { Sent::Ok } else { Sent::Failed(format!("kill failed (error {code})")) }
    }
}

#[cfg(not(any(unix, windows)))]
fn signal(_pid: i64, _sig: i32) -> Sent {
    Sent::Failed("stopping a daemon is not available on this platform".into())
}

#[cfg(unix)]
const TERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const TERM: i32 = 15;
#[cfg(not(unix))]
const KILL: i32 = 9;

/// `isDaemonRunning`: a live pid with a healthy or busy port. A live pid with no listener is killed and its pidfile cleared.
pub(crate) async fn running() -> Option<(i64, i64)> {
    let (pid, port) = pidfile()?;
    if !pid_alive(pid) {
        remove_pidfile();
        return None;
    }
    if probe_retried(port).await != Probe::Refused {
        return Some((pid, port));
    }
    let _ = signal(pid, KILL);
    remove_pidfile();
    None
}

/// A string option counts as given when it is not empty.
fn given(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

fn confirm(prompt: &str) -> Result<bool> {
    print!("{prompt}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(js_trim(&line).to_lowercase() == "y")
}

// ─── gc ──────────────────────────────────────────────────────────────────────

pub(crate) fn fmt_size(bytes: u64) -> String {
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", tools::fixed1(b / 1024.0))
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{} MB", tools::fixed1(b / (1024.0 * 1024.0)))
    } else {
        format!("{:.2} GB", b / (1024.0 * 1024.0 * 1024.0))
    }
}

fn plural(n: u64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// The route through a live server. False means the server wasn't there or didn't answer, and the caller runs the gc itself.
async fn gc_via_server(projects: &[registry::Project]) -> bool {
    let Some((_, port)) = pidfile().filter(|(_, port)| *port > 0) else { return false };
    let Ok(http) = client(Duration::from_secs(2)) else { return false };
    if !http.get(format!("http://127.0.0.1:{port}/health")).send().await.is_ok_and(|r| r.status().is_success()) {
        return false;
    }
    let scope: Vec<&str> = projects.iter().map(|p| p.id.as_str()).collect();
    let Ok(res) = http.post(format!("http://127.0.0.1:{port}/gc")).json(&json!({ "scope": scope, "mode": "purge" })).send().await else { return false };
    let Ok(result) = res.json::<Value>().await else { return false };
    let Some(jobs) = result["jobs"].as_array() else { return false };
    if result["cancelledPending"].as_u64().unwrap_or(0) > 0 {
        println!("Cancelled {} pending auto-gc job(s) (preempted by manual gc).", result["cancelledPending"]);
    }
    println!("Submitted gc job(s) for {} project(s) via daemon queue:", jobs.len());
    for j in jobs {
        println!("  {}: job {} ({})", j["projectId"].as_str().unwrap_or(""), j["jobId"].as_str().unwrap_or(""), j["status"].as_str().unwrap_or("queued"));
    }
    println!("Run 'scrybe job list' to monitor progress.");
    true
}

/// Projects with no sources: listed on a dry run, offered for removal when a person is at the terminal.
async fn prune_empty(queue: &Arc<Queue>, dry_run: bool) -> Result<()> {
    let empty: Vec<String> = registry::list_projects().into_iter().filter(|p| p.sources.is_empty()).map(|p| p.id).collect();
    if empty.is_empty() {
        return Ok(());
    }
    let ids = empty.join(", ");
    if dry_run {
        println!("\nDry run: {} empty project(s) would be pruned: {ids}", empty.len());
    } else if std::io::stdin().is_terminal() && confirm(&format!("\nPrune {} empty project(s) ({ids})? [y/N] ", empty.len()))? {
        for id in &empty {
            let _ = manage::remove_project(queue, id).await;
        }
        println!("Pruned {} empty project(s).", empty.len());
    }
    Ok(())
}

async fn gc_inner(store: Store, args: GcArgs) -> Result<()> {
    let only = given(&args.project_id).map(String::from);
    let projects = match &only {
        Some(id) => match registry::get_project(id) {
            Some(p) => vec![p],
            None => {
                eprintln!("Project '{id}' not found");
                std::process::exit(1);
            }
        },
        None => registry::list_projects(),
    };
    if projects.is_empty() {
        say("No projects registered.");
        return Ok(());
    }
    let store = Arc::new(store);
    let queue = Queue::new(store.clone())?;
    if !args.dry_run && gc_via_server(&projects).await {
        if only.is_none() {
            prune_empty(&queue, false).await?;
        }
        return Ok(());
    }
    let (mut found, mut deleted) = (0, 0);
    for p in &projects {
        for s in &p.sources {
            let Some(table) = s.table_name.as_ref().filter(|_| s.kind() == "code") else { continue };
            let tagged = queue.rows.tagged_chunk_ids(&p.id, &s.source_id);
            let orphans: Vec<String> = store.list_chunk_ids(table, &p.id).await?.into_iter().filter(|id| !tagged.contains(id)).collect();
            if orphans.is_empty() {
                continue;
            }
            found += orphans.len();
            println!("  {}/{}: {} orphan chunk(s)", p.id, s.source_id, orphans.len());
            if !args.dry_run {
                store.delete_chunks(table, &orphans).await?;
                deleted += orphans.len();
            }
        }
    }
    if found == 0 {
        println!("No orphan chunks found.");
    } else if args.dry_run {
        println!("\nDry run: {found} orphan chunk(s) found (not deleted).");
    } else {
        println!("\nGC complete: {deleted} orphan chunk(s) deleted.");
    }
    if !args.dry_run {
        compact_all(&store, &projects).await;
    }
    if only.is_none() {
        prune_empty(&queue, args.dry_run).await?;
    }
    Ok(())
}

/// Full-purge compaction of every table, with no grace period: the user asked for the space back.
async fn compact_all(store: &Arc<Store>, projects: &[registry::Project]) {
    let tables: Vec<(&str, &str, &str)> = projects.iter().flat_map(|p| p.sources.iter().filter_map(move |s| s.table_name.as_deref().map(|t| (p.id.as_str(), s.source_id.as_str(), t)))).collect();
    if tables.is_empty() {
        return;
    }
    println!("\nCompacting Lance tables...");
    let mut rows = vec![];
    for (project, source, table) in tables {
        let Ok(report) = store.compact_report(table, true).await else { continue };
        let (removed, freed) = store.prune_index_orphans_measured(table);
        rows.push((project, source, report, removed as u64, freed));
    }
    let (real, idle): (Vec<_>, Vec<_>) = rows.iter().partition(|(_, _, r, removed, _)| r.had_real_work || *removed > 0);
    for (project, source, r, removed, freed) in &real {
        let mut detail = vec![];
        if r.fragments_merged > 0 {
            detail.push(format!("{} merged", plural(r.fragments_merged, "fragment")));
        }
        if r.versions_pruned > 0 {
            detail.push(format!("{} pruned", plural(r.versions_pruned, "version")));
        }
        if *removed > 0 {
            detail.push(format!("{} FTS", plural(*removed, "orphan")));
        }
        let detail = if detail.is_empty() { String::new() } else { format!("   ({})", detail.join(", ")) };
        println!("  {project}/{source}    {} reclaimed{detail}", fmt_size(r.bytes_freed + freed));
    }
    if !idle.is_empty() {
        if real.is_empty() {
            println!("  all {} {} already compact", idle.len(), if idle.len() == 1 { "table" } else { "tables" });
        } else {
            println!("  …{} more already compact", idle.len());
        }
    }
    let real_bytes: u64 = real.iter().map(|(_, _, r, _, freed)| r.bytes_freed + freed).sum();
    let overhead: u64 = idle.iter().map(|(_, _, r, _, _)| r.bytes_freed).sum();
    let overhead = if overhead > 0 { format!(" · {} manifest overhead", fmt_size(overhead)) } else { String::new() };
    if real.is_empty() {
        println!("Done. 0 B reclaimed{overhead}.");
    } else {
        println!("Done. Reclaimed {} across {} of {} tables{overhead}.", fmt_size(real_bytes), real.len(), rows.len());
    }
}

pub async fn gc(store: Store, args: GcArgs) {
    finish(gc_inner(store, args).await);
}

// ─── ignore ──────────────────────────────────────────────────────────────────

fn ignore_inner(action: Option<IgnoreAction>) -> Result<()> {
    match action {
        None | Some(IgnoreAction::Edit) => {
            eprintln!("[scrybe] The ignore editor is not available in this build yet. Use 'ignore list' and 'ignore get'.");
            std::process::exit(1);
        }
        Some(IgnoreAction::List { project_id, json }) => {
            let mut a = serde_json::Map::new();
            if let Some(id) = given(&project_id) {
                a.insert("project_id".into(), json!(id));
            }
            let entries = manage::list_private_ignores(&Value::Object(a))?;
            if json {
                return show(&entries);
            }
            let entries = entries.as_array().cloned().unwrap_or_default();
            if entries.is_empty() {
                say("No private ignore files.");
            }
            for e in &entries {
                let modified = e["mtime"].as_str().map_or(String::new(), |m| format!(" (modified {m})"));
                println!("{}/{} — {} rule(s){modified}", e["project_id"].as_str().unwrap_or(""), e["source_id"].as_str().unwrap_or(""), e["rule_count"]);
                println!("  {}", e["path"].as_str().unwrap_or(""));
            }
            Ok(())
        }
        Some(IgnoreAction::Get { project_id, source_id, json }) => {
            let (project_id, source_id) = (need(project_id, PROJECT_FLAG), need(source_id, SOURCE_FLAG));
            let got = manage::get_private_ignore(&json!({ "project_id": project_id, "source_id": source_id }))?;
            if json {
                return show(&got);
            }
            match got["content"].as_str() {
                None => {
                    println!("# No private ignore file for {project_id}/{source_id}");
                    println!("# Expected at: {}", got["path"].as_str().unwrap_or(""));
                }
                Some(c) => {
                    print!("{c}");
                    if !c.ends_with('\n') {
                        println!();
                    }
                }
            }
            Ok(())
        }
    }
}

pub fn ignore(action: Option<IgnoreAction>) {
    finish(ignore_inner(action));
}

// ─── daemon ──────────────────────────────────────────────────────────────────

/// `stopDaemonGracefully`: SIGTERM, wait; with `force` a second SIGTERM and a longer wait. Err is (reason, detail).
pub(crate) async fn stop_gracefully(pid: i64, force: bool) -> Result<(), (&'static str, String)> {
    let wait_for_death = |ms: u64| async move {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < deadline {
            if !pid_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        !pid_alive(pid)
    };
    let cleanup = || {
        if pidfile().is_none_or(|(p, _)| p == pid) {
            remove_pidfile();
        }
    };
    if let Sent::Failed(m) = signal(pid, TERM) {
        return Err(("signal-failed", m));
    }
    if wait_for_death(5000).await {
        cleanup();
        return Ok(());
    }
    if !force {
        return Err(("still-draining", format!("PID {pid} is still draining — it finishes in-flight work before exiting (up to SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS, 30 min by default)")));
    }
    if let Sent::Failed(m) = signal(pid, TERM) {
        return Err(("signal-failed", m));
    }
    if wait_for_death(10_000).await {
        cleanup();
        return Ok(());
    }
    Err(("still-draining", format!("PID {pid} is still alive after two SIGTERMs")))
}

async fn stop(force: bool) -> Result<()> {
    let Some((pid, _)) = running().await else {
        say("Daemon is not running.");
        return Ok(());
    };
    match stop_gracefully(pid, force).await {
        Ok(()) => say("Daemon stopped."),
        Err(("still-draining", _)) => {
            println!("Stop requested. Daemon (PID {pid}) is still draining — it finishes in-flight work before exiting.\n  Check progress: scrybe status\n  Don't wait:     scrybe daemon stop --force");
            std::process::exit(3);
        }
        Err((_, detail)) => {
            eprintln!("[scrybe] Daemon (PID {pid}) did NOT stop.\n[scrybe] {detail}\n[scrybe] Could not signal the process — check permissions.\n");
            std::process::exit(1);
        }
    }
    Ok(())
}

async fn refresh(project_id: Option<String>, source_id: Option<String>, branch: Option<String>, mode: String) -> Result<()> {
    let Some((_, port)) = pidfile().filter(|(_, port)| *port > 0) else {
        eprintln!("Daemon is not running (no pidfile or port not yet bound).");
        std::process::exit(1);
    };
    let mut body = serde_json::Map::new();
    for (key, value) in [("projectId", given(&project_id)), ("sourceId", given(&source_id)), ("branch", given(&branch)), ("mode", Some(mode.as_str()).filter(|m| !m.is_empty()))] {
        if let Some(v) = value {
            body.insert(key.into(), json!(v));
        }
    }
    let sent = client(Duration::from_secs(5))?.post(format!("http://127.0.0.1:{port}/kick")).json(&Value::Object(body)).send().await;
    let res = match sent {
        Ok(r) => r,
        Err(e) => {
            let why = if e.is_timeout() { "The operation was aborted due to timeout" } else { "fetch failed" };
            eprintln!("Failed to reach daemon: {why}");
            std::process::exit(1);
        }
    };
    if !res.status().is_success() {
        let status = res.status().as_u16();
        eprintln!("Daemon returned {status}: {}", res.text().await.unwrap_or_default());
        std::process::exit(1);
    }
    show(&res.json::<Value>().await.map_err(|e| anyhow!("Failed to reach daemon: {e}"))?)
}

pub(crate) fn in_container() -> bool {
    std::path::Path::new("/.dockerenv").exists()
        || std::fs::read_to_string("/proc/1/cgroup").is_ok_and(|c| c.contains("docker") || c.contains("kubepods") || c.contains("lxc"))
        || std::env::var_os("WSL_DISTRO_NAME").is_some()
}

/// On Windows a child inherits every inheritable handle, so it would hold this process's own output pipes open after it exits.
#[cfg(windows)]
fn stop_inheriting_std_handles() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: the handles are this process's own standard ones.
        unsafe {
            let handle = GetStdHandle(id);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// The Rust server, detached from this terminal and with no output of its own.
fn spawn_server() -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
        stop_inheriting_std_handles();
    }
    cmd.spawn().map(|_| ())
}

/// `ensureRunning` as `daemon up` uses it: Ok(draining) once a server answers, Err(reason) otherwise.
async fn ensure_running(budget: Duration) -> Result<bool, &'static str> {
    if std::env::var("SCRYBE_NO_AUTO_DAEMON").as_deref() == Ok("1") {
        return Err("opted-out");
    }
    if in_container() {
        return Err("container");
    }
    let deadline = Instant::now() + budget;
    let (mut spawned, mut draining) = (false, false);
    loop {
        let port = pidfile().map(|(_, port)| port).filter(|p| *p > 0);
        let up = match port {
            Some(port) => {
                let left = deadline.saturating_duration_since(Instant::now()).clamp(Duration::from_millis(250), Duration::from_secs(2));
                let res = client(left).unwrap_or_default().get(format!("http://127.0.0.1:{port}/health")).send().await;
                match res {
                    Ok(r) if r.status().is_success() => {
                        if r.json::<Value>().await.is_ok_and(|h| h["draining"] == true) {
                            draining = true;
                            false
                        } else {
                            return Ok(false);
                        }
                    }
                    _ => false,
                }
            }
            None => false,
        };
        if !up && !draining && !spawned {
            spawn_server().map_err(|_| "spawn-failed")?;
            spawned = true;
        }
        if Instant::now() >= deadline {
            return if draining { Ok(true) } else { Err("health-timeout") };
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn up(verbose: bool) -> Result<()> {
    match ensure_running(COLD_START_WAIT).await {
        Ok(draining) => {
            if verbose {
                say(if draining { "Daemon is draining — a replacement will start on the next call." } else { "Daemon is running." });
            }
        }
        Err(reason @ ("opted-out" | "container")) => {
            if verbose {
                println!("Skipping daemon start ({reason}).");
            }
        }
        Err(reason) => {
            eprintln!("[scrybe] Daemon did not become healthy ({reason}).\n[scrybe] Diagnose with: scrybe doctor\n");
            std::process::exit(1);
        }
    }
    Ok(())
}

/// `daemon start`: refuse if one runs, else serve in this terminal.
async fn start(store: Store) -> Result<()> {
    if running().await.is_some() {
        eprintln!("[scrybe] Daemon is already running. Use 'scrybe status' to check.");
        std::process::exit(1);
    }
    crate::serve::serve(store).await
}

/// `daemon restart`: stop the running one, then serve in this terminal like `start`.
async fn restart(store: Store, force: bool) -> Result<()> {
    if let Some((pid, _)) = running().await {
        if let Err((reason, detail)) = stop_gracefully(pid, force).await {
            let drain = if reason == "still-draining" { "[scrybe] It is finishing an in-flight reindex. Check: scrybe status  ·  Don't wait: scrybe daemon restart --force\n" } else { "" };
            eprintln!("[scrybe] Cannot restart: the running daemon (PID {pid}) did not stop.\n[scrybe] {detail}\n{drain}");
            std::process::exit(1);
        }
    }
    crate::serve::serve(store).await
}

/// The deprecated `daemon status`: the server's own status as one line of JSON.
async fn old_status(watch: bool) -> Result<()> {
    eprintln!("[scrybe] 'daemon status' is deprecated — use 'scrybe status' instead (will be removed in v2.0)");
    if watch {
        crate::status::no_dashboard();
    }
    let Some((_, port)) = pidfile().filter(|(_, port)| *port > 0) else {
        say("Daemon is not running.");
        return Ok(());
    };
    let got = match client(Duration::from_secs(5))?.get(format!("http://127.0.0.1:{port}/status")).send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        _ => None,
    };
    match got {
        Some(s) => say(&serde_json::to_string(&s)?),
        None => say("Daemon is not running."),
    }
    Ok(())
}

pub async fn daemon(store: Store, action: DaemonAction) {
    finish(match action {
        DaemonAction::Start => start(store).await,
        DaemonAction::Restart { force } => restart(store, force).await,
        DaemonAction::Status { watch } => old_status(watch).await,
        DaemonAction::Stop { force } => stop(force).await,
        DaemonAction::Refresh { project_id, source_id, branch, mode } => refresh(project_id, source_id, branch, mode).await,
        DaemonAction::Up { verbose } => up(verbose).await,
    });
}
