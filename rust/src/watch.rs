//! What makes the server index on its own. Mirrors `src/daemon/watcher.ts`, `git-watcher.ts`,
//! `fetch-poller.ts` and `idle-state.ts`: file changes and git ref changes queue an incremental run,
//! and pinned branches follow their remote.
use crate::branches;
use crate::git;
use crate::jobs::{now_iso, Queue, Request};
use crate::registry::{self, Project};
use crate::scan::{self, IgnoreRules};
use notify::event::{CreateKind, EventKind};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 10;
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);
const FETCH_RETRY_BASE: Duration = Duration::from_secs(30);
const FETCH_RETRY_MAX: Duration = Duration::from_secs(600);
const MAX_CONCURRENT_FETCHES: usize = 2;

fn env_ms(name: &str, default: u64) -> Duration {
    Duration::from_millis(std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(default))
}

/// Hot after any event, cold again after a quiet minute. Cold waits longer before acting.
pub struct Idle {
    last_active: Mutex<Option<Instant>>,
    hot_for: Duration,
    cold_multiplier: u32,
}

impl Idle {
    pub fn from_env() -> Self {
        let multiplier = std::env::var("SCRYBE_DAEMON_COLD_MULTIPLIER").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(5);
        Idle { last_active: Mutex::new(None), hot_for: env_ms("SCRYBE_DAEMON_HOT_MS", 60_000), cold_multiplier: multiplier }
    }

    pub fn touch(&self) {
        *self.last_active.lock().unwrap() = Some(Instant::now());
    }

    pub fn is_hot(&self) -> bool {
        self.last_active.lock().unwrap().is_some_and(|t| t.elapsed() < self.hot_for)
    }

    fn debounce(&self, base: Duration) -> Duration {
        if self.is_hot() { base } else { base * self.cold_multiplier }
    }
}

#[derive(Default)]
pub struct WatchHealth {
    pub files: Mutex<HashMap<String, bool>>,
    pub git: Mutex<HashMap<String, bool>>,
    pub branch: Mutex<HashMap<String, String>>,
}

struct Ctx {
    queue: Arc<Queue>,
    idle: Arc<Idle>,
    health: Arc<WatchHealth>,
}

fn retry_delay(retries: u32) -> Duration {
    RETRY_BASE.saturating_mul(2u32.saturating_pow(retries)).min(RETRY_MAX)
}

fn watcher_event(ctx: &Ctx, level: &str, project: &str, detail: serde_json::Value) {
    ctx.queue.emit(json!({ "ts": now_iso(), "level": level, "event": "watcher.event", "projectId": project, "detail": detail }));
}

fn enqueue(ctx: &Ctx, project: &str) {
    ctx.queue.submit(Request { project: project.to_string(), ..Default::default() });
}

fn spawn_named(name: String, f: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name).stack_size(512 << 10).spawn(f);
}

/// Every folder the indexer would walk. On Linux each one takes a watch of its own, and this keeps
/// `node_modules` and friends from using them up.
fn dirs_to_watch(root: &Path, rules: &IgnoreRules) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let rel = path.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            if !scan::skip_dir(&name) && !rules.should_ignore(&rel) {
                out.push(path.clone());
                stack.push(path);
            }
        }
    }
    out
}

fn new_watcher(tx: Sender<notify::Result<Event>>) -> notify::Result<RecommendedWatcher> {
    RecommendedWatcher::new(move |e| { let _ = tx.send(e); }, Config::default())
}

fn is_change(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_))
}

fn add_file_watches(w: &mut RecommendedWatcher, root: &Path, rules: &IgnoreRules) -> notify::Result<()> {
    if cfg!(target_os = "linux") {
        for dir in dirs_to_watch(root, rules) {
            w.watch(&dir, RecursiveMode::NonRecursive)?;
        }
        Ok(())
    } else {
        w.watch(root, RecursiveMode::Recursive)
    }
}

