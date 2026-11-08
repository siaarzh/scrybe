//! The job queue and its durable rows. Mirrors `src/daemon/queue.ts`, `src/jobs.ts` and `src/jobs-store.ts`:
//! no two jobs for one project at once, a cap across projects, and rows other processes can read.
//! Not yet: the ticket poller.
use crate::branches::SCHEMA;
use crate::config::data_dir;
use crate::index::{self, Mode, Options};
use crate::registry;
use crate::store::Store;
use anyhow::Result;
use rusqlite::{params, types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const RING_SIZE: usize = 200;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn random_id() -> String {
    let mut bytes = [0u8; 4];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut bytes);
    }
    if bytes == [0; 4] {
        // No /dev/urandom, as on Windows: the clock and a counter are unique enough for a job id.
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let v = (now_ms() as u32).wrapping_mul(2654435761).wrapping_add(N.fetch_add(1, Ordering::SeqCst));
        bytes = v.to_be_bytes();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ─── Durable rows ────────────────────────────────────────────────────────────

pub struct Rows(Mutex<Connection>);

fn sql_to_json(v: SqlValue) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => json!(i),
        SqlValue::Real(f) => json!(f),
        SqlValue::Text(s) => json!(s),
        SqlValue::Blob(_) => Value::Null,
    }
}

