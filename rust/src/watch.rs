//! What makes the server index on its own. Mirrors `src/daemon/watcher.ts`, `git-watcher.ts`,
//! `fetch-poller.ts` and `idle-state.ts`: file changes and git ref changes queue an incremental run,
//! and pinned branches follow their remote.
use crate::branches;
use crate::git;
use crate::jobs::{now_iso, Queue, Request};
use crate::jsstr::env_pos_int;
use crate::registry::{self, Project};
use crate::scan::IgnoreRules;
use notify::event::{CreateKind, EventKind, ModifyKind};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 10;
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);
const FETCH_RETRY_BASE: Duration = Duration::from_secs(30);
const FETCH_RETRY_MAX: Duration = Duration::from_secs(600);
const MAX_CONCURRENT_FETCHES: usize = 2;

pub(crate) fn env_ms(name: &str, default: u64) -> Duration {
    Duration::from_millis(env_pos_int(name).map_or(default, |n| n as u64))
}

type OnChange = Arc<dyn Fn(bool) + Send + Sync>;

/// Hot after any event, cold again after a quiet minute. Cold waits longer before acting.
pub struct Idle {
    /// The last event, while hot.
    hot: Mutex<Option<Instant>>,
    hot_for: Duration,
    cold_multiplier: u32,
    on_change: Mutex<Vec<OnChange>>,
    /// The state last told, held while it is told.
    told_hot: Mutex<bool>,
}

impl Idle {
    pub fn from_env() -> Self {
        let multiplier = env_pos_int("SCRYBE_DAEMON_COLD_MULTIPLIER").map_or(5, |n| n as u32);
        Idle { hot: Mutex::new(None), hot_for: env_ms("SCRYBE_DAEMON_HOT_MS", 60_000), cold_multiplier: multiplier, on_change: Mutex::new(vec![]), told_hot: Mutex::new(false) }
    }

    /// Runs `f` on every change, true for hot, like `onStateChange`.
    pub fn add_on_change(&self, f: OnChange) {
        self.on_change.lock().unwrap().push(f);
    }

    /// Tells the state as it is now, so that an event in the instant it turns cold can't be told out of order.
    fn changed(&self) {
        let mut told = self.told_hot.lock().unwrap();
        let hot = self.is_hot();
        if std::mem::replace(&mut *told, hot) == hot {
            return;
        }
        let hooks = self.on_change.lock().unwrap().clone();
        for f in hooks {
            f(hot);
        }
    }

    pub fn touch(self: &Arc<Self>) {
        if self.hot.lock().unwrap().replace(Instant::now()).is_some() {
            return;
        }
        self.changed();
        let me = self.clone();
        spawn_named("idle".into(), move || me.cool());
    }

    /// Waits out the quiet time, then turns cold.
    fn cool(&self) {
        loop {
            let left = {
                let mut hot = self.hot.lock().unwrap();
                let left = hot.map_or(Duration::ZERO, |t| self.hot_for.saturating_sub(t.elapsed()));
                if left.is_zero() {
                    *hot = None;
                }
                left
            };
            if left.is_zero() {
                return self.changed();
            }
            std::thread::sleep(left);
        }
    }

    pub fn is_hot(&self) -> bool {
        self.hot.lock().unwrap().is_some()
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
    stopped: AtomicBool,
}

impl Ctx {
    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn set_health(&self, of: &Mutex<HashMap<String, bool>>, project: &str, healthy: bool) {
        let mut map = of.lock().unwrap();
        if !self.stopped() {
            map.insert(project.to_string(), healthy);
        }
    }

    fn set_branch(&self, project: &str, branch: &str) {
        let mut map = self.health.branch.lock().unwrap();
        if !self.stopped() {
            map.insert(project.to_string(), branch.to_string());
        }
    }
}

/// The watchers and the fetch poller of a running server.
pub struct Watching(Arc<Ctx>);

impl Watching {
    /// From here on nothing is queued or announced, and the threads end when they next wake.
    pub fn stop(&self) {
        self.0.stopped.store(true, Ordering::SeqCst);
        self.0.health.files.lock().unwrap().clear();
        self.0.health.git.lock().unwrap().clear();
        self.0.health.branch.lock().unwrap().clear();
    }
}

fn retry_delay(retries: u32) -> Duration {
    RETRY_BASE.saturating_mul(2u32.saturating_pow(retries)).min(RETRY_MAX)
}

fn watcher_event(ctx: &Ctx, level: &str, project: &str, detail: serde_json::Value) {
    if ctx.stopped() {
        return;
    }
    ctx.queue.push(json!({ "ts": now_iso(), "level": level, "event": "watcher.event", "projectId": project, "detail": detail }));
}

fn enqueue(ctx: &Ctx, project: &str) {
    if !ctx.stopped() {
        ctx.queue.submit(Request { project: project.to_string(), automatic: true, ..Default::default() });
    }
}

fn spawn_named(name: String, f: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name).stack_size(512 << 10).spawn(f);
}