fn watch_files(ctx: Arc<Ctx>, project: String, source: String, root: PathBuf) {
    let base = env_ms("SCRYBE_DAEMON_FS_DEBOUNCE_MS", 1500);
    let mut retries = 0;
    loop {
        let (tx, rx) = channel();
        let rules = IgnoreRules::load(&root, Some(&project), Some(&source));
        let setup = new_watcher(tx).and_then(|mut w| add_file_watches(&mut w, &root, &rules).map(|_| w));
        match setup {
            Ok(mut w) => {
                ctx.health.files.lock().unwrap().insert(project.clone(), true);
                retries = 0;
                let reason = pump_files(&ctx, &project, &root, &rules, &mut w, &rx, base);
                eprintln!("[scrybe watcher] {project}: {reason}");
                watcher_event(&ctx, "warn", &project, json!({ "error": reason, "retries": retries }));
            }
            Err(e) => {
                eprintln!("[scrybe watcher] {project}: {e}");
                watcher_event(&ctx, "warn", &project, json!({ "error": e.to_string(), "retries": retries }));
            }
        }
        ctx.health.files.lock().unwrap().insert(project.clone(), false);
        if retries >= MAX_RETRIES {
            ctx.queue.emit(json!({ "ts": now_iso(), "level": "error", "event": "watcher.unhealthy", "projectId": project, "error": { "message": format!("Watcher gave up after {MAX_RETRIES} retries") } }));
            return;
        }
        std::thread::sleep(retry_delay(retries));
        retries += 1;
    }
}

/// Runs until the watcher fails. Gathers changes until they go quiet, then queues one run.
fn pump_files(ctx: &Ctx, project: &str, root: &Path, rules: &IgnoreRules, w: &mut RecommendedWatcher, rx: &Receiver<notify::Result<Event>>, base: Duration) -> String {
    let mut pending: HashSet<String> = HashSet::new();
    let mut deadline: Option<Instant> = None;
    loop {
        let wait = deadline.map_or(Duration::from_secs(3600), |d| d.saturating_duration_since(Instant::now()));
        match rx.recv_timeout(wait) {
            Ok(Err(e)) => return e.to_string(),
            Ok(Ok(event)) => {
                if !is_change(&event.kind) {
                    continue;
                }
                let mut relevant = false;
                for path in &event.paths {
                    let Ok(rel) = path.strip_prefix(root) else { continue };
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if rel.is_empty() || rel.split('/').any(scan::skip_dir) || rules.should_ignore(&rel) {
                        continue;
                    }
                    if cfg!(target_os = "linux") && matches!(event.kind, EventKind::Create(CreateKind::Folder) | EventKind::Create(CreateKind::Any)) && path.is_dir() {
                        // A new folder needs its own watches, and may already hold files.
                        for dir in dirs_to_watch(path, rules) {
                            let _ = w.watch(&dir, RecursiveMode::NonRecursive);
                        }
                    }
                    pending.insert(rel);
                    relevant = true;
                }
                if relevant {
                    ctx.idle.touch();
                    deadline = Some(Instant::now() + ctx.idle.debounce(base));
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if deadline.is_some() && !pending.is_empty() {
                    let paths: Vec<String> = pending.drain().collect();
                    watcher_event(ctx, "info", project, json!({ "paths": paths, "count": paths.len() }));
                    enqueue(ctx, project);
                }
                deadline = None;
            }
            Err(RecvTimeoutError::Disconnected) => return "watcher stopped".to_string(),
        }
    }
}

/// The real .git directory: a plain folder, a symlink, or a worktree's `gitdir:` file.
fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let git = root.join(".git");
    let meta = std::fs::symlink_metadata(&git).ok()?;
    if meta.is_dir() {
        return Some(git);
    }
    if meta.file_type().is_symlink() {
        return std::fs::canonicalize(git).ok();
    }
    let text = std::fs::read_to_string(&git).ok()?;
    let target = root.join(text.trim().strip_prefix("gitdir:")?.trim());
    target.exists().then_some(target)
}

fn is_watched_ref(rel: &str) -> bool {
    matches!(rel, "HEAD" | "packed-refs" | "FETCH_HEAD" | "ORIG_HEAD") || rel.starts_with("refs/heads/") || rel.starts_with("refs/remotes/")
}

