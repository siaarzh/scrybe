//! The job queue and its durable rows. Mirrors `src/daemon/queue.ts`, `src/jobs.ts` and `src/jobs-store.ts`:
//! no two jobs for one project at once, a cap across projects, and rows other processes can read.
//! Not yet: the ticket poller.
use crate::branches;
use crate::config::data_dir;
use crate::index::{self, Mode, Options};
use crate::registry;
use crate::span::Span;
use crate::store::{Fault, Health, Store};
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

pub(crate) fn random_id() -> String {
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

#[derive(Debug, PartialEq)]
pub struct Reconciled {
    pub interrupted: usize,
    pub cancelled: usize,
    pub sample: Vec<String>,
}

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
        Ok(Rows(Mutex::new(branches::open_rw(&data_dir().join("branch-tags.db"))?)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `reconcileOrphanedJobs`: closes jobs queued before `before_ms`, `interrupted`, or `cancelled` if the project is
    /// gone. With no project list to go by, nothing counts as gone.
    pub fn reconcile(&self, before_ms: i64, projects: Option<&[String]>) -> Result<Reconciled> {
        const PENDING: &str = "status IN ('queued','running') AND queued_at < ?";
        let (registered, removed, ids) = match projects {
            Some(p) => {
                // "*" is the project of a job over every project.
                let ids: Vec<&str> = p.iter().map(String::as_str).chain(["*"]).collect();
                let marks = vec!["?"; ids.len()].join(",");
                (format!("project_id IN ({marks})"), format!("project_id NOT IN ({marks})"), ids)
            }
            None => ("1".into(), "0".into(), vec![]),
        };
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let sample: Vec<String> = {
            let mut stmt = tx.prepare(&format!("SELECT job_id FROM jobs WHERE {PENDING} ORDER BY queued_at LIMIT 5"))?;
            let rows = stmt.query_map([before_ms], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let now = now_ms();
        let close = |status: &str, message: &str, which: &str| -> Result<usize> {
            let mut vals: Vec<&dyn rusqlite::ToSql> = vec![&now, &before_ms];
            vals.extend(ids.iter().map(|id| id as &dyn rusqlite::ToSql));
            Ok(tx.execute(&format!("UPDATE jobs SET status='{status}', error_message='{message}', finished_at=? WHERE {PENDING} AND {which}"), &vals[..])?)
        };
        let interrupted = close("interrupted", "interrupted by daemon restart", &registered)?;
        let cancelled = close("cancelled", "project no longer exists (zombie cleanup)", &removed)?;
        tx.commit()?;
        Ok(Reconciled { interrupted, cancelled, sample })
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

    /// Queued and running jobs of a project, as (job id, status).
    pub fn open_jobs(&self, project: &str) -> Vec<(String, String)> {
        let conn = self.lock();
        let Ok(mut stmt) = conn.prepare("SELECT job_id, status FROM jobs WHERE project_id = ? AND status IN ('queued', 'running')") else { return vec![] };
        stmt.query_map([project], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Closes a job of a removed project. False when the row couldn't be updated.
    pub fn cancel_removed(&self, job: &str) -> bool {
        self.lock().execute("UPDATE jobs SET status='cancelled', error_message='project removed', finished_at=? WHERE job_id=?", params![now_ms(), job]).is_ok()
    }

    /// The SQLite half of `wipeSource`.
    pub fn wipe_source(&self, project: &str, source: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM branch_tags WHERE project_id=? AND source_id=?", [project, source])?;
        conn.execute("DELETE FROM branch_state WHERE project_id=? AND source_id=?", [project, source])?;
        Ok(())
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

    /// `getAllChunkIdsForSource`. A failed read is an error, never "no tags": gc deletes what isn't listed.
    pub fn tagged_chunk_ids(&self, project: &str, source: &str) -> Result<HashSet<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=?")?;
        let rows = stmt.query_map([project, source], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// `getLastGcTime` as `status` calls it: when the last good gc finished, whatever came after.
    pub fn last_good_gc(&self, project: &str) -> Option<i64> {
        self.lock().query_row("SELECT MAX(finished_at) FROM jobs WHERE project_id = ? AND type = 'gc' AND status = 'done'", [project], |r| r.get::<_, Option<i64>>(0)).ok().flatten()
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

    /// `getChunkIdsForBranch(...).size > 0`.
    pub fn branch_has_chunks(&self, project: &str, source: &str, branch: &str) -> bool {
        self.lock().query_row("SELECT 1 FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? LIMIT 1", [project, source, branch], |_| Ok(())).is_ok()
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

pub(crate) fn append_log(line: &str) {
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

/// `diagEmit`: one line in the server log, stamped with the time and this process.
pub(crate) fn diag(record: Value) {
    let mut line = Map::new();
    line.insert("ts".into(), json!(now_iso()));
    line.insert("pid".into(), json!(std::process::id()));
    for (k, v) in record.as_object().into_iter().flatten() {
        line.insert(k.clone(), v.clone());
    }
    append_log(&Value::Object(line).to_string());
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
    /// Started by the server itself (a watcher or poller): it gets no durable row.
    pub automatic: bool,
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

/// A job that holds its project.
struct Active {
    project: String,
    gc: bool,
}

/// The flags that stop a running job: the whole of it, and each source's own.
#[derive(Default)]
struct Cancels {
    job: Arc<AtomicBool>,
    tasks: Vec<(String, Arc<AtomicBool>)>,
}

impl Cancels {
    fn all(&self) {
        self.job.store(true, Ordering::SeqCst);
        for (_, task) in &self.tasks {
            task.store(true, Ordering::SeqCst);
        }
    }
}

struct State {
    pending: VecDeque<Item>,
    active: HashMap<String, Active>,
    /// Every job this process started, with its tasks. Rows have no task detail.
    jobs: HashMap<String, Value>,
    cancels: HashMap<String, Cancels>,
    ring: VecDeque<Value>,
}

impl State {
    /// The next job that may run, marked active in the same step: none while the cap is reached or its project is busy.
    fn take_next(&mut self, cap: usize) -> Option<Item> {
        if self.active.len() >= cap {
            return None;
        }
        let idx = self.pending.iter().position(|p| !self.active.values().any(|a| a.project == p.project))?;
        let item = self.pending.remove(idx)?;
        self.active.insert(item.job_id.clone(), Active { project: item.project.clone(), gc: item.gc_purge.is_some() });
        Some(item)
    }

    /// `cancelJob`: a running job, or one source of it that hasn't ended yet.
    fn cancel(&mut self, id: &str, source: Option<&str>) -> bool {
        let Some(job) = self.jobs.get_mut(id).filter(|j| j["status"] == "running") else { return false };
        let Some(cancels) = self.cancels.get(id) else { return false };
        let Some(source) = source.filter(|s| !s.is_empty()) else {
            cancels.all();
            return true;
        };
        let task = job["tasks"].as_array_mut().and_then(|tasks| tasks.iter_mut().find(|t| t["source_id"] == source));
        let Some(task) = task.filter(|t| t["status"] == "pending" || t["status"] == "running") else { return false };
        task["status"] = json!("cancelled");
        task["finished_at"] = json!(now_ms());
        if let Some((_, flag)) = cancels.tasks.iter().find(|(s, _)| s == source) {
            flag.store(true, Ordering::SeqCst);
        }
        true
    }
}

/// What a full run of a project without naming its sources is refused with.
pub const FULL_NEEDS_SOURCES: &str = "full reindex requires explicit source_ids";

/// How often a running job's memory is read for its record.
const SPAN_POLL: std::time::Duration = std::time::Duration::from_millis(200);

/// `resolveReindexProvider`: where the job's first source embeds, when that can be told.
fn provider_of(project: &str, source: Option<&str>) -> Option<&'static str> {
    let project = registry::get_project(project)?;
    let source = match source {
        Some(id) => project.sources.iter().find(|s| s.source_id == id)?,
        None => project.sources.first()?,
    };
    registry::resolve_embedding(source).ok().map(|e| if e.local { "local" } else { "api" })
}

/// A panic counts as the work's own error.
pub(crate) async fn caught<T>(work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    use futures::FutureExt;
    std::panic::AssertUnwindSafe(work).catch_unwind().await.unwrap_or_else(|p| {
        let text = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned());
        Err(anyhow::anyhow!("{}", text.unwrap_or_else(|| "the job stopped unexpectedly".into())))
    })
}

pub struct Queue {
    pub rows: Rows,
    store: Arc<Store>,
    state: Mutex<State>,
    max_concurrent: usize,
    max_depth: usize,
    pub events: broadcast::Sender<String>,
    stopped: AtomicBool,
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
        let env_num = |k: &str| crate::jsstr::env_pos_int(k).map(|n| n as usize);
        let cpus = std::thread::available_parallelism().map_or(2, |n| n.get());
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Queue {
            rows: Rows::open()?,
            store,
            state: Mutex::new(State { pending: VecDeque::new(), active: HashMap::new(), jobs: HashMap::new(), cancels: HashMap::new(), ring: VecDeque::new() }),
            max_concurrent: env_num("SCRYBE_DAEMON_MAX_CONCURRENT").unwrap_or((cpus / 2).max(1)),
            max_depth: env_num("SCRYBE_DAEMON_MAX_QUEUE_DEPTH").unwrap_or(1000),
            events,
            stopped: AtomicBool::new(false),
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
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hook(event, item)));
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

    /// Jobs waiting, and the most that may wait.
    pub fn depth(&self) -> (usize, usize) {
        (self.lock().pending.len(), self.max_depth)
    }

    /// Whether a job still waits for its turn.
    pub fn is_waiting(&self, id: &str) -> bool {
        self.lock().pending.iter().any(|p| p.job_id == id)
    }

    /// The error of a job the full queue turned away, as `enqueue` rejects.
    pub fn full(&self) -> String {
        let (pending, max) = self.depth();
        format!("Queue at capacity ({pending}/{max})")
    }

    pub fn active_count(&self) -> usize {
        self.lock().active.len()
    }

    /// `getActiveReindexCount`: garbage collection isn't counted.
    pub fn active_reindexes(&self) -> usize {
        self.lock().active.values().filter(|a| !a.gc).count()
    }

    /// `submitToQueue`. Returns at once: a job only ever runs in the background.
    pub fn submit(self: &Arc<Self>, req: Request) -> Submitted {
        let job_id = random_id();
        let mode = if req.full { Mode::Full } else { Mode::Incremental };
        {
            let st = self.lock();
            if st.pending.len() >= self.max_depth {
                let depth = st.pending.len();
                drop(st);
                let detail = json!({ "currentDepth": depth, "maxDepth": self.max_depth, "projectId": req.project, "sourceId": req.source, "type": if req.gc_purge.is_some() { "gc" } else { "reindex" } });
                diag(json!({ "event": "queue.backpressure", "level": "warn", "detail": detail }));
                return Submitted { job_id, status: "rejected", queue_position: None, duplicate_of_pending: false };
            }
        }
        let item = Item { job_id: job_id.clone(), project: req.project, source: req.source.filter(|s| !s.is_empty()), branch: req.branch, content_ref: req.content_ref, mode, gc_purge: req.gc_purge };
        let duplicate = self.lock().pending.iter().any(|p| p.project == item.project && p.source == item.source && p.mode == item.mode && p.branch == item.branch);
        if item.gc_purge.is_some() {
            self.rows.insert_queued_gc(&item);
        } else if !req.automatic {
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
            if self.is_stopped() {
                return;
            }
            let Some(item) = self.lock().take_next(self.max_concurrent) else { return };
            let ts = now_iso();
            if registry::get_project(&item.project).is_none() && data_dir().join("projects.json").exists() {
                self.rows.finish(&item.job_id, "failed", now_ms(), Some("project no longer exists"));
                self.emit(json!({ "ts": ts, "level": "warn", "event": "job.failed", "projectId": item.project, "detail": { "jobId": item.job_id, "type": "reindex", "skippedOrphan": true, "reason": "project no longer exists" } }));
                self.fire(JobEvent::Failed, &item);
                self.lock().active.remove(&item.job_id);
                continue;
            }
            if item.gc_purge.is_none() && item.mode == Mode::Full && item.source.is_none() {
                self.rows.finish(&item.job_id, "failed", now_ms(), Some(FULL_NEEDS_SOURCES));
                self.emit(json!({ "ts": ts, "level": "error", "event": "job.failed", "projectId": item.project, "error": { "message": FULL_NEEDS_SOURCES }, "detail": { "jobId": item.job_id } }));
                self.fire(JobEvent::Failed, &item);
                self.lock().active.remove(&item.job_id);
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
            let outcome = caught(me.collect_garbage(&item, purge)).await;
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
                    let (checker, checked) = (me.clone(), item.clone());
                    me.rt.spawn(async move { checker.check_after_gc(&checked, purge).await });
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

    /// The server's look at its tables when it starts: each corrupt one is announced.
    pub async fn check_tables(&self) {
        for project in registry::list_projects() {
            for (source, table, fault) in self.corrupt_sources(&project, None).await {
                self.emit(json!({ "ts": now_iso(), "level": "warn", "event": "health.corrupt", "projectId": project.id, "sourceId": source, "detail": { "tableName": table, "reasons": [fault.reason], "details": fault.details } }));
            }
        }
    }

    /// Looks again after a gc: a table corrupt now was damaged by it.
    async fn check_after_gc(&self, item: &Item, purge: bool) {
        let Some(project) = registry::get_project(&item.project) else { return };
        for (source, table, fault) in self.corrupt_sources(&project, item.source.as_deref()).await {
            let detail = json!({ "tableName": table, "reasons": [fault.reason], "details": fault.details, "gcJobId": item.job_id, "gcMode": if purge { "purge" } else { "grace" } });
            self.emit(json!({ "ts": now_iso(), "level": "error", "event": "health.post-gc-corruption-detected", "projectId": item.project, "sourceId": source, "detail": detail }));
        }
    }

    async fn corrupt_sources(&self, project: &registry::Project, only: Option<&str>) -> Vec<(String, String, Fault)> {
        let mut out = vec![];
        for s in project.sources.iter().filter(|s| only.is_none_or(|o| o == s.source_id)) {
            let (Some(table), Ok(emb)) = (&s.table_name, registry::resolve_embedding(s)) else { continue };
            let dim = index::expected_dimensions(&emb, s.profile() == Some("text"));
            if let Health::Corrupt(fault) = self.store.table_health(table, Some(dim), true).await {
                out.push((s.source_id.clone(), table.clone(), fault));
            }
        }
        out
    }

    /// `runGcJobHandler`: rows no branch refers to go, then the table is compacted.
    pub async fn collect_garbage(&self, item: &Item, purge: bool) -> Result<(usize, u64)> {
        let project = registry::get_project(&item.project).ok_or_else(|| anyhow::anyhow!("Project '{}' not found", item.project))?;
        let (mut orphans, mut freed) = (0, 0);
        for source in project.sources.iter().filter(|s| item.source.as_ref().is_none_or(|want| *want == s.source_id)) {
            let Some(table) = source.table_name.as_ref().filter(|_| source.kind() == "code") else { continue };
            let present = self.store.list_chunk_ids(table, &item.project).await?;
            let tagged = self.rows.tagged_chunk_ids(&item.project, &source.source_id)?;
            let stale: Vec<String> = present.into_iter().filter(|id| !tagged.contains(id)).collect();
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
        let cancels = Cancels { job: Arc::default(), tasks: sources.iter().map(|s| (s.clone(), Arc::default())).collect() };
        let (cancel, tasks) = (cancels.job.clone(), cancels.tasks.clone());
        {
            let mut st = self.lock();
            st.jobs.insert(item.job_id.clone(), state);
            st.cancels.insert(item.job_id.clone(), cancels);
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
            me.run(item, tasks, cancel, started).await;
        });
    }

    fn update_job(&self, id: &str, f: impl FnOnce(&mut Value)) {
        if let Some(job) = self.lock().jobs.get_mut(id) {
            f(job);
        }
    }

    /// The `onDownloadProgress`, `onScanProgress` and `onEmbedProgress` handlers of `runTasks`. Only the
    /// moves into downloading and embedding reach the stored row; scan counts live in memory.
    fn on_progress(&self, job_id: &str, task: usize, p: index::Progress) {
        let mut persist = None;
        self.update_job(job_id, |job| {
            let t = &mut job["tasks"][task];
            match p {
                index::Progress::Download(percent) => {
                    if t["phase"] != "downloading-model" {
                        t["phase"] = json!("downloading-model");
                        persist = Some("downloading-model");
                    }
                    t["percent"] = json!(percent);
                }
                index::Progress::Scan(n) => {
                    t["files_scanned"] = json!(n);
                    t["phase"] = json!("scanning");
                }
                index::Progress::Embed(n) => {
                    t["chunks_prepared"] = json!(n);
                    if t["phase"] != "embedding" {
                        t["phase"] = json!("embedding");
                        if let Some(o) = t.as_object_mut() {
                            o.remove("percent");
                        }
                        persist = Some("embedding");
                    }
                }
            }
        });
        if let Some(phase) = persist {
            self.rows.set_phase(job_id, phase);
        }
    }

    /// `runTasks`, then the finishing half of `drain`.
    async fn run(self: Arc<Self>, item: Item, tasks: Vec<(String, Arc<AtomicBool>)>, cancel: Arc<AtomicBool>, started: i64) {
        let mut span = Span::start();
        let provider = provider_of(&item.project, item.source.as_deref());
        let options = Options { branch: item.branch.clone(), content_ref: item.content_ref.clone(), cancel: None, job_id: Some(item.job_id.clone()), progress: None };
        for (i, (source, task_cancel)) in tasks.iter().enumerate() {
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
            let mut waiting = false;
            self.update_job(&item.job_id, |job| {
                let t = &mut job["tasks"][i];
                waiting = t["status"] == "pending";
                if waiting {
                    t["status"] = json!("running");
                    t["started_at"] = json!(at);
                    t["phase"] = json!("scanning");
                }
            });
            if !waiting {
                continue;
            }
            self.rows.set_phase(&item.job_id, "scanning");
            let (me, job_id) = (self.clone(), item.job_id.clone());
            let sink = index::ProgressSink(Arc::new(move |p| me.on_progress(&job_id, i, p)));
            let options = Options { progress: Some(sink), cancel: Some(task_cancel.clone()), ..options.clone() };
            let work = caught(index::index_source(&self.store, &item.project, source, item.mode, &options));
            let result = span.watch(SPAN_POLL, work).await;
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
            st.cancels.remove(&item.job_id);
            (status, error)
        };
        // The row first: a server on its way out leaves as soon as nothing is active.
        self.rows.finish(&item.job_id, status, finished, error.as_deref());
        self.lock().active.remove(&item.job_id);
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
        let outcome = match status { "done" => "ok", "cancelled" => "cancelled", _ => "error" };
        let mut record = json!({ "event": "activity-span", "level": "info", "spanType": "reindex", "projectId": item.project, "sourceId": item.source, "jobId": item.job_id, "mode": item.mode_str(), "durationMs": finished - started, "outcome": outcome });
        if let Some(o) = record.as_object_mut() {
            span.close(o);
            o.insert("provider".into(), json!(provider));
        }
        diag(record);
        self.drain();
    }

    /// `submitAllJob`: every project in turn, outside the queue, one incremental run each.
    pub fn submit_all(self: &Arc<Self>) -> String {
        let id = random_id();
        let started = now_ms();
        let cancels = Cancels::default();
        let cancel = cancels.job.clone();
        {
            let mut st = self.lock();
            st.jobs.insert(id.clone(), json!({ "job_id": id, "project_id": "*", "mode": "incremental", "status": "running", "tasks": [], "started_at": started, "finished_at": null, "error": null }));
            st.cancels.insert(id.clone(), cancels);
        }
        self.rows.insert_running_all(&id, started);
        let (me, job) = (self.clone(), id.clone());
        self.rt.spawn(async move {
            let options = Options { cancel: Some(cancel), ..Default::default() };
            let mut failed = vec![];
            'projects: for p in registry::list_projects() {
                me.update_job(&job, |j| j["current_project"] = json!(p.id));
                for s in &p.sources {
                    if let Err(e) = caught(index::index_source(&me.store, &p.id, &s.source_id, Mode::Incremental, &options)).await {
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
        self.lock().cancel(id, source)
    }

    /// `stopQueue` and `cancelAllJobs`: nothing starts from here on, and what runs is told to stop.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        for cancels in self.lock().cancels.values() {
            cancels.all();
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows_with(pending: &[(&str, &str, &str, i64)]) -> (Rows, std::path::PathBuf) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("scrybe-jobs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rows = Rows(Mutex::new(branches::open_rw(&dir.join("branch-tags.db")).unwrap()));
        for (id, project, status, queued) in pending {
            rows.lock().execute("INSERT INTO jobs (job_id, project_id, mode, status, queued_at, origin) VALUES (?,?,'incremental',?,?,'daemon')", params![id, project, status, queued]).unwrap();
        }
        (rows, dir)
    }

    #[test]
    fn jobs_an_earlier_server_left_are_closed_and_later_ones_kept() {
        let pending = [("live-run", "live", "running", 90), ("live-q", "live", "queued", 80), ("gone-run", "gone", "running", 70), ("gone-q", "gone", "queued", 60), ("all-run", "*", "running", 50), ("live-new", "live", "running", 110), ("gone-new", "gone", "queued", 120)];
        let (rows, dir) = rows_with(&pending);
        let projects = ["live".to_string()];
        let done = rows.reconcile(100, Some(&projects)).unwrap();
        assert_eq!(done, Reconciled { interrupted: 3, cancelled: 2, sample: ["all-run", "gone-q", "gone-run", "live-q", "live-run"].map(String::from).to_vec() });
        let got = |id: &str| { let r = rows.get(id).unwrap(); (r["status"].as_str().unwrap().to_string(), r["error_message"].as_str().map(String::from)) };
        assert_eq!(got("all-run"), ("interrupted".into(), Some("interrupted by daemon restart".into())));
        assert_eq!(got("gone-q"), ("cancelled".into(), Some("project no longer exists (zombie cleanup)".into())));
        assert_eq!((got("live-new").0.as_str(), got("gone-new").0.as_str()), ("running", "queued"));
        assert!(rows.get("live-q").unwrap()["finished_at"].is_i64());
        assert_eq!(rows.reconcile(100, Some(&projects)).unwrap(), Reconciled { interrupted: 0, cancelled: 0, sample: vec![] });
        drop(rows);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_project_list_cancels_nothing_and_an_empty_one_cancels_all() {
        let (rows, dir) = rows_with(&[("a", "live", "running", 1)]);
        assert_eq!(rows.reconcile(100, None).unwrap().interrupted, 1);
        drop(rows);
        let _ = std::fs::remove_dir_all(&dir);
        let (rows, dir) = rows_with(&[("a", "live", "queued", 1)]);
        assert_eq!(rows.reconcile(100, Some(&[])).unwrap().cancelled, 1);
        drop(rows);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tags_that_cannot_be_read_are_an_error_and_not_an_empty_set() {
        let (rows, dir) = rows_with(&[]);
        assert!(rows.tagged_chunk_ids("p", "s").unwrap().is_empty());
        rows.lock().execute("INSERT INTO branch_tags VALUES ('p','s','b','f','c',1,2)", []).unwrap();
        assert_eq!(rows.tagged_chunk_ids("p", "s").unwrap().len(), 1);
        rows.lock().execute("INSERT INTO branch_tags VALUES ('p','s','b','f',x'00',1,2)", []).unwrap();
        assert!(rows.tagged_chunk_ids("p", "s").is_err(), "an unreadable row");
        rows.lock().execute("DROP TABLE branch_tags", []).unwrap();
        assert!(rows.tagged_chunk_ids("p", "s").is_err(), "no table");
        drop(rows);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn waiting(jobs: &[(&str, &str)]) -> State {
        let item = |id: &str, project: &str| Item { job_id: id.into(), project: project.into(), source: None, branch: None, content_ref: None, mode: Mode::Incremental, gc_purge: None };
        State { pending: jobs.iter().map(|(id, p)| item(id, p)).collect(), active: HashMap::new(), jobs: HashMap::new(), cancels: HashMap::new(), ring: VecDeque::new() }
    }

    #[test]
    fn taking_a_job_holds_its_project_and_its_place_under_the_cap_at_once() {
        let mut st = waiting(&[("1", "a"), ("2", "a"), ("3", "b"), ("4", "c")]);
        let next = |st: &mut State| st.take_next(2).map(|i| i.job_id);
        assert_eq!(next(&mut st).as_deref(), Some("1"));
        assert_eq!(next(&mut st).as_deref(), Some("3"), "project a is busy");
        assert_eq!(next(&mut st), None, "the cap is reached");
        st.active.remove("3");
        assert_eq!(next(&mut st).as_deref(), Some("4"), "project a is still busy");
        st.active.remove("1");
        assert_eq!(next(&mut st).as_deref(), Some("2"));
        assert_eq!((next(&mut st), st.pending.len(), st.active.len()), (None, 0, 2));
    }

    #[test]
    fn one_source_of_a_running_job_can_be_cancelled_until_it_ends() {
        let mut st = waiting(&[]);
        let task = |id: &str, status: &str| json!({ "source_id": id, "status": status, "finished_at": null });
        st.jobs.insert("j".into(), json!({ "status": "running", "tasks": [task("a", "done"), task("b", "running"), task("c", "pending")] }));
        let cancels = Cancels { job: Arc::default(), tasks: ["a", "b", "c"].map(|s| (s.to_string(), Arc::default())).to_vec() };
        let (job, flags) = (cancels.job.clone(), cancels.tasks.clone());
        let set = |i: usize| flags[i].1.load(Ordering::SeqCst);
        st.cancels.insert("j".into(), cancels);
        assert_eq!(["a", "nope"].map(|s| st.cancel("j", Some(s))), [false, false], "ended, and not there");
        assert!(st.cancel("j", Some("c")));
        assert!(!st.cancel("j", Some("c")), "already cancelled");
        assert_eq!((set(1), set(2), job.load(Ordering::SeqCst)), (false, true, false));
        assert_eq!(st.jobs["j"]["tasks"][2]["status"], "cancelled");
        assert!(st.jobs["j"]["tasks"][2]["finished_at"].is_i64());
        assert!(st.cancel("j", Some("")), "no source is the whole job");
        assert!(set(1) && job.load(Ordering::SeqCst));
        st.jobs.get_mut("j").unwrap()["status"] = json!("done");
        assert!(!st.cancel("j", None));
    }

    #[test]
    fn two_threads_never_take_the_same_project() {
        for _ in 0..200 {
            let st = Arc::new(Mutex::new(waiting(&[("1", "a"), ("2", "a")])));
            let taken: usize = [st.clone(), st].map(|st| std::thread::spawn(move || usize::from(st.lock().unwrap().take_next(8).is_some()))).map(|t| t.join().unwrap()).iter().sum();
            assert_eq!(taken, 1);
        }
    }

    #[tokio::test]
    async fn a_panic_in_the_work_is_its_error() {
        let literal = caught(async { if true { panic!("boom") } else { Ok(1) } }).await.unwrap_err();
        assert_eq!(literal.to_string(), "boom");
        let formatted = caught(async { if true { panic!("boom {}", 2) } else { Ok(1) } }).await.unwrap_err();
        assert_eq!(formatted.to_string(), "boom 2");
        assert_eq!(caught(async { Ok(3) }).await.unwrap(), 3);
        assert_eq!(caught::<()>(async { anyhow::bail!("plain") }).await.unwrap_err().to_string(), "plain");
    }

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