impl Rows {
    pub fn open() -> Result<Self> {
        std::fs::create_dir_all(data_dir())?;
        let conn = Connection::open(data_dir().join("branch-tags.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Rows(Mutex::new(conn)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Jobs a dead server left running can never finish.
    pub fn mark_interrupted(&self) -> Result<usize> {
        Ok(self.lock().execute("UPDATE jobs SET status='interrupted', error_message='interrupted by daemon restart', finished_at=?1 WHERE status IN ('running','queued')", [now_ms()])?)
    }

    fn insert_queued(&self, item: &Item) {
        let mode = item.mode_str();
        let _ = self.lock().execute(
            "INSERT INTO jobs (job_id, project_id, source_id, branch, mode, status, phase, queued_at, started_at, finished_at, error_message, origin, type, result) VALUES (?,?,?,?,?,'queued',NULL,?,NULL,NULL,NULL,'daemon','reindex',NULL)",
            params![item.job_id, item.project, item.source, item.branch, mode, now_ms()],
        );
    }

    fn insert_running_all(&self, id: &str, started: i64) {
        let _ = self.lock().execute(
            "INSERT INTO jobs (job_id, project_id, source_id, branch, mode, status, phase, queued_at, started_at, finished_at, error_message, origin, type, result) VALUES (?,'*',NULL,NULL,'incremental','running',NULL,?,?,NULL,NULL,'cli','reindex',NULL)",
            params![id, started, started],
        );
    }

    fn set_started(&self, id: &str, at: i64) {
        let _ = self.lock().execute("UPDATE jobs SET status='running', started_at=? WHERE job_id=?", params![at, id]);
    }

    fn set_phase(&self, id: &str, phase: &str) {
        let _ = self.lock().execute("UPDATE jobs SET phase=? WHERE job_id=?", params![phase, id]);
    }

    fn finish(&self, id: &str, status: &str, at: i64, error: Option<&str>) {
        let _ = self.lock().execute("UPDATE jobs SET status=?, finished_at=?, error_message=? WHERE job_id=?", params![status, at, error, id]);
    }

    pub fn list_branches(&self, project: &str, source: &str) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT DISTINCT branch FROM branch_tags WHERE project_id=? AND source_id=?") else { return vec![] };
        stmt.query_map([project, source], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    pub fn last_indexed_sha(&self, project: &str, source: &str, branch: &str) -> Option<String> {
        self.lock().query_row("SELECT last_indexed_sha FROM branch_state WHERE project_id=? AND source_id=? AND branch=?", [project, source, branch], |r| r.get(0)).ok()
    }

    pub fn set_last_indexed_sha(&self, project: &str, source: &str, branch: &str, sha: &str) {
        let _ = self.lock().execute(
            "INSERT INTO branch_state (project_id, source_id, branch, last_indexed_sha, last_indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, source_id, branch) DO UPDATE SET last_indexed_sha=excluded.last_indexed_sha, last_indexed_at=excluded.last_indexed_at",
            params![project, source, branch, sha, now_ms()],
        );
    }

    pub fn tagged_chunk_ids(&self, project: &str, source: &str) -> HashSet<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=?") else { return HashSet::new() };
        stmt.query_map([project, source], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// `getLastGcTime` with `ignoreDebounceForFailed`: a failed last gc counts as none.
    pub fn last_gc_time(&self, project: &str) -> Option<i64> {
        let conn = self.lock();
        let last: Option<String> = conn.query_row("SELECT status FROM jobs WHERE project_id = ? AND type = 'gc' AND status IN ('done', 'failed') ORDER BY finished_at DESC LIMIT 1", [project], |r| r.get(0)).ok();
        if last.as_deref() == Some("failed") {
            return None;
        }
        conn.query_row("SELECT MAX(finished_at) FROM jobs WHERE project_id = ? AND type = 'gc' AND status = 'done'", [project], |r| r.get::<_, Option<i64>>(0)).ok().flatten()
    }

    /// `listEphemeralBranches`.
    pub fn ephemeral_branches(&self, project: &str, source: &str) -> Vec<String> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT DISTINCT branch FROM branch_tags WHERE project_id=? AND source_id=? AND branch LIKE ? ESCAPE '\\'") else { return vec![] };
        stmt.query_map([project, source, "\\_ephemeral/%"], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// `deleteBranch`, minus the hashes file.
    pub fn delete_branch(&self, project: &str, source: &str, branch: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?", [project, source, branch])?;
        conn.execute("DELETE FROM branch_state WHERE project_id=? AND source_id=? AND branch=?", [project, source, branch])?;
        Ok(())
    }

    fn cancel_queued_gc(&self, project: &str) {
        let _ = self.lock().execute("UPDATE jobs SET status='cancelled', finished_at=? WHERE type='gc' AND status='queued' AND project_id=?", params![now_ms(), project]);
    }

    fn insert_queued_gc(&self, item: &Item) {
        let _ = self.lock().execute(
            "INSERT INTO jobs (job_id, project_id, source_id, branch, mode, status, phase, queued_at, started_at, finished_at, error_message, origin, type, result) VALUES (?,?,?,NULL,'incremental','queued',NULL,?,NULL,NULL,NULL,'daemon','gc',NULL)",
            params![item.job_id, item.project, item.source, now_ms()],
        );
    }

    fn finish_with_result(&self, id: &str, status: &str, at: i64, error: Option<&str>, result: Option<&str>) {
        let _ = self.lock().execute("UPDATE jobs SET status=?, finished_at=?, error_message=?, result=? WHERE job_id=?", params![status, at, error, result, id]);
    }

    fn select(&self, sql: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(sql)?;
        let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
        let rows = stmt.query_map(values, |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), sql_to_json(r.get::<_, SqlValue>(i)?));
            }
            Ok(Value::Object(m))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.select("SELECT * FROM jobs WHERE job_id=?", &[&id]).ok()?.into_iter().next()
    }

    pub fn list(&self, status: Option<&str>, project: Option<&str>) -> Result<Vec<Value>> {
        let mut clauses = vec![];
        let mut vals: Vec<&dyn rusqlite::ToSql> = vec![];
        if let Some(s) = &status {
            clauses.push("status=?");
            vals.push(s);
        }
        if let Some(p) = &project {
            clauses.push("project_id=?");
            vals.push(p);
        }
        let filter = if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
        self.select(&format!("SELECT * FROM jobs {filter} ORDER BY queued_at DESC LIMIT 200"), &vals)
    }

    pub fn queue_status(&self, project: Option<&str>) -> Result<(Vec<Value>, Vec<Value>)> {
        let (filter, vals): (&str, Vec<&dyn rusqlite::ToSql>) = match &project {
            Some(p) => ("AND project_id=?", vec![p]),
            None => ("", vec![]),
        };
        let running = self.select(&format!("SELECT * FROM jobs WHERE status='running' {filter} ORDER BY started_at"), &vals)?;
        let queued = self.select(&format!("SELECT * FROM jobs WHERE status='queued' {filter} ORDER BY queued_at"), &vals)?;
        Ok((running, queued))
    }
}

/// `jobRowToState`.
fn row_to_state(row: &Value) -> Value {
    let mut m = Map::new();
    m.insert("job_id".into(), row["job_id"].clone());
    m.insert("project_id".into(), row["project_id"].clone());
    if !row["source_id"].is_null() {
        m.insert("source_id".into(), row["source_id"].clone());
    }
    m.insert("mode".into(), row["mode"].clone());
    m.insert("status".into(), row["status"].clone());
    m.insert("tasks".into(), json!([]));
    m.insert("started_at".into(), if row["started_at"].is_null() { row["queued_at"].clone() } else { row["started_at"].clone() });
    m.insert("finished_at".into(), row["finished_at"].clone());
    m.insert("error".into(), row["error_message"].clone());
    m.insert("type".into(), if row["type"].is_null() { json!("reindex") } else { row["type"].clone() });
    m.insert("result".into(), row["result"].clone());
    Value::Object(m)
}

// ─── Events ──────────────────────────────────────────────────────────────────

fn log_path() -> PathBuf {
    std::env::var_os("SCRYBE_DAEMON_LOG_PATH").map_or_else(|| data_dir().join("daemon-log.jsonl"), PathBuf::from)
}

fn append_log(line: &str) {
    let path = log_path();
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= MAX_LOG_BYTES) {
        let (a1, a2) = (format!("{}.1", path.display()), format!("{}.2", path.display()));
        let _ = std::fs::rename(&a1, a2);
        let _ = std::fs::rename(&path, a1);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

// ─── The queue ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Item {
    pub job_id: String,
    pub project: String,
    pub source: Option<String>,
    pub branch: Option<String>,
    pub content_ref: Option<String>,
    pub mode: Mode,
    /// A garbage collection job: `Some(true)` removes old versions at once, `Some(false)` keeps a grace.
    pub gc_purge: Option<bool>,
}

impl Item {
    fn mode_str(&self) -> &'static str {
        if self.mode == Mode::Full { "full" } else { "incremental" }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Request {
    pub project: String,
    pub source: Option<String>,
    pub branch: Option<String>,
    pub content_ref: Option<String>,
    pub full: bool,
    pub gc_purge: Option<bool>,
}

/// What a job did, for `onQueueJobEvent` listeners.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobEvent {
    Submitted,
    Completed,
    Failed,
    Cancelled,
}

pub type Hook = Arc<dyn Fn(JobEvent, &Item) + Send + Sync>;

pub struct Submitted {
    pub job_id: String,
    pub status: &'static str,
    pub queue_position: Option<usize>,
    pub duplicate_of_pending: bool,
}

struct State {
    pending: VecDeque<Item>,
    active: HashMap<String, String>,
    /// Every job this process started, with its tasks. Rows have no task detail.
    jobs: HashMap<String, Value>,
    cancels: HashMap<String, Arc<AtomicBool>>,
    ring: VecDeque<Value>,
}

pub struct Queue {
    pub rows: Rows,
    store: Arc<Store>,
    state: Mutex<State>,
    max_concurrent: usize,
    max_depth: usize,
    pub events: broadcast::Sender<String>,
    hooks: Mutex<Vec<Hook>>,
    // Watcher threads submit jobs from outside the runtime, so spawn through a stored handle.
    rt: tokio::runtime::Handle,
}

fn pending_task(source: &str, mode: &str) -> Value {
    json!({ "source_id": source, "mode": mode, "status": "pending", "phase": null, "files_scanned": 0, "chunks_prepared": 0, "started_at": null, "finished_at": null, "error": null })
}

/// `classifyErrorMessage`.
fn classify(message: &str) -> String {
    if message.contains("429") {
        return "Embedding API rate limit exceeded. Wait a minute and retry reindex, or check your embedding provider's rate limit tier (Voyage AI requires a payment method on file to unlock standard limits).".to_string();
    }
    message.to_string()
}

impl Queue {
    pub fn new(store: Arc<Store>) -> Result<Arc<Self>> {
        let env_num = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0);
        let cpus = std::thread::available_parallelism().map_or(2, |n| n.get());
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Queue {
            rows: Rows::open()?,
            store,
            state: Mutex::new(State { pending: VecDeque::new(), active: HashMap::new(), jobs: HashMap::new(), cancels: HashMap::new(), ring: VecDeque::new() }),
            max_concurrent: env_num("SCRYBE_DAEMON_MAX_CONCURRENT").unwrap_or((cpus / 2).max(1)),
            max_depth: env_num("SCRYBE_DAEMON_MAX_QUEUE_DEPTH").unwrap_or(1000),
            events,
            hooks: Mutex::new(Vec::new()),
            rt: tokio::runtime::Handle::current(),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Logged, kept in the ring and streamed.
    pub fn emit(&self, event: Value) {
        append_log(&event.to_string());
        self.push(event);
    }

    /// Kept in the ring and streamed, not logged: how today's server publishes the events outside the queue.
    pub fn push(&self, event: Value) {
        let line = event.to_string();
        {
            let mut st = self.lock();
            st.ring.push_back(event);
            if st.ring.len() > RING_SIZE {
                st.ring.pop_front();
            }
        }
        let _ = self.events.send(line);
    }

    /// `onQueueJobEvent`: every listener sees every event, in the order they were added.
    pub fn add_hook(&self, hook: Hook) {
        self.hooks.lock().unwrap_or_else(|e| e.into_inner()).push(hook);
    }

    fn fire(&self, event: JobEvent, item: &Item) {
        let hooks = self.hooks.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for hook in hooks {
            hook(event, item);
        }
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    /// Runs a task on the server's runtime from a plain thread.
    pub fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(&self, f: F) {
        self.rt.spawn(f);
    }

    pub fn recent_events(&self, last: usize) -> Vec<Value> {
        let st = self.lock();
        st.ring.iter().skip(st.ring.len().saturating_sub(last)).cloned().collect()
    }

    pub fn events_since(&self, since: &str) -> Vec<Value> {
        self.lock().ring.iter().filter(|e| e["ts"].as_str().is_some_and(|t| t > since)).cloned().collect()
    }

    pub fn last_error(&self) -> Value {
        self.lock().ring.iter().rev().find(|e| e["level"] == "error").cloned().unwrap_or(Value::Null)
    }

    pub fn stats(&self) -> Value {
        let st = self.lock();
        json!({ "active": st.active.len(), "pending": st.pending.len(), "maxConcurrent": self.max_concurrent })
    }

    pub fn active_count(&self) -> usize {
        self.lock().active.len()
    }

    /// `submitToQueue`. Returns at once: a job only ever runs in the background.
    pub fn submit(self: &Arc<Self>, req: Request) -> Submitted {
        let job_id = random_id();
        let mode = if req.full { Mode::Full } else { Mode::Incremental };
        {
            let st = self.lock();
            if st.pending.len() >= self.max_depth {
                return Submitted { job_id, status: "rejected", queue_position: None, duplicate_of_pending: false };
            }
        }
        let item = Item { job_id: job_id.clone(), project: req.project, source: req.source, branch: req.branch, content_ref: req.content_ref, mode, gc_purge: req.gc_purge };
        let duplicate = self.lock().pending.iter().any(|p| p.project == item.project && p.source == item.source && p.mode == item.mode && p.branch == item.branch);
        if item.gc_purge.is_some() {
            self.rows.insert_queued_gc(&item);
        } else {
            self.rows.insert_queued(&item);
        }
        self.lock().pending.push_back(item.clone());
        self.fire(JobEvent::Submitted, &item);
        self.drain();
        let st = self.lock();
        if st.active.contains_key(&job_id) || st.jobs.contains_key(&job_id) {
            return Submitted { job_id, status: "running", queue_position: None, duplicate_of_pending: duplicate };
        }
        let position = st.pending.iter().position(|p| p.job_id == job_id);
        Submitted { job_id, status: "queued", queue_position: position, duplicate_of_pending: duplicate }
    }

    fn drain(self: &Arc<Self>) {
        loop {
            let item = {
                let mut st = self.lock();
                if st.active.len() >= self.max_concurrent {
                    return;
                }
                let idx = st.pending.iter().position(|p| !st.active.values().any(|proj| *proj == p.project));
                let Some(idx) = idx else { return };
                let Some(item) = st.pending.remove(idx) else { return };
                item
            };
            let ts = now_iso();
            if registry::get_project(&item.project).is_none() && data_dir().join("projects.json").exists() {
                self.rows.finish(&item.job_id, "failed", now_ms(), Some("project no longer exists"));
                self.emit(json!({ "ts": ts, "level": "warn", "event": "job.failed", "projectId": item.project, "detail": { "jobId": item.job_id, "type": "reindex", "skippedOrphan": true, "reason": "project no longer exists" } }));
                self.fire(JobEvent::Failed, &item);
                continue;
            }
            if item.gc_purge.is_some() {
                self.start_gc(item, ts);
            } else {
                self.start(item, ts);
            }
        }
    }

    /// A manual gc replaces any gc still waiting in its scope. Returns how many it replaced.
    pub fn cancel_pending_gc(&self, scope: &[String]) -> usize {
        let mut st = self.lock();
        let before = st.pending.len();
        st.pending.retain(|p| !(p.gc_purge.is_some() && scope.contains(&p.project)));
        let removed = before - st.pending.len();
        drop(st);
        if removed > 0 {
            for project in scope {
                self.rows.cancel_queued_gc(project);
            }
        }
        removed
    }

    fn start_gc(self: &Arc<Self>, item: Item, ts: String) {
        self.lock().active.insert(item.job_id.clone(), item.project.clone());
        self.rows.set_started(&item.job_id, now_ms());
        let purge = item.gc_purge == Some(true);
        let mut event = json!({ "ts": ts, "level": "info", "event": "job.started", "projectId": item.project });
        if let Some(s) = &item.source {
            event["sourceId"] = json!(s);
        }
        event["detail"] = json!({ "jobId": item.job_id, "type": "gc", "gcMode": if purge { "purge" } else { "grace" } });
        self.emit(event);
        let me = self.clone();
        self.rt.spawn(async move {
            let started = std::time::Instant::now();
            let outcome = me.collect_garbage(&item, purge).await;
            let at = now_ms();
            let mut event = json!({ "ts": now_iso(), "projectId": item.project });
            if let Some(s) = &item.source {
                event["sourceId"] = json!(s);
            }
            let auto;
            match outcome {
                Ok((orphans, freed)) => {
                    let ms = started.elapsed().as_millis() as u64;
                    let result = json!({ "orphans_deleted": orphans, "bytes_freed": freed, "duration_ms": ms });
                    me.rows.finish_with_result(&item.job_id, "done", at, None, Some(&result.to_string()));
                    event["level"] = json!("info");
                    event["event"] = json!("job.completed");
                    event["durationMs"] = json!(ms);
                    event["detail"] = json!({ "jobId": item.job_id, "type": "gc", "orphans_deleted": orphans, "bytes_freed": freed });
                    auto = Some(json!({ "ts": now_iso(), "level": "info", "event": "auto-gc.completed", "projectId": item.project, "durationMs": ms, "detail": { "orphans_deleted": orphans, "bytes_freed": freed, "duration_ms": ms } }));
                    me.fire(JobEvent::Completed, &item);
                }
                Err(e) => {
                    let message = format!("{e:#}");
                    me.rows.finish_with_result(&item.job_id, "failed", at, Some(&message), None);
                    event["level"] = json!("error");
                    event["event"] = json!("job.failed");
                    event["error"] = json!({ "message": message });
                    event["detail"] = json!({ "jobId": item.job_id, "type": "gc" });
                    auto = Some(json!({ "ts": now_iso(), "level": "error", "event": "auto-gc.failed", "projectId": item.project, "error": { "message": message }, "detail": { "error": message } }));
                    me.fire(JobEvent::Failed, &item);
                }
            }
            me.emit(event);
            if let Some(a) = auto.filter(|_| !purge) {
                me.emit(a);
            }
            me.lock().active.remove(&item.job_id);
            me.drain();
        });
    }

    /// `runGcJobHandler`: rows no branch refers to go, then the table is compacted.
    pub async fn collect_garbage(&self, item: &Item, purge: bool) -> Result<(usize, u64)> {
        let project = registry::get_project(&item.project).ok_or_else(|| anyhow::anyhow!("Project '{}' not found", item.project))?;
        let (mut orphans, mut freed) = (0, 0);
        for source in project.sources.iter().filter(|s| item.source.as_ref().is_none_or(|want| *want == s.source_id)) {
            let Some(table) = source.table_name.as_ref().filter(|_| source.kind() == "code") else { continue };
            let tagged = self.rows.tagged_chunk_ids(&item.project, &source.source_id);
            let stale: Vec<String> = self.store.list_chunk_ids(table, &item.project).await?.into_iter().filter(|id| !tagged.contains(id)).collect();
            self.store.delete_chunks(table, &stale).await?;
            orphans += stale.len();
            freed += self.store.compact_measured(table, purge).await?;
        }
        Ok((orphans, freed))
    }

    fn start(self: &Arc<Self>, item: Item, ts: String) {
        let sources: Vec<String> = match (&item.source, registry::get_project(&item.project)) {
            (Some(s), _) => vec![s.clone()],
            (None, Some(p)) => p.sources.iter().map(|s| s.source_id.clone()).collect(),
            (None, None) => vec![],
        };
        let started = now_ms();
        let tasks: Vec<Value> = sources.iter().map(|s| pending_task(s, item.mode_str())).collect();
        let mut state = json!({ "job_id": item.job_id, "project_id": item.project });
        if let Some(s) = &item.source {
            state["source_id"] = json!(s);
        }
        state["mode"] = json!(item.mode_str());
        state["status"] = json!("running");
        state["tasks"] = json!(tasks);
        state["started_at"] = json!(started);
        state["finished_at"] = Value::Null;
        state["error"] = Value::Null;
        if let Some(b) = &item.branch {
            state["branch"] = json!(b);
        }
        if let Some(c) = &item.content_ref {
            state["contentRef"] = json!(c);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut st = self.lock();
            st.active.insert(item.job_id.clone(), item.project.clone());
            st.jobs.insert(item.job_id.clone(), state);
            st.cancels.insert(item.job_id.clone(), cancel.clone());
        }
        self.rows.set_started(&item.job_id, started);
        let mut event = json!({ "ts": ts, "level": "info", "event": "job.started", "projectId": item.project });
        if let Some(s) = &item.source {
            event["sourceId"] = json!(s);
        }
        if let Some(b) = &item.branch {
            event["branch"] = json!(b);
        }
        event["detail"] = json!({ "jobId": item.job_id, "mode": item.mode_str() });
        self.emit(event);
        let me = self.clone();
        self.rt.spawn(async move {
            me.run(item, sources, cancel).await;
        });
    }

    fn update_job(&self, id: &str, f: impl FnOnce(&mut Value)) {
        if let Some(job) = self.lock().jobs.get_mut(id) {
            f(job);
        }
    }

    /// `runTasks`, then the finishing half of `drain`.
    async fn run(self: Arc<Self>, item: Item, sources: Vec<String>, cancel: Arc<AtomicBool>) {
        let options = Options { branch: item.branch.clone(), content_ref: item.content_ref.clone(), cancel: Some(cancel.clone()), job_id: Some(item.job_id.clone()) };
        for (i, source) in sources.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                self.update_job(&item.job_id, |job| {
                    for t in job["tasks"].as_array_mut().into_iter().flatten() {
                        if t["status"] == "pending" || t["status"] == "running" {
                            t["status"] = json!("cancelled");
                            t["finished_at"] = json!(now_ms());
                        }
                    }
                });
                break;
            }
            let at = now_ms();
            self.update_job(&item.job_id, |job| {
                let t = &mut job["tasks"][i];
                t["status"] = json!("running");
                t["started_at"] = json!(at);
                t["phase"] = json!("scanning");
            });
            self.rows.set_phase(&item.job_id, "scanning");
            let result = index::index_source(&self.store, &item.project, source, item.mode, &options).await;
            let done = now_ms();
            self.update_job(&item.job_id, |job| {
                let t = &mut job["tasks"][i];
                t["finished_at"] = json!(done);
                match &result {
                    Ok(r) => {
                        t["status"] = json!("done");
                        t["phase"] = json!("done");
                        t["files_scanned"] = r["files_scanned"].clone();
                        t["chunks_prepared"] = r["chunks_prepared"].clone();
                    }
                    Err(e) if e.to_string() == index::CANCELLED => t["status"] = json!("cancelled"),
                    Err(e) => {
                        t["status"] = json!("failed");
                        t["error"] = json!(classify(&format!("{e:#}")));
                    }
                }
            });
        }
        let finished = now_ms();
        let (status, error) = {
            let mut st = self.lock();
            let job = st.jobs.get_mut(&item.job_id);
            let mut status = "done";
            let mut error = None;
            if let Some(job) = job {
                let tasks = job["tasks"].as_array().cloned().unwrap_or_default();
                if let Some(failed) = tasks.iter().find(|t| t["status"] == "failed") {
                    status = "failed";
                    error = failed["error"].as_str().map(String::from);
                } else if tasks.iter().any(|t| t["status"] == "cancelled") {
                    status = "cancelled";
                }
                job["status"] = json!(status);
                job["finished_at"] = json!(finished);
                job["error"] = error.as_ref().map_or(Value::Null, |e| json!(e));
            }
            st.active.remove(&item.job_id);
            st.cancels.remove(&item.job_id);
            (status, error)
        };
        self.rows.finish(&item.job_id, status, finished, error.as_deref());
        let name = match status {
            "done" => "job.completed",
            "cancelled" => "job.cancelled",
            _ => "job.failed",
        };
        let mut event = json!({ "ts": now_iso(), "level": if status == "failed" { "error" } else { "info" }, "event": name, "projectId": item.project });
        if let Some(s) = &item.source {
            event["sourceId"] = json!(s);
        }
        if let Some(b) = &item.branch {
            event["branch"] = json!(b);
        }
        if let Some(e) = &error {
            event["error"] = json!({ "message": e });
        }
        event["detail"] = json!({ "jobId": item.job_id });
        self.fire(match status { "done" => JobEvent::Completed, "failed" => JobEvent::Failed, _ => JobEvent::Cancelled }, &item);
        self.emit(event);
        self.drain();
    }

    /// `submitAllJob`: every project in turn, outside the queue, one incremental run each.
    pub fn submit_all(self: &Arc<Self>) -> String {
        let id = random_id();
        let started = now_ms();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut st = self.lock();
            st.jobs.insert(id.clone(), json!({ "job_id": id, "project_id": "*", "mode": "incremental", "status": "running", "tasks": [], "started_at": started, "finished_at": null, "error": null }));
            st.cancels.insert(id.clone(), cancel.clone());
        }
        self.rows.insert_running_all(&id, started);
        let (me, job) = (self.clone(), id.clone());
        self.rt.spawn(async move {
            let options = Options { cancel: Some(cancel), ..Default::default() };
            let mut failed = vec![];
            'projects: for p in registry::list_projects() {
                me.update_job(&job, |j| j["current_project"] = json!(p.id));
                for s in &p.sources {
                    if let Err(e) = index::index_source(&me.store, &p.id, &s.source_id, Mode::Incremental, &options).await {
                        if e.to_string() == index::CANCELLED {
                            let at = now_ms();
                            me.update_job(&job, |j| {
                                j["status"] = json!("cancelled");
                                j["finished_at"] = json!(at);
                            });
                            me.rows.finish(&job, "cancelled", at, None);
                            break 'projects;
                        }
                        failed.push(format!("{}: {e:#}", p.id));
                        break;
                    }
                }
            }
            let at = now_ms();
            let error = (!failed.is_empty()).then(|| format!("{} project(s) failed: {}", failed.len(), failed.join("; ")));
            let status = if error.is_some() { "failed" } else { "done" };
            let mut finish = false;
            me.update_job(&job, |j| {
                if j["status"] == "running" {
                    j["status"] = json!(status);
                    j["finished_at"] = json!(at);
                    j["error"] = error.as_ref().map_or(Value::Null, |e| json!(e));
                    if let Some(o) = j.as_object_mut() {
                        o.remove("current_project");
                    }
                    finish = true;
                }
            });
            if finish {
                me.rows.finish(&job, status, at, error.as_deref());
            }
            me.lock().cancels.remove(&job);
        });
        id
    }

    /// `getJobStatus`: this process's detail if it has any, else the durable row.
    pub fn job_status(&self, id: &str) -> Option<Value> {
        if let Some(job) = self.lock().jobs.get(id) {
            return Some(job.clone());
        }
        self.rows.get(id).map(|r| row_to_state(&r))
    }

    /// `listJobs`.
    pub fn list_jobs(&self, status: Option<&str>) -> Result<Vec<Value>> {
        let rows = self.rows.list(status, None)?;
        let st = self.lock();
        Ok(rows.iter().map(|r| r["job_id"].as_str().and_then(|id| st.jobs.get(id)).cloned().unwrap_or_else(|| row_to_state(r))).collect())
    }

    /// `cancelJob`. A job still waiting in the queue can't be cancelled, the same as today.
    pub fn cancel(&self, id: &str, source: Option<&str>) -> bool {
        let st = self.lock();
        let Some(job) = st.jobs.get(id) else { return false };
        if job["status"] != "running" {
            return false;
        }
        if source.is_some() {
            // One source of a job can't be stopped yet, only the whole job.
            return false;
        }
        match st.cancels.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) {
        for flag in self.lock().cancels.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_look_like_todays() {
        let (a, b) = (random_id(), random_id());
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn rows_turn_into_states_like_job_row_to_state() {
        let row = json!({ "job_id": "j", "project_id": "p", "source_id": null, "mode": "full", "status": "done", "queued_at": 5, "started_at": null, "finished_at": 9, "error_message": "e", "type": null, "result": null });
        let s = row_to_state(&row);
        assert_eq!(s["started_at"], 5);
        assert_eq!(s["error"], "e");
        assert_eq!(s["type"], "reindex");
        assert!(s.get("source_id").is_none());
        assert_eq!(s["tasks"], json!([]));
    }

    #[test]
    fn a_rate_limit_gets_the_friendly_message() {
        assert!(classify("Embedding API error (HTTP 429): slow down").starts_with("Embedding API rate limit exceeded"));
        assert_eq!(classify("other"), "other");
    }
}