/// `IGNORE_DIR_NAMES`: never watched, but only at the top of the tree.
const NEVER_WATCHED: &[&str] = &[".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".nuxt", "coverage", ".pytest_cache", ".mypy_cache", ".ruff_cache", "target", "bin", "obj", "vendor", ".vs", "android", "ios", "electron", "fastlane", "packages", "TestResults", "publish", "artifacts"];

/// Whether a change at `rel` queues a run: dot-files and folders the indexer skips count too.
fn watched(rel: &str, rules: &IgnoreRules) -> bool {
    !rel.is_empty() && !rel.split('/').next().is_some_and(|top| NEVER_WATCHED.contains(&top)) && !rules.should_ignore(rel)
}

/// `start` and every folder below it whose files could queue a run. On Linux each takes a watch of its own.
fn dirs_to_watch(root: &Path, start: &Path, rules: &IgnoreRules) -> Vec<PathBuf> {
    let mut out = vec![start.to_path_buf()];
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let path = e.path();
            let rel = path.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            if watched(&rel, rules) && !rules.ignores_dir(&rel) {
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

fn brings_folder(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(CreateKind::Folder | CreateKind::Any) | EventKind::Modify(ModifyKind::Name(_)))
}

/// The path relative to `root`. macOS reports real paths (`/private/var/...`), which may not start with `root` as given.
fn relative_to<'a>(path: &'a Path, root: &Path, real_root: &Path) -> Option<&'a Path> {
    path.strip_prefix(root).or_else(|_| path.strip_prefix(real_root)).ok()
}