fn add_git_watches(w: &mut RecommendedWatcher, git_dir: &Path) -> notify::Result<()> {
    if !cfg!(target_os = "linux") {
        return w.watch(git_dir, RecursiveMode::Recursive);
    }
    // .git/objects alone would take hundreds of watches, and nothing in it matters here.
    w.watch(git_dir, RecursiveMode::NonRecursive)?;
    let mut stack = vec![git_dir.join("refs")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        w.watch(&dir, RecursiveMode::NonRecursive)?;
        stack.extend(entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
    }
    Ok(())
}

fn watch_git(ctx: Arc<Ctx>, project: String, root: PathBuf) {
    let Some(git_dir) = resolve_git_dir(&root) else { return };
    let debounce = env_ms("SCRYBE_DAEMON_GIT_DEBOUNCE_MS", 300);
    let mut last_branch = branches::resolve_branch_for_path(&root);
    ctx.health.branch.lock().unwrap().insert(project.clone(), last_branch.clone());
    let mut retries = 0;
    loop {
        let (tx, rx) = channel();
        match new_watcher(tx).and_then(|mut w| add_git_watches(&mut w, &git_dir).map(|_| w)) {
            Ok(mut w) => {
                ctx.health.git.lock().unwrap().insert(project.clone(), true);
                retries = 0;
                let mut deadline: Option<Instant> = None;
                let reason = loop {
                    let wait = deadline.map_or(Duration::from_secs(3600), |d| d.saturating_duration_since(Instant::now()));
                    match rx.recv_timeout(wait) {
                        Ok(Err(e)) => break e.to_string(),
                        Ok(Ok(event)) => {
                            if !is_change(&event.kind) {
                                continue;
                            }
                            // A new remote or nested branch folder needs a watch of its own.
                            for path in &event.paths {
                                if cfg!(target_os = "linux") && path.is_dir() && path.starts_with(git_dir.join("refs")) {
                                    let _ = add_git_watches(&mut w, &git_dir);
                                }
                            }
                            let relevant = event.paths.iter().any(|p| p.strip_prefix(&git_dir).is_ok_and(|r| is_watched_ref(&r.to_string_lossy().replace('\\', "/"))));
                            if relevant {
                                deadline = Some(Instant::now() + debounce);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if deadline.take().is_some() {
                                let branch = branches::resolve_branch_for_path(&root);
                                let changed = branch != last_branch;
                                let mut detail = json!({ "branch": branch, "branchChanged": changed });
                                if changed {
                                    detail["prevBranch"] = json!(last_branch);
                                }
                                last_branch = branch.clone();
                                ctx.health.branch.lock().unwrap().insert(project.clone(), branch);
                                ctx.idle.touch();
                                watcher_event(&ctx, "info", &project, detail);
                                enqueue(&ctx, &project);
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => break "watcher stopped".to_string(),
                    }
                };
                eprintln!("[scrybe git-watcher] {project}: {reason}");
                watcher_event(&ctx, "warn", &project, json!({ "error": reason, "retries": retries }));
            }
            Err(e) => {
                eprintln!("[scrybe git-watcher] {project}: {e}");
                watcher_event(&ctx, "warn", &project, json!({ "error": e.to_string(), "retries": retries }));
            }
        }
        ctx.health.git.lock().unwrap().insert(project.clone(), false);
        if retries >= MAX_RETRIES {
            ctx.queue.emit(json!({ "ts": now_iso(), "level": "error", "event": "watcher.unhealthy", "projectId": project, "error": { "message": format!("Git watcher gave up after {MAX_RETRIES} retries") } }));
            return;
        }
        std::thread::sleep(retry_delay(retries));
        retries += 1;
    }
}

static ACTIVE_FETCHES: AtomicUsize = AtomicUsize::new(0);

fn remote_sha(root: &Path, git_ref: &str) -> Option<String> {
    git::trimmed(root, &["rev-parse", git_ref]).filter(|s| !s.is_empty())
}

/// One round: fetch, then queue every pinned branch that moved or was never indexed.
fn poll_project(ctx: &Ctx, project: &str, source: &str, root: &Path, warned: &mut HashSet<String>) -> Result<(), String> {
    let Some(src) = registry::get_project(project).and_then(|p| p.sources.into_iter().find(|s| s.source_id == source)) else { return Ok(()) };
    let pinned = src.pinned_branches.unwrap_or_default();
    if pinned.is_empty() {
        return Ok(());
    }
    let before: HashMap<String, Option<String>> = pinned.iter().map(|b| (b.clone(), remote_sha(root, &format!("origin/{b}")))).collect();
    let indexed: HashSet<String> = ctx.queue.rows.list_branches(project, source).into_iter().collect();
    if !git::run_with_timeout(root, &["fetch", "origin", "--prune", "--quiet"], Duration::from_secs(120)) {
        return Err(format!("git fetch failed for {project}"));
    }
    let mut changed = vec![];
    for branch in &pinned {
        let remote = format!("origin/{branch}");
        let Some(after) = remote_sha(root, &remote) else {
            if warned.insert(branch.clone()) {
                watcher_event(ctx, "warn", project, json!({ "phase": "fetch-poller", "missingRemote": remote }));
            }
            continue;
        };
        let last = ctx.queue.rows.last_indexed_sha(project, source, branch);
        match last {
            None if indexed.contains(branch) => {
                // Chunks but no recorded commit: an old index. Take today's as the baseline.
                ctx.queue.rows.set_last_indexed_sha(project, source, branch, &after);
                continue;
            }
            Some(ref sha) if *sha == after => continue,
            Some(ref sha) if before.get(branch).and_then(|b| b.as_deref()) == Some(after.as_str()) => {
                watcher_event(ctx, "info", project, json!({ "phase": "fetch-poller", "outOfBandFetch": true, "branch": remote, "lastSha": sha, "shaAfter": after }));
            }
            _ => {}
        }
        ctx.queue.submit(Request { project: project.to_string(), source: Some(source.to_string()), branch: Some(branch.clone()), content_ref: Some(remote), full: false, gc_purge: None });
        changed.push(branch.clone());
    }
    if !changed.is_empty() {
        watcher_event(ctx, "info", project, json!({ "phase": "fetch-poller", "shaChanged": changed }));
    }
    Ok(())
}

fn fetch_loop(ctx: Arc<Ctx>, project: String, source: String, root: PathBuf) {
    let active = env_ms("SCRYBE_DAEMON_FETCH_ACTIVE_MS", 5 * 60_000);
    let idle = env_ms("SCRYBE_DAEMON_FETCH_IDLE_MS", 30 * 60_000);
    let mut retries = 0u32;
    let mut warned = HashSet::new();
    loop {
        if ACTIVE_FETCHES.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_FETCHES {
            ACTIVE_FETCHES.fetch_sub(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        let result = poll_project(&ctx, &project, &source, &root, &mut warned);
        ACTIVE_FETCHES.fetch_sub(1, Ordering::SeqCst);
        match result {
            Ok(()) => {
                retries = 0;
                std::thread::sleep(if ctx.idle.is_hot() { active } else { idle });
            }
            Err(e) => {
                retries += 1;
                watcher_event(&ctx, "warn", &project, json!({ "error": e, "phase": "fetch-poller", "retries": retries }));
                std::thread::sleep(FETCH_RETRY_BASE.saturating_mul(2u32.saturating_pow(retries - 1)).min(FETCH_RETRY_MAX));
            }
        }
    }
}

/// Starts everything for every registered project. One code source per project is watched, like today.
pub fn start(queue: Arc<Queue>, idle: Arc<Idle>, health: Arc<WatchHealth>, projects: &[Project]) {
    let ctx = Arc::new(Ctx { queue, idle, health });
    let skip_fetch = std::env::var("SCRYBE_DAEMON_NO_FETCH").as_deref() == Ok("1");
    for p in projects {
        if let Some((s, root)) = p.sources.iter().find_map(|s| (s.kind() == "code").then(|| s.root_path().map(|r| (s, PathBuf::from(r)))).flatten()) {
            let (c, id, sid, r) = (ctx.clone(), p.id.clone(), s.source_id.clone(), root.clone());
            spawn_named(format!("watch-{id}"), move || watch_files(c, id, sid, r));
            let (c, id, r) = (ctx.clone(), p.id.clone(), root);
            spawn_named(format!("git-{id}"), move || watch_git(c, id, r));
        }
        if !skip_fetch {
            for s in p.sources.iter().filter(|s| s.kind() == "code") {
                let Some(root) = s.root_path().map(PathBuf::from) else { continue };
                let (c, id, sid) = (ctx.clone(), p.id.clone(), s.source_id.clone());
                spawn_named(format!("fetch-{id}"), move || fetch_loop(c, id, sid, root));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ref_changes_count() {
        for yes in ["HEAD", "packed-refs", "FETCH_HEAD", "ORIG_HEAD", "refs/heads/main", "refs/heads/a/b", "refs/remotes/origin/x"] {
            assert!(is_watched_ref(yes), "{yes}");
        }
        for no in ["index", "objects/ab/cd", "logs/HEAD", "refs/tags/v1", "COMMIT_EDITMSG"] {
            assert!(!is_watched_ref(no), "{no}");
        }
    }

    #[test]
    fn retries_back_off_up_to_the_ceiling() {
        assert_eq!(retry_delay(0), Duration::from_secs(5));
        assert_eq!(retry_delay(3), Duration::from_secs(40));
        assert_eq!(retry_delay(10), RETRY_MAX);
        assert_eq!(retry_delay(40), RETRY_MAX);
    }

    #[test]
    fn a_cold_server_waits_longer() {
        let idle = Idle { last_active: Mutex::new(None), hot_for: Duration::from_secs(60), cold_multiplier: 5 };
        assert!(!idle.is_hot());
        assert_eq!(idle.debounce(Duration::from_secs(1)), Duration::from_secs(5));
        idle.touch();
        assert!(idle.is_hot());
        assert_eq!(idle.debounce(Duration::from_secs(1)), Duration::from_secs(1));
    }
}