fn real_path(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn add_file_watches(w: &mut RecommendedWatcher, root: &Path, rules: &IgnoreRules) -> notify::Result<()> {
    if cfg!(target_os = "linux") {
        for dir in dirs_to_watch(root, root, rules) {
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
                ctx.set_health(&ctx.health.files, &project, true);
                retries = 0;
                let reason = pump_files(&ctx, &project, &root, &rules, &mut w, &rx, base);
                if ctx.stopped() {
                    return;
                }
                eprintln!("[scrybe watcher] {project}: {reason}");
                watcher_event(&ctx, "warn", &project, json!({ "error": reason, "retries": retries }));
            }
            Err(e) => {
                eprintln!("[scrybe watcher] {project}: {e}");
                watcher_event(&ctx, "warn", &project, json!({ "error": e.to_string(), "retries": retries }));
            }
        }
        ctx.set_health(&ctx.health.files, &project, false);
        if ctx.stopped() {
            return;
        }
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
    let real_root = real_path(root);
    loop {
        let wait = deadline.map_or(Duration::from_secs(3600), |d| d.saturating_duration_since(Instant::now()));
        let got = rx.recv_timeout(wait);
        if ctx.stopped() {
            return "stopped".to_string();
        }
        match got {
            Ok(Err(e)) => return e.to_string(),
            Ok(Ok(event)) => {
                if !is_change(&event.kind) {
                    continue;
                }
                let mut relevant = false;
                for path in &event.paths {
                    let Some(rel) = relative_to(path, root, &real_root) else { continue };
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if !watched(&rel, rules) {
                        continue;
                    }
                    if cfg!(target_os = "linux") && brings_folder(&event.kind) && path.is_dir() && !path.is_symlink() && !rules.ignores_dir(&rel) {
                        // A folder made here or moved in needs its own watches, and may already hold files.
                        for dir in dirs_to_watch(root, path, rules) {
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
    let real_git_dir = real_path(&git_dir);
    let mut last_branch = branches::resolve_branch_for_path(&root);
    ctx.set_branch(&project, &last_branch);
    let mut retries = 0;
    loop {
        let (tx, rx) = channel();
        match new_watcher(tx).and_then(|mut w| add_git_watches(&mut w, &git_dir).map(|_| w)) {
            Ok(mut w) => {
                ctx.set_health(&ctx.health.git, &project, true);
                retries = 0;
                let mut deadline: Option<Instant> = None;
                let reason = loop {
                    let wait = deadline.map_or(Duration::from_secs(3600), |d| d.saturating_duration_since(Instant::now()));
                    let got = rx.recv_timeout(wait);
                    if ctx.stopped() {
                        return;
                    }
                    match got {
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
                            let relevant = event.paths.iter().any(|p| relative_to(p, &git_dir, &real_git_dir).is_some_and(|r| is_watched_ref(&r.to_string_lossy().replace('\\', "/"))));
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
                                ctx.set_branch(&project, &branch);
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
        ctx.set_health(&ctx.health.git, &project, false);
        if ctx.stopped() {
            return;
        }
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
    let (mut changed, mut out_of_band) = (vec![], 0);
    for branch in &pinned {
        if ctx.stopped() {
            return Ok(());
        }
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
                out_of_band += 1;
                watcher_event(ctx, "info", project, json!({ "phase": "fetch-poller", "outOfBandFetch": true, "branch": remote, "lastSha": sha, "shaAfter": after }));
            }
            _ => {}
        }
        let sub = ctx.queue.submit(Request { project: project.to_string(), source: Some(source.to_string()), branch: Some(branch.clone()), content_ref: Some(remote), automatic: true, ..Default::default() });
        if sub.status == "rejected" {
            return Err(ctx.queue.full());
        }
        changed.push(branch.clone());
    }
    if !changed.is_empty() {
        watcher_event(ctx, "info", project, json!({ "phase": "fetch-poller", "shaChanged": changed }));
    }
    if std::env::var("SCRYBE_DEBUG_FETCH_POLLER").as_deref() == Ok("1") {
        watcher_event(ctx, "info", project, json!({ "phase": "fetch-poller.tick", "branchesPolled": pinned.len(), "deltasFound": changed.len(), "outOfBandDetected": out_of_band }));
    }
    Ok(())
}

fn fetch_loop(ctx: Arc<Ctx>, project: String, source: String, root: PathBuf) {
    let active = env_ms("SCRYBE_DAEMON_FETCH_ACTIVE_MS", 5 * 60_000);
    let idle = env_ms("SCRYBE_DAEMON_FETCH_IDLE_MS", 30 * 60_000);
    let mut retries = 0u32;
    let mut warned = HashSet::new();
    while !ctx.stopped() {
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
pub fn start(queue: Arc<Queue>, idle: Arc<Idle>, health: Arc<WatchHealth>, projects: &[Project]) -> Watching {
    let ctx = Arc::new(Ctx { queue, idle, health, stopped: AtomicBool::new(false) });
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
    Watching(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_files_and_skipped_folders_below_the_top_are_watched() {
        let dir = std::env::temp_dir().join(format!("scrybe-watch-{}", std::process::id()));
        for d in [".github/workflows", "a/node_modules", "node_modules/x", "logs/deep", "vendor", "out/kept"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        std::fs::write(dir.join(".gitignore"), "logs/\nout/*\n!out/kept\nx\n").unwrap();
        let rules = IgnoreRules::load(&dir, None, None);
        for (rel, want) in [(".eslintrc.json", true), (".github/workflows/ci.yml", true), ("a/node_modules/i.js", true), ("node_modules/i.js", false), (".git/HEAD", false), ("vendor", false), ("logs/a.ts", false), ("out/x.ts", false), ("out/kept/a.ts", true), ("", false)] {
            assert_eq!(watched(rel, &rules), want, "{rel}");
        }
        let mut dirs: Vec<String> = dirs_to_watch(&dir, &dir, &rules).iter().map(|d| d.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/")).collect();
        dirs.sort();
        assert_eq!(dirs, ["", ".github", ".github/workflows", "a", "a/node_modules", "out", "out/kept"]);
        let below: Vec<PathBuf> = dirs_to_watch(&dir, &dir.join("a"), &rules);
        assert_eq!(below, [dir.join("a"), dir.join("a").join("node_modules")]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
    fn real_paths_still_count_as_inside_the_root() {
        let (root, real) = (Path::new("/var/folders/x/repo"), Path::new("/private/var/folders/x/repo"));
        assert_eq!(relative_to(Path::new("/private/var/folders/x/repo/src/a.ts"), root, real), Some(Path::new("src/a.ts")));
        assert_eq!(relative_to(Path::new("/var/folders/x/repo/src/a.ts"), root, real), Some(Path::new("src/a.ts")));
        assert_eq!(relative_to(Path::new("/elsewhere/a.ts"), root, real), None);
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
        let idle = Arc::new(Idle { hot: Mutex::new(None), hot_for: Duration::from_secs(60), cold_multiplier: 5, on_change: Mutex::new(vec![]), told_hot: Mutex::new(false) });
        assert!(!idle.is_hot());
        assert_eq!(idle.debounce(Duration::from_secs(1)), Duration::from_secs(5));
        idle.touch();
        assert!(idle.is_hot());
        assert_eq!(idle.debounce(Duration::from_secs(1)), Duration::from_secs(1));
    }

    #[test]
    fn only_a_change_runs_the_hooks() {
        let idle = Arc::new(Idle { hot: Mutex::new(None), hot_for: Duration::from_millis(200), cold_multiplier: 5, on_change: Mutex::new(vec![]), told_hot: Mutex::new(false) });
        let seen = Arc::new(Mutex::new(vec![]));
        let s = seen.clone();
        idle.add_on_change(Arc::new(move |hot| s.lock().unwrap().push(hot)));
        let wait_for = |n: usize| {
            let end = Instant::now() + Duration::from_secs(10);
            while seen.lock().unwrap().len() < n && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
            seen.lock().unwrap().clone()
        };
        idle.touch();
        idle.touch();
        assert_eq!(*seen.lock().unwrap(), [true]);
        assert_eq!(wait_for(2), [true, false]);
        assert!(!idle.is_hot());
        idle.touch();
        assert_eq!(wait_for(4), [true, false, true, false]);
    }
}
