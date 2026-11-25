//! The one shared server. Mirrors `src/daemon/main.ts` and `http-server.ts`: data-dir ownership, a sticky
//! port, the Host and Origin gate on every route, jobs, heartbeats, and a shutdown that drains.
//! A small HTTP reader on purpose: one request per connection, no new compile cost.
//! Not yet: ticket polling, the RSS guard, install.
use crate::autogc::{self, AutoGc};
use crate::pinned;
use crate::vecindex;
use crate::config::{data_dir, pidfile_path, VERSION};
use crate::daemon_log;
use crate::ephemeral;
use crate::jsstr::{js_trim, parse_int};
use crate::presets;
use crate::index::refuse_live_data_dir;
use crate::jobs::{self, Queue, Request};
use crate::lifecycle::Lifecycle;
use crate::locks::{self, Lock};
use crate::manage;
use crate::mcp::{self, Answer, Failed, Reason};
use crate::mcp_http;
use crate::ops::DRAINING;
use crate::registry;
use crate::span::Span;
use crate::store::Store;
use crate::source_add;
use crate::ticket_poll::{self, TicketPoller};
use crate::watch::{self, Idle, WatchHealth, Watching};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const DEFAULT_PORT: u16 = 58451;
const DAEMON_TOOLS: &str = include_str!("daemon_tools.json");
/// How long jobs that aren't index runs may hold up leaving.
const OTHER_JOBS_CAP: Duration = Duration::from_secs(30);
/// How long open requests may hold up leaving: one that is never read must not keep the data dir locked.
const REQUESTS_CAP: Duration = Duration::from_secs(30);
/// How often a call's memory is read for its record.
const CALL_POLL: Duration = Duration::from_millis(25);

/// `setDaemonState`: the last word anything set, whoever set it.
type StateWord = Arc<Mutex<&'static str>>;

struct Daemon {
    store: Arc<Store>,
    queue: Arc<Queue>,
    autogc: Arc<AutoGc>,
    backfill: Arc<vecindex::Backfill>,
    lifecycle: Mutex<Lifecycle>,
    health: Arc<WatchHealth>,
    state: StateWord,
    watching: Watching,
    tickets: Option<Arc<TicketPoller>>,
    started_at: Instant,
    started_iso: String,
    port: u16,
    draining: AtomicBool,
    closing: AtomicBool,
    shutting_down: AtomicBool,
    /// True once the server takes no more connections.
    stopping: tokio::sync::watch::Sender<bool>,
    in_flight: Arc<AtomicUsize>,
}

/// A request being answered.
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        InFlight(count.clone())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug, PartialEq)]
enum Drain {
    Done,
    Wait,
    GiveUp,
}

/// `runShutdownDrain`: an index run may take up to `cap`, anything else 30 seconds.
fn drain_step(elapsed: Duration, active: usize, reindexes: usize, cap: Duration) -> Drain {
    if active == 0 {
        return Drain::Done;
    }
    if elapsed >= if reindexes > 0 { cap } else { OTHER_JOBS_CAP } { Drain::GiveUp } else { Drain::Wait }
}

/// `sanitizeForLog`: a caller's text can't start a line of its own.
fn one_line(s: &str) -> String {
    s.chars().map(|c| if c < ' ' || c == '\u{7f}' { '?' } else { c }).collect()
}

/// `getClientId`.
fn client_id(head: &str) -> &str {
    header(head, "x-scrybe-client-id").filter(|id| !id.is_empty()).unwrap_or("anon")
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// `readAllowedHosts`: the loopback names, plus plain hostnames from the environment.
fn allowed_hosts() -> HashSet<String> {
    let mut hosts: HashSet<String> = ["localhost", "127.0.0.1", "::1"].map(String::from).into();
    if let Ok(extra) = std::env::var("SCRYBE_DAEMON_ALLOWED_HOSTS") {
        for entry in extra.split(',').map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()) {
            if entry.contains(':') || entry.contains('[') {
                eprintln!("[host-gate] SCRYBE_DAEMON_ALLOWED_HOSTS entry '{entry}' is not a plain hostname: ignored");
            } else {
                hosts.insert(entry);
            }
        }
    }
    hosts
}

/// `parseHostHeader`: the bare hostname, with any port dropped.
fn host_name(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if let Some(rest) = v.strip_prefix('[') {
        return rest.split_once(']').map(|(h, _)| h.to_lowercase());
    }
    if let Some((name, port)) = v.rsplit_once(':') {
        if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            return Some(name.to_lowercase());
        }
    }
    Some(v.to_lowercase())
}

/// Same rule as `checkHostAndOrigin`: only browsers send an Origin, and no scrybe client does.
fn allowed(head: &str) -> bool {
    let Some(host) = header(head, "host").and_then(host_name) else { return false };
    allowed_hosts().contains(&host) && header(head, "origin").is_none()
}

fn work_accepting(method: &str, path: &str) -> bool {
    matches!((method, path), ("POST", "/kick" | "/gc" | "/pause" | "/resume")) || (method == "DELETE" && path.starts_with("/jobs/")) || (method != "GET" && pinned_ids(path).is_some())
}

/// `PINNED_RE`: the two raw (still encoded) ids in `/projects/:p/sources/:s/pinned-branches`.
fn pinned_ids(path: &str) -> Option<(&str, &str)> {
    let (project, rest) = path.strip_prefix("/projects/")?.split_once("/sources/")?;
    let source = rest.strip_suffix("/pinned-branches")?;
    (!project.is_empty() && !project.contains('/') && !source.is_empty() && !source.contains('/')).then_some((project, source))
}

/// `decodeURIComponent`: strict, and a plus stays a plus.
fn decode_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()))?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

async fn respond(s: &mut TcpStream, status: &str, kind: &str, body: &str) -> Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    s.write_all(head.as_bytes()).await?;
    s.write_all(body.as_bytes()).await?;
    Ok(())
}

async fn json_res(s: &mut TcpStream, status: &str, body: &Value) -> Result<()> {
    respond(s, status, "application/json", &body.to_string()).await
}

/// The server's catch-all answer to a thrown error.
async fn boom(s: &mut TcpStream, message: &str) -> Result<()> {
    json_res(s, "500 Internal Server Error", &json!({ "error": message })).await
}

/// `readBody`: an empty body is `{}`.
fn read_json(body: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(body);
    if js_trim(&text).is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("SyntaxError: {e}"))
}

/// `read_json`, for a route that then reads fields, `first` before any other.
fn read_fields(body: &[u8], first: &str) -> Result<Value, String> {
    match read_json(body)? {
        Value::Null => Err(format!("TypeError: Cannot read properties of null (reading '{first}')")),
        v => Ok(v),
    }
}

/// A field as an id. JavaScript takes any type here, so one that isn't a string is its JSON text rather than nothing.
fn id_field(body: &Value, key: &str) -> Option<String> {
    match &body[key] {
        Value::Null | Value::Bool(false) => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        other => Some(other.to_string()),
    }
}

/// Reads up to the next line end and returns the line. `None` when it is too long or the sender left.
async fn chunk_line<R: AsyncRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> std::io::Result<Option<String>> {
    loop {
        if let Some(i) = buf.windows(2).position(|w| w == b"\r\n") {
            let line = String::from_utf8_lossy(&buf[..i]).into_owned();
            buf.drain(..i + 2);
            return Ok(Some(line));
        }
        if buf.len() > 16 << 10 || r.read_buf(buf).await? == 0 {
            return Ok(None);
        }
    }
}

/// A body sent with `Transfer-Encoding: chunked`, `buf` being what has already arrived. `None` when it is malformed or cut short.
async fn read_chunked<R: AsyncRead + Unpin>(r: &mut R, mut buf: Vec<u8>) -> std::io::Result<Option<Vec<u8>>> {
    let mut body = vec![];
    loop {
        let Some(line) = chunk_line(r, &mut buf).await? else { return Ok(None) };
        let digits = line.split(';').next().unwrap_or("").trim();
        let size = match usize::from_str_radix(digits, 16) {
            Ok(n) if digits.bytes().all(|b| b.is_ascii_hexdigit()) && n < usize::MAX - 2 => n,
            _ => return Ok(None),
        };
        if size == 0 {
            // The trailer, up to its empty line.
            loop {
                match chunk_line(r, &mut buf).await? {
                    None => return Ok(None),
                    Some(line) if line.is_empty() => return Ok(Some(body)),
                    Some(_) => {}
                }
            }
        }
        while buf.len() < size + 2 {
            if r.read_buf(&mut buf).await? == 0 {
                return Ok(None);
            }
        }
        if &buf[size..size + 2] != b"\r\n" {
            return Ok(None);
        }
        body.extend(buf.drain(..size + 2).take(size));
    }
}

/// The request's body, `buf` being what arrived with its head. `None` when its framing is malformed or it was cut short.
async fn read_body<R: AsyncRead + Unpin>(r: &mut R, head: &str, mut buf: Vec<u8>) -> std::io::Result<Option<Vec<u8>>> {
    let length = header(head, "content-length");
    if let Some(encoding) = header(head, "transfer-encoding") {
        if length.is_some() || !encoding.eq_ignore_ascii_case("chunked") {
            return Ok(None);
        }
        return read_chunked(r, buf).await;
    }
    let len = match length.map(str::parse::<usize>) {
        None => 0,
        Some(Ok(n)) => n,
        Some(Err(_)) => return Ok(None),
    };
    while buf.len() < len {
        if r.read_buf(&mut buf).await? == 0 {
            return Ok(None);
        }
    }
    buf.truncate(len);
    Ok(Some(buf))
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == name).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len()).then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())).flatten();
        match (hex, b[i]) {
            (Some(v), _) => {
                out.push(v);
                i += 3;
            }
            (None, b'+') => {
                out.push(b' ');
                i += 1;
            }
            (None, c) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Daemon {
    fn uptime_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    /// `daemonWriteUnavailableError`: no new work once jobs are only being finished.
    fn refuse_if_draining(&self) -> Result<()> {
        if self.draining.load(Ordering::SeqCst) {
            anyhow::bail!(DRAINING);
        }
        Ok(())
    }

    /// The `/gc` route: replace any waiting gc in scope, then queue one for each project.
    fn gc(&self, scope: Vec<String>, source: Option<String>, purge: bool) -> Value {
        let cancelled = self.queue.cancel_pending_gc(&scope);
        for project in &scope {
            self.autogc.reset(project);
        }
        let jobs: Vec<Value> = scope
            .into_iter()
            .map(|project| {
                let r = self.queue.submit(Request { project: project.clone(), source: source.clone(), gc_purge: Some(purge), ..Default::default() });
                json!({ "jobId": r.job_id, "projectId": project, "status": r.status })
            })
            .collect();
        json!({ "cancelledPending": cancelled, "jobs": jobs })
    }

    fn gc_tool(&self, a: &Value) -> Result<Value> {
        let scope: Vec<String> = match a["project_id"].as_str() {
            Some(p) => {
                if registry::get_project(p).is_none() {
                    anyhow::bail!("Project '{p}' not found");
                }
                vec![p.to_string()]
            }
            None => registry::list_projects().into_iter().map(|p| p.id).collect(),
        };
        if scope.is_empty() {
            return Ok(json!({ "message": "No projects registered." }));
        }
        self.refuse_if_draining()?;
        let result = self.gc(scope, a["source_id"].as_str().map(String::from), true);
        let cancelled = result["cancelledPending"].as_u64().unwrap_or(0);
        let hint = if cancelled > 0 { format!(" ({cancelled} pending auto-gc job(s) preempted)") } else { String::new() };
        let jobs: Vec<Value> = result["jobs"].as_array().into_iter().flatten().map(|j| json!({ "job_id": j["jobId"], "project_id": j["projectId"], "status": j["status"] })).collect();
        let message = format!("{} gc job(s) queued{hint}. Poll with reindex_status or run 'scrybe job list'.", jobs.len());
        Ok(json!({ "jobs": jobs, "message": message }))
    }

    fn status(&self) -> Value {
        let projects: Vec<Value> = registry::list_projects()
            .iter()
            .map(|p| {
                let code = p.sources.iter().find(|s| s.kind() == "code");
                let branch = self.health.branch.lock().unwrap().get(&p.id).cloned();
                json!({
                    "projectId": p.id,
                    "rootPath": code.and_then(|s| s.root_path()).unwrap_or(""),
                    "currentBranch": branch,
                    "watcherHealthy": self.health.files.lock().unwrap().get(&p.id).copied().unwrap_or(false),
                    "gitWatcherHealthy": self.health.git.lock().unwrap().get(&p.id).copied().unwrap_or(false),
                    "lastIndexedAt": code.and_then(|s| s.last_indexed.clone()),
                    "lastBranch": branch,
                    "queueDepth": 0,
                })
            })
            .collect();
        let running: Vec<Value> = self.queue.rows.list(Some("running"), None).unwrap_or_default().iter().map(|r| json!({ "job_id": r["job_id"], "project_id": r["project_id"], "source_id": r["source_id"], "mode": r["mode"], "started_at": r["started_at"], "phase": r["phase"] })).collect();
        let lifecycle = self.lifecycle.lock().unwrap();
        json!({
            "version": VERSION,
            "pid": std::process::id(),
            "port": self.port,
            "uptimeMs": self.uptime_ms(),
            "state": *self.state.lock().unwrap(),
            "startedAt": self.started_iso,
            "dataDir": data_dir().to_string_lossy(),
            "projects": projects,
            "queue": self.queue.stats(),
            "recentEvents": self.queue.recent_events(10),
            "lastError": self.queue.last_error(),
            "draining": self.draining.load(Ordering::SeqCst),
            "clientCount": lifecycle.client_count(),
            "mode": if lifecycle.always_on() { "always-on" } else { "on-demand" },
            "gracePeriodRemainingMs": lifecycle.grace_remaining(Instant::now()).map(|d| d.as_millis() as u64),
            "runningJobs": running,
        })
    }

    fn kick(&self, body: &Value) -> Result<Value, String> {
        let text = |k: &str| body[k].as_str().map(String::from);
        let source = id_field(body, "sourceId");
        let ids: Vec<String> = match id_field(body, "projectId").filter(|p| !p.is_empty()) {
            Some(p) => vec![p],
            None => registry::list_projects().into_iter().map(|p| p.id).collect(),
        };
        let full = body["mode"] == "full";
        if full && source.as_ref().is_none_or(String::is_empty) {
            // A project that isn't registered gets the failed job it always gets.
            let registry_exists = data_dir().join("projects.json").exists();
            if ids.iter().any(|id| !registry_exists || registry::get_project(id).is_some()) {
                return Err(format!("Error: {}", jobs::FULL_NEEDS_SOURCES));
            }
        }
        let jobs: Vec<Value> = ids
            .into_iter()
            .map(|project| {
                let r = self.queue.submit(Request { project: project.clone(), source: source.clone(), branch: text("branch"), content_ref: text("contentRef"), full, ..Default::default() });
                let mut job = json!({ "jobId": r.job_id, "projectId": project, "sourceId": source.clone().unwrap_or_else(|| "all".into()), "branch": text("branch").unwrap_or_else(|| "HEAD".into()), "status": r.status });
                if let Some(q) = r.queue_position {
                    job["queuePosition"] = json!(q);
                }
                job["duplicateOfPending"] = json!(r.duplicate_of_pending);
                job
            })
            .collect();
        Ok(json!({ "jobs": jobs }))
    }

    fn submit_tool(&self, a: &Value, source: Option<String>) -> Result<Value> {
        let project = a["project_id"].as_str().unwrap_or("").to_string();
        let full = a["mode"] == "full";
        if registry::get_project(&project).is_none() {
            anyhow::bail!("Project '{project}' not found");
        }
        if full && source.as_ref().is_none_or(String::is_empty) {
            anyhow::bail!(jobs::FULL_NEEDS_SOURCES);
        }
        self.refuse_if_draining()?;
        let r = self.queue.submit(Request { project: project.clone(), source: source.clone(), branch: a["branch"].as_str().map(String::from), content_ref: a["content_ref"].as_str().map(String::from), full, ..Default::default() });
        let mut out = json!({ "job_id": r.job_id, "status": r.status, "project_id": project });
        if let Some(s) = source {
            out["source_id"] = json!(s);
        }
        out["mode"] = json!(if full { "full" } else { "incremental" });
        if let Some(q) = r.queue_position {
            out["queue_position"] = json!(q);
        }
        if r.duplicate_of_pending {
            out["duplicate_of_pending"] = json!(true);
        }
        Ok(out)
    }

    /// The tools that need the running server. None if `name` isn't one of them.
    fn run_tool(&self, name: &str, a: &Value) -> Option<Result<Value>> {
        Some(match name {
            "reindex_all" => {
                let projects = registry::list_projects().len();
                Ok(json!({ "job_id": self.queue.submit_all(), "status": "started", "project_count": projects, "mode": "incremental" }))
            }
            "reindex_project" => {
                let first = a["source_ids"].as_array().and_then(|s| s.first()).and_then(Value::as_str).map(String::from);
                if a["mode"] == "full" && first.is_none() {
                    Err(anyhow::anyhow!("source_ids is required for mode: full"))
                } else {
                    self.submit_tool(a, first).map(|mut r| {
                        if let Some(o) = r.as_object_mut() {
                            o.remove("source_id");
                        }
                        r
                    })
                }
            }
            "reindex_source" => self.submit_tool(a, a["source_id"].as_str().map(String::from)),
            "reindex_status" => {
                let id = a["job_id"].as_str().unwrap_or("");
                self.queue.job_status(id).map(with_projects).with_context(|| format!("Job '{id}' not found"))
            }
            "cancel_reindex" => {
                let id = a["job_id"].as_str().unwrap_or("");
                Ok(json!({ "job_id": id, "cancelled": self.queue.cancel(id, a["source_id"].as_str()) }))
            }
            "list_jobs" => self.queue.list_jobs(a["status"].as_str()).map(|jobs| json!({ "count": jobs.len(), "jobs": jobs })),
            "queue_status" => self.queue.rows.queue_status(a["project_id"].as_str()).map(|(running, queued)| json!({ "running": running, "queued": queued, "awaiting_migration": [] })),
            "status" => Ok(self.status_tool()),
            "gc" => self.gc_tool(a),
            "list_pinned_branches" | "pin_branches" | "unpin_branches" => self.pin_tool(name, a),
            "add_project" => manage::add_project(a),
            "update_project" => manage::update_project(a),
            "update_source" => manage::update_source(a),
            "list_branches" => manage::list_branches(&self.queue, a),
            "set_private_ignore" => manage::set_private_ignore(a),
            "get_private_ignore" => manage::get_private_ignore(a),
            "list_private_ignores" => manage::list_private_ignores(a),
            "add_embedding_preset" => Ok(presets::add_embedding_preset(a)),
            "assign_preset" => Ok(presets::assign_preset(a)),
            _ => return None,
        })
    }

    /// The pinned-branches route. A bad body is a 500 with the error text, as the server's catch-all gives.
    fn pinned_route(&self, method: &str, ids: (&str, &str), query: &str, body: &[u8]) -> (&'static str, Value) {
        let boom = |m: &str| ("500 Internal Server Error", json!({ "error": m }));
        let (Some(project), Some(source)) = (decode_component(ids.0), decode_component(ids.1)) else { return boom("URIError: URI malformed") };
        let (project, source) = (project.as_str(), source.as_str());
        let failed = |e: pinned::PinError| e.response();
        if method == "GET" {
            return match pinned::list(project, source) {
                Ok(branches) => ("200 OK", json!({ "branches": branches })),
                Err(e) => failed(e),
            };
        }
        let all = method == "DELETE" && query_param(query, "all").as_deref() == Some("true");
        let parsed = match read_fields(if all { b"" } else { body }, "branches") {
            Ok(v) => v,
            Err(e) => return boom(&e),
        };
        let event = |action: &str, branches: &[String]| {
            self.queue.push(json!({ "ts": jobs::now_iso(), "level": "info", "event": "pinned.changed", "projectId": project, "sourceId": source, "detail": { "action": action, "branches": branches } }));
        };
        if all {
            return match pinned::clear(project, source) {
                Ok(r) => {
                    event("remove", &r.removed);
                    ("200 OK", r.to_json())
                }
                Err(e) => failed(e),
            };
        }
        if let Err(e) = pinned::list(project, source) {
            return failed(e);
        }
        let branches: Vec<String> = match &parsed["branches"] {
            Value::Null => vec![],
            Value::Array(a) if a.iter().all(Value::is_string) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
            _ => return boom("TypeError: branches.filter is not a function"),
        };
        if method == "POST" {
            return match pinned::add(project, source, &branches, parsed["mode"] == "set") {
                Ok(r) => {
                    event("add", &r.added);
                    ("200 OK", r.to_json())
                }
                Err(e) => failed(e),
            };
        }
        match pinned::remove(project, source, &branches) {
            Ok(r) => {
                event("remove", &r.removed);
                ("200 OK", r.to_json())
            }
            Err(e) => failed(e),
        }
    }

    fn pin_tool(&self, name: &str, a: &Value) -> Result<Value> {
        let project = a["project_id"].as_str().unwrap_or("");
        let source = a["source_id"].as_str().unwrap_or("primary");
        let branches: Vec<String> = a["branches"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
        let out = match name {
            "list_pinned_branches" => pinned::list_tool(project, a["source_id"].as_str()),
            "pin_branches" => pinned::pin_tool(project, source, &branches, a["mode"] == "set"),
            _ => pinned::remove(project, source, &branches).map(|r| r.to_json()).map_err(|e| e.message()),
        };
        out.map_err(|m| anyhow::anyhow!(m))
    }

    /// `remove_project`, then what the server does when a project goes: stop its timers and announce it.
    async fn remove_project(&self, id: &str) -> Result<Value> {
        let cancelled = manage::remove_project(&self.queue, id).await?;
        self.autogc.cancel(id);
        self.backfill.cancel(id);
        self.queue.push(json!({ "ts": jobs::now_iso(), "level": "info", "event": "project.removed", "projectId": id, "detail": { "jobsCancelled": cancelled } }));
        Ok(json!({ "ok": true, "project_id": id }))
    }

    /// `drop_ephemeral`: forget the label, then a gc scoped to its source reclaims the rows only it used.
    async fn drop_ephemeral(&self, a: &Value) -> Result<Value> {
        let dropped = ephemeral::drop_label(&self.queue, a)?;
        self.refuse_if_draining()?;
        let queued = self.gc(vec![dropped.project.clone()], Some(dropped.source.clone()), true);
        let job = queued["jobs"][0]["jobId"].as_str().unwrap_or("");
        Ok(ephemeral::drop_result(&self.queue, job, &dropped).await)
    }

    fn status_tool(&self) -> Value {
        let mut out = json!({ "version": VERSION, "daemon_running": true, "daemon_pid": std::process::id(), "daemon_port": self.port, "daemon_version": VERSION });
        for (k, v) in registry::embedding_status().as_object().into_iter().flatten() {
            out[k] = v.clone();
        }
        out
    }

    /// Runs any tool, its arguments already checked.
    async fn run_any(&self, name: &str, args: &Value) -> Result<Answer, Reason> {
        let outcome = match name {
            "add_source" => Some(source_add::add(&self.queue, args, || self.refuse_if_draining()).await),
            "remove_source" => Some(manage::remove_source(&self.queue, args).await),
            "index_ephemeral" => Some(ephemeral::index_branch(&self.queue, args, || self.refuse_if_draining()).await),
            "drop_ephemeral" => Some(self.drop_ephemeral(args).await),
            "remove_project" => Some(self.remove_project(args["project_id"].as_str().unwrap_or("")).await),
            _ => self.run_tool(name, args),
        };
        let Some(outcome) = outcome else { return mcp::call(&self.store, name, args).await };
        outcome.map(Answer::Json).map_err(|e| match e.downcast_ref::<registry::CallerFacing>() {
            Some(c) => Reason { message: c.0.clone(), caller_facing: true },
            None => Reason { message: format!("{e:#}"), caller_facing: false },
        })
    }

    /// `dispatchMcpTool`: one tool call, however it came in, with its log lines and its record.
    async fn dispatch(&self, name: &str, args: &Value, client: &str) -> Result<Answer, Failed> {
        let who = format!("[mcp-rpc] client={} method={}", one_line(client), one_line(name));
        let manifest = self.manifest();
        let Some(spec) = manifest["tools"].as_array().and_then(|t| t.iter().find(|x| x["name"] == name)) else {
            daemon_log::say(&format!("{who} → method not found"));
            return Err(Failed { code: -32601, message: format!("method not found: {name}") });
        };
        daemon_log::say(&who);
        let mut span = Span::start();
        let outcome = match mcp::validate_params(name, &spec["inputSchema"], args) {
            Err(message) => Err(Reason { message, caller_facing: true }),
            Ok(()) => {
                let work = jobs::caught(async { Ok(self.run_any(name, args).await) });
                span.watch(CALL_POLL, work).await.unwrap_or_else(|e| Err(Reason { message: e.to_string(), caller_facing: false }))
            }
        };
        let mut record = json!({ "event": "activity-span", "level": "info", "spanType": "mcp-call", "method": one_line(name), "clientId": one_line(client), "durationMs": span.elapsed_ms(), "outcome": if outcome.is_ok() { "ok" } else { "error" } });
        if let Some(o) = record.as_object_mut() {
            span.close(o);
        }
        let answer = outcome.map_err(|reason| {
            let said = one_line(&reason.message);
            let line = format!("{who} → error: {said}");
            daemon_log::say(&line);
            record["error"] = json!(said);
            if reason.caller_facing {
                return Failed { code: -32602, message: reason.message };
            }
            // The caller isn't told why, so the log must.
            daemon_log::quiet(&line);
            Failed { code: -32603, message: "internal error".into() }
        });
        jobs::diag(record);
        answer
    }

    async fn rpc(&self, req: &Value, client: &str) -> String {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let name = req.get("method").and_then(Value::as_str).unwrap_or("");
        if req.get("id").is_none() || name.is_empty() {
            return json!({ "id": id, "error": { "code": -32600, "message": "invalid request: missing id or method" } }).to_string();
        }
        let args = req.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
        match self.dispatch(name, &args, client).await {
            Ok(answer) => format!(r#"{{"id":{id},"result":{}}}"#, answer.raw()),
            Err(f) => json!({ "id": id, "error": { "code": f.code, "message": f.message } }).to_string(),
        }
    }

    fn manifest(&self) -> &'static Value {
        static MANIFEST: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        MANIFEST.get_or_init(Self::build_manifest)
    }

    fn build_manifest() -> Value {
        let mut all = mcp::tool_list();
        let extra: Value = serde_json::from_str(DAEMON_TOOLS).unwrap_or(json!([]));
        if let (Some(a), Some(e)) = (all.as_array_mut(), extra.as_array()) {
            a.extend(e.iter().cloned());
        }
        json!({ "daemon_version": VERSION, "tools": all })
    }

    /// True for the first call only.
    fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    async fn shutdown(self: Arc<Self>, why: String) {
        if self.begin_shutdown() {
            self.drain_and_leave(why).await;
        }
    }

    /// `shutdown` in main.ts: keep answering while jobs finish, then close and exit.
    async fn drain_and_leave(self: Arc<Self>, why: String) {
        daemon_log::line(&format!("[scrybe daemon] {why} — shutting down"));
        self.draining.store(true, Ordering::SeqCst);
        self.watching.stop();
        if let Some(tickets) = &self.tickets {
            tickets.stop();
        }
        let cap = Duration::from_millis(crate::jsstr::env_int("SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS").map_or(30 * 60 * 1000, |n| n as u64));
        let begun = Instant::now();
        loop {
            let active = self.queue.active_count();
            match drain_step(begun.elapsed(), active, self.queue.active_reindexes(), cap) {
                Drain::Wait => tokio::time::sleep(Duration::from_millis(200)).await,
                Drain::Done => break,
                Drain::GiveUp => {
                    daemon_log::line(&format!("[scrybe daemon] shutdown cap hit — {active} job(s) still active, force-stopping"));
                    jobs::append_log(&json!({ "ts": jobs::now_iso(), "event": "gc.force-killed", "detail": { "activeJobs": active } }).to_string());
                    break;
                }
            }
        }
        self.closing.store(true, Ordering::SeqCst);
        self.queue.stop();
        self.stop_serving().await;
        leave();
    }

    /// `stopHttpServer`: no more connections, event streams end, and every request being answered gets its answer.
    async fn stop_serving(&self) {
        self.stopping.send_replace(true);
        let end = Instant::now() + REQUESTS_CAP;
        while self.in_flight.load(Ordering::SeqCst) > 0 && Instant::now() < end {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// `handleTerminationSignal`: the first asks, one during any shutdown insists.
    fn signalled(self: &Arc<Self>, signal: &'static str) {
        if self.begin_shutdown() {
            tokio::spawn(self.clone().drain_and_leave(signal.to_string()));
            return;
        }
        daemon_log::line(&format!("[scrybe daemon] {signal} received again while shutting down — forcing immediate exit"));
        jobs::diag(json!({ "level": "warn", "event": "daemon.shutdown.escalated", "signal": signal }));
        leave();
    }
}

/// A finished run over every project says where each of them stands.
fn with_projects(mut job: Value) -> Value {
    if job["status"] == "done" && job["project_id"] == "*" {
        let projects: Vec<Value> = registry::list_projects().iter().map(|p| {
            let sources: Vec<Value> = p.sources.iter().map(|s| {
                let mut one = json!({ "source_id": s.source_id });
                if let Some(at) = &s.last_indexed {
                    one["last_indexed"] = json!(at);
                }
                one
            }).collect();
            json!({ "project_id": p.id, "sources": sources })
        }).collect();
        job["projects"] = json!(projects);
    }
    job
}

/// Held for the server's life; `None` on a data dir that can't hold a lock.
static OWNER: Mutex<Option<locks::Held>> = Mutex::new(None);

fn leave() -> ! {
    let _ = std::fs::remove_file(pidfile_path());
    drop(OWNER.lock().unwrap_or_else(|e| e.into_inner()).take());
    std::process::exit(0)
}

async fn handle(mut s: TcpStream, d: Arc<Daemon>) -> Result<()> {
    let mut buf = Vec::with_capacity(4096);
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let mut chunk = [0u8; 4096];
        let n = s.read(&mut chunk).await?;
        if n == 0 || buf.len() > 64 << 10 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    if !allowed(&head) {
        return json_res(&mut s, "403 Forbidden", &json!({ "error": "forbidden" })).await;
    }
    let request_line = head.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_uppercase(), parts.next().unwrap_or(""));
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let method = method.as_str();

    if method == "OPTIONS" {
        return respond(&mut s, "204 No Content", "text/plain", "").await;
    }
    if (method, path) == ("GET", "/health") {
        // Deliberately 200 while draining: clients kill a server that answers anything else.
        if d.closing.load(Ordering::SeqCst) {
            return json_res(&mut s, "503 Service Unavailable", &json!({ "ready": false, "reason": "closing", "version": VERSION, "uptimeMs": d.uptime_ms(), "pid": std::process::id() })).await;
        }
        return json_res(&mut s, "200 OK", &json!({ "ready": true, "draining": d.draining.load(Ordering::SeqCst), "version": VERSION, "uptimeMs": d.uptime_ms(), "pid": std::process::id() })).await;
    }
    if d.closing.load(Ordering::SeqCst) {
        return json_res(&mut s, "503 Service Unavailable", &json!({ "error": "daemon is shutting down", "draining": true })).await;
    }
    if d.draining.load(Ordering::SeqCst) && work_accepting(method, path) {
        return json_res(&mut s, "503 Service Unavailable", &json!({ "error": "daemon is shutting down — not accepting new work", "draining": true })).await;
    }

    let answering = InFlight::new(&d.in_flight);
    let mut stopping = d.stopping.subscribe();
    let body = tokio::select! {
        body = read_body(&mut s, &head, buf.split_off(head_end + 4)) => body?,
        // A sender that stalls must not hold up leaving.
        _ = stopping.wait_for(|stop| *stop) => return Ok(()),
    };
    let Some(body) = body else {
        return respond(&mut s, "400 Bad Request", "text/plain", "").await;
    };

    match (method, path) {
        ("GET", "/status") => json_res(&mut s, "200 OK", &d.status()).await,
        ("GET", "/events") => {
            drop(answering);
            events(s, d, query).await
        }
        ("GET", "/projects") => {
            let projects: Vec<Value> = registry::list_projects()
                .iter()
                .map(|p| {
                    let code = p.sources.iter().find(|x| x.kind() == "code");
                    json!({ "id": p.id, "rootPath": code.and_then(|x| x.root_path()).unwrap_or(""), "branches": code.and_then(|x| x.pinned_branches.clone()).unwrap_or_default(), "lastIndexed": code.and_then(|x| x.last_indexed.clone()), "watcherHealthy": false })
                })
                .collect();
            json_res(&mut s, "200 OK", &json!({ "projects": projects })).await
        }
        ("POST", "/kick") => match read_fields(&body, "projectId").and_then(|b| d.kick(&b)) {
            Ok(answer) => json_res(&mut s, "200 OK", &answer).await,
            Err(e) => boom(&mut s, &e).await,
        },
        ("POST", "/gc") => {
            let parsed = match read_fields(&body, "mode") {
                Ok(v) => v,
                Err(e) => return boom(&mut s, &e).await,
            };
            let purge = parsed["mode"].is_null() || parsed["mode"] == "purge";
            let scope: Vec<String> = match &parsed["scope"] {
                Value::Array(list) if !list.is_empty() => list.iter().filter_map(Value::as_str).map(String::from).collect(),
                Value::String(text) if !text.is_empty() => return boom(&mut s, "TypeError: scope.map is not a function").await,
                _ => registry::list_projects().into_iter().filter(|p| p.sources.iter().any(|x| x.kind() == "code")).map(|p| p.id).collect(),
            };
            json_res(&mut s, "200 OK", &d.gc(scope, id_field(&parsed, "sourceId"), purge)).await
        }
        ("GET", "/jobs") => {
            let (status, project) = (query_param(query, "status"), query_param(query, "project_id"));
            let rows = d.queue.rows.list(status.as_deref(), project.as_deref()).unwrap_or_default();
            json_res(&mut s, "200 OK", &json!({ "jobs": rows, "count": rows.len() })).await
        }
        ("GET", p) if p.starts_with("/jobs/") => {
            let id = percent_decode(&p["/jobs/".len()..]);
            match d.queue.rows.get(&id) {
                Some(row) => json_res(&mut s, "200 OK", &row).await,
                None => json_res(&mut s, "404 Not Found", &json!({ "error": "not_found" })).await,
            }
        }
        ("DELETE", p) if p.starts_with("/jobs/") => {
            let id = percent_decode(&p["/jobs/".len()..]);
            let cancelled = d.queue.cancel(&id, None);
            json_res(&mut s, "200 OK", &json!({ "job_id": id, "cancelled": cancelled })).await
        }
        ("GET", "/queue-status") => {
            let project = query_param(query, "project_id");
            let (running, queued) = d.queue.rows.queue_status(project.as_deref()).unwrap_or_default();
            json_res(&mut s, "200 OK", &json!({ "running": running, "queued": queued, "awaiting_migration": [] })).await
        }
        ("POST", "/pause") => {
            // A status word only, as today: jobs and watchers carry on.
            *d.state.lock().unwrap() = "paused";
            json_res(&mut s, "200 OK", &json!({ "state": "paused" })).await
        }
        ("POST", "/resume") => {
            *d.state.lock().unwrap() = "hot";
            json_res(&mut s, "200 OK", &json!({ "state": "hot" })).await
        }
        ("POST", "/shutdown") => {
            json_res(&mut s, "200 OK", &json!({ "state": "stopping" })).await?;
            tokio::spawn(d.clone().shutdown("HTTP /shutdown".to_string()));
            Ok(())
        }
        ("POST", "/clients/heartbeat" | "/clients/unregister") => {
            let parsed = match read_fields(&body, "clientId") {
                Ok(v) => v,
                Err(e) => return boom(&mut s, &e).await,
            };
            if let Some(id) = parsed["clientId"].as_str().filter(|id| !id.is_empty()) {
                let mut lifecycle = d.lifecycle.lock().unwrap();
                if path == "/clients/heartbeat" {
                    lifecycle.heartbeat(id, Instant::now());
                } else {
                    lifecycle.unregister(id, Instant::now());
                }
            }
            json_res(&mut s, "200 OK", &json!({ "ok": true })).await
        }
        (m @ ("GET" | "POST" | "DELETE"), p) if pinned_ids(p).is_some() => {
            let (status, answer) = d.pinned_route(m, pinned_ids(p).unwrap_or_default(), query, &body);
            json_res(&mut s, status, &answer).await
        }
        ("GET", "/mcp/manifest") => json_res(&mut s, "200 OK", d.manifest()).await,
        ("POST", "/mcp/rpc") => {
            let parsed = match read_json(&body) {
                Ok(Value::Null) => return boom(&mut s, "TypeError: Cannot read properties of null (reading 'id')").await,
                Ok(v) => v,
                Err(_) => return json_res(&mut s, "200 OK", &json!({ "id": null, "error": { "code": -32600, "message": "invalid request: body is not valid JSON" } })).await,
            };
            let answer = d.rpc(&parsed, client_id(&head)).await;
            respond(&mut s, "200 OK", "application/json", &answer).await
        }
        (_, "/mcp") if mcp_http::enabled() => {
            if matches!(method, "GET" | "DELETE") {
                let r = mcp_http::method_not_allowed();
                return respond(&mut s, r.status, r.kind, &r.body).await;
            }
            // Only a request that reaches the handler keeps the server up.
            d.lifecycle.lock().unwrap().heartbeat("mcp-http", Instant::now());
            if method != "POST" {
                let r = mcp_http::method_not_allowed();
                let body = if method == "HEAD" { "" } else { r.body.as_str() };
                return respond(&mut s, r.status, &format!("{}\r\nAllow: GET, POST, DELETE", r.kind), body).await;
            }
            let (me, client) = (&d, client_id(&head));
            let call = |name: String, args: Value| async move { me.dispatch(&name, &args, client).await };
            let r = mcp_http::answer(|name| header(&head, name), &body, &me.manifest()["tools"], call).await;
            respond(&mut s, r.status, r.kind, &r.body).await
        }
        _ => json_res(&mut s, "404 Not Found", &json!({ "error": "Not found" })).await,
    }
}

/// `/events`: what happened since `since`, then everything new until the client leaves.
async fn events(mut s: TcpStream, d: Arc<Daemon>, query: &str) -> Result<()> {
    let mut feed = d.queue.events.subscribe();
    s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: ping\n\n").await?;
    if let Some(since) = query_param(query, "since") {
        for e in d.queue.events_since(&since) {
            s.write_all(format!("data: {e}\n\n").as_bytes()).await?;
        }
    }
    let mut stopping = d.stopping.subscribe();
    loop {
        let got = tokio::select! {
            got = feed.recv() => got,
            _ = stopping.wait_for(|stop| *stop) => return Ok(()),
        };
        match got {
            Ok(line) => s.write_all(format!("data: {line}\n\n").as_bytes()).await?,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => return Ok(()),
        }
    }
}

fn retryable_bind(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied)
}

/// The record of a port refused and the one tried instead.
fn bind_fallback(refused: u16, e: &std::io::Error, next: u16) -> Value {
    let code = if e.kind() == std::io::ErrorKind::AddrInUse { "EADDRINUSE" } else { "EACCES" };
    let next = if next == 0 { json!("ephemeral") } else { json!(next) };
    json!({ "level": "warn", "event": "daemon.bind.fallback", "detail": { "refusedPort": refused, "code": code, "nextPort": next } })
}

/// The order `bindSticky` tries: the last port, the default, then whatever the system gives.
fn port_candidates(stale: Option<u16>) -> Vec<u16> {
    let mut out = vec![];
    if let Some(p) = stale.filter(|p| *p > 0 && *p != DEFAULT_PORT) {
        out.push(p);
    }
    out.extend([DEFAULT_PORT, 0]);
    out
}

/// The port `SCRYBE_DAEMON_PORT` names, or what Node says about one it can't listen on.
fn port_from(text: &str) -> Result<u16> {
    let n = parse_int(text);
    if let Some(p) = n.filter(|n| (0.0..65536.0).contains(n)) {
        return Ok(p as u16);
    }
    anyhow::bail!("options.port should be >= 0 and < 65536. Received type number ({}).", n.map_or("NaN".to_string(), |n| n.to_string()))
}

/// What to say when the port asked for is refused to this process.
fn reserved_port(port: u16) -> String {
    format!("Port {port} (from SCRYBE_DAEMON_PORT) is unavailable to this process. On Windows this usually means another component (Hyper-V, WSL, etc.) has reserved it at boot. Run `netsh interface ipv4 show excludedportrange protocol=tcp` to see the reserved ranges, or unset SCRYBE_DAEMON_PORT to let the daemon pick a free port itself.")
}

async fn bind_sticky() -> Result<TcpListener> {
    if let Some(asked) = std::env::var_os("SCRYBE_DAEMON_PORT") {
        let port = port_from(&asked.to_string_lossy())?;
        return TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => anyhow::anyhow!(reserved_port(port)),
            _ => e.into(),
        });
    }
    let stale = std::fs::read_to_string(pidfile_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["port"].as_u64()).map(|p| p as u16);
    let candidates = port_candidates(stale);
    for (i, port) in candidates.iter().copied().enumerate() {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok(l),
            Err(e) if port != 0 && retryable_bind(&e) => jobs::diag(bind_fallback(port, &e, candidates[i + 1])),
            Err(_) if port == 0 => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(anyhow::anyhow!("All candidate ports were refused (stale pidfile port, {DEFAULT_PORT}, and an OS-assigned ephemeral port). On Windows this usually means an unusually large block of ports is reserved at boot (Hyper-V, WSL, etc.). Run `netsh interface ipv4 show excludedportrange protocol=tcp` to see the reserved ranges."))
}

/// Hands every termination signal to the server, for as long as it runs.
async fn listen_for_signals(d: Arc<Daemon>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) {
            loop {
                let name = tokio::select! {
                    _ = term.recv() => "SIGTERM",
                    _ = int.recv() => "SIGINT",
                };
                d.signalled(name);
            }
        }
    }
    while tokio::signal::ctrl_c().await.is_ok() {
        d.signalled("SIGINT");
    }
}

/// A panic's record, in the shape of an uncaught exception's.
fn crash_record(message: &str, at: Option<String>) -> Value {
    let stack = at.map(|at| format!("{message}\n    at {at}"));
    json!({ "level": "error", "event": "process.uncaughtException", "error": { "message": message, "stack": stack, "name": "panic" } })
}

/// As many open files as the system allows this process, as Node asks for at start.
fn raise_handle_limit() {
    #[cfg(unix)]
    // SAFETY: both calls only read and write the local struct.
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            // macOS refuses more than its own ceiling, whatever the hard limit says.
            limit.rlim_cur = if cfg!(target_os = "macos") { limit.rlim_max.min(10_240).max(limit.rlim_cur) } else { limit.rlim_max };
            libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
        }
    }
}

fn record_panics() {
    let before = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        jobs::diag(crash_record(info.payload_as_str().unwrap_or("panic"), info.location().map(|l| l.to_string())));
        before(info);
    }));
}

/// `reconcileJobsAtStartup`: a failure is reported and the server goes on.
fn close_orphaned_jobs(queue: &Queue, cutoff: i64) {
    match queue.rows.reconcile(cutoff, registry::project_ids_if_readable().as_deref()) {
        Err(e) => daemon_log::line(&format!("[scrybe daemon] job reconciliation failed: {e:#}")),
        Ok(r) if r.interrupted + r.cancelled > 0 => {
            let detail = json!({ "interrupted": r.interrupted, "cancelled": r.cancelled, "sampleJobIds": r.sample, "cutoffMs": cutoff });
            queue.push(json!({ "ts": jobs::now_iso(), "level": "info", "event": "jobs.reconciled", "detail": detail }));
            jobs::diag(json!({ "level": "info", "event": "jobs.reconciled", "detail": detail }));
        }
        Ok(_) => {}
    }
}

pub async fn serve(store: Store) -> Result<()> {
    // The pidfile would point real clients at this unfinished server.
    refuse_live_data_dir()?;
    std::fs::create_dir_all(data_dir())?;
    crate::config::mark_server();
    // Same lock file as the TypeScript daemon: the operating system drops it if this process dies.
    let owned_since = match locks::acquire(locks::OWNER) {
        Lock::Acquired(held) => {
            let at = held.at_ms;
            *OWNER.lock().unwrap_or_else(|e| e.into_inner()) = Some(held);
            Some(at)
        }
        Lock::Contended(holder) => {
            jobs::diag(json!({ "level": "warn", "event": "daemon.ownership.contended", "dataDir": data_dir().to_string_lossy(), "heldByPid": holder }));
            eprintln!("another server owns this data dir");
            return Ok(());
        }
        Lock::Unavailable(message) => {
            jobs::diag(json!({ "level": "error", "event": "daemon.ownership.unavailable", "dataDir": data_dir().to_string_lossy(), "errorCode": null, "errorMessage": message }));
            None
        }
    };
    let exec = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    jobs::diag(json!({ "level": "info", "event": "daemon.start", "version": VERSION, "dataDir": data_dir().to_string_lossy(), "modulePath": exec }));
    let mut prediction = json!({ "level": "info", "event": "daemon.memory-cap.next-spawn-prediction" });
    for (k, v) in crate::spawn::cap_prediction().as_object().into_iter().flatten() {
        prediction[k] = v.clone();
    }
    jobs::diag(prediction);
    record_panics();
    daemon_log::open();
    raise_handle_limit();
    let listener = bind_sticky().await?;
    let port = listener.local_addr()?.port();
    let store = Arc::new(store);
    let queue = Queue::new(store.clone())?;
    // Only the lock holder may treat jobs queued before it took the lock as left behind.
    if let Some(cutoff) = owned_since {
        close_orphaned_jobs(&queue, cutoff);
    }
    let started_iso = jobs::now_iso();
    let pid = json!({ "pid": std::process::id(), "port": port, "startedAt": started_iso, "version": VERSION, "dataDir": data_dir().to_string_lossy(), "execPath": exec });
    std::fs::write(pidfile_path(), pid.to_string())?;
    daemon_log::line(&format!("[scrybe daemon] started pid={} port={port} dataDir={}", std::process::id(), data_dir().display()));

    let now = Instant::now();
    let (idle, health, state) = (Arc::new(Idle::from_env()), Arc::new(WatchHealth::default()), StateWord::new(Mutex::new("cold")));
    let (word, announcer) = (state.clone(), queue.clone());
    idle.add_on_change(Arc::new(move |hot| {
        let now = if hot { "hot" } else { "cold" };
        *word.lock().unwrap() = now;
        announcer.push(json!({ "ts": jobs::now_iso(), "level": "info", "event": "state.changed", "detail": { "state": now } }));
    }));
    let (autogc, backfill) = (AutoGc::new(queue.clone()), vecindex::Backfill::new(queue.clone()));
    autogc.start();
    backfill.start();
    let projects = registry::list_projects();
    let tickets = ticket_poll::start(queue.clone(), idle.clone(), &projects);
    let watching = watch::start(queue.clone(), idle, health.clone(), &projects);
    let (stopping, mut stop) = tokio::sync::watch::channel(false);
    let d = Arc::new(Daemon { store, queue: queue.clone(), autogc, backfill, lifecycle: Mutex::new(Lifecycle::from_env(now)), health, state, watching, tickets, started_at: now, started_iso, port, draining: AtomicBool::new(false), closing: AtomicBool::new(false), shutting_down: AtomicBool::new(false), stopping, in_flight: Arc::default() });
    autogc::sweep_ephemeral(&queue);
    let checker = queue.clone();
    tokio::spawn(async move { checker.check_tables().await });

    let ticking = d.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let active = ticking.queue.active_reindexes();
            let leave_now = ticking.lifecycle.lock().unwrap().tick(Instant::now(), active);
            if let Some(reason) = leave_now {
                daemon_log::line(&format!("[scrybe daemon] no active clients ({}) — shutting down", reason.as_str()));
                return ticking.shutdown(reason.as_str().to_string()).await;
            }
        }
    });

    tokio::spawn(listen_for_signals(d.clone()));

    loop {
        let (socket, _) = tokio::select! {
            got = listener.accept() => match got {
                Ok(got) => got,
                Err(e) => {
                    daemon_log::line(&format!("[scrybe daemon] a connection could not be taken: {e}"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            _ = stop.wait_for(|stop| *stop) => break,
        };
        let d = d.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(socket, d).await {
                eprintln!("request failed: {e:#}");
            }
        });
    }
    drop(listener);
    // The shutdown that stopped the listener ends the process.
    std::future::pending().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_takes_loopback_only_and_no_browsers() {
        assert!(allowed("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:5000"));
        assert!(allowed("POST /mcp HTTP/1.1\r\nHost: LOCALHOST:5000"));
        assert!(allowed("POST /mcp HTTP/1.1\r\nHost: [::1]:5000"));
        assert!(allowed("POST /mcp HTTP/1.1\r\nHost: localhost"));
        assert!(!allowed("POST /mcp HTTP/1.1\r\nHost: evil.example:5000"));
        assert!(!allowed("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1.evil.example"));
        assert!(!allowed("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: null"));
        assert!(!allowed("POST /mcp HTTP/1.1"));
    }

    #[test]
    fn ports_are_tried_in_the_sticky_order() {
        assert_eq!(port_candidates(Some(40000)), vec![40000, DEFAULT_PORT, 0]);
        assert_eq!(port_candidates(Some(DEFAULT_PORT)), vec![DEFAULT_PORT, 0]);
        assert_eq!(port_candidates(Some(0)), vec![DEFAULT_PORT, 0]);
        assert_eq!(port_candidates(None), vec![DEFAULT_PORT, 0]);
    }

    #[test]
    fn a_reserved_port_falls_through_like_a_taken_one() {
        assert!(retryable_bind(&std::io::Error::from(std::io::ErrorKind::AddrInUse)));
        assert!(retryable_bind(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
        assert!(!retryable_bind(&std::io::Error::from(std::io::ErrorKind::NotFound)));
    }

    #[test]
    fn work_routes_are_refused_while_draining_and_reads_are_not() {
        assert!(work_accepting("POST", "/kick"));
        assert!(work_accepting("POST", "/pause") && work_accepting("POST", "/resume"));
        assert!(work_accepting("DELETE", "/jobs/abc"));
        assert!(work_accepting("POST", "/projects/a/sources/b/pinned-branches"));
        assert!(!work_accepting("GET", "/jobs/abc"));
        assert!(!work_accepting("POST", "/mcp/rpc"));
    }

    #[test]
    fn pinned_paths_match_only_the_exact_shape() {
        assert_eq!(pinned_ids("/projects/a/sources/b/pinned-branches"), Some(("a", "b")));
        assert_eq!(pinned_ids("/projects/a/pinned-branches"), None);
        assert_eq!(pinned_ids("/projects/a/sources/b/c/pinned-branches"), None);
        assert_eq!(pinned_ids("/projects//sources/b/pinned-branches"), None);
        assert!(!work_accepting("GET", "/projects/a/sources/b/pinned-branches"));
        assert!(!work_accepting("POST", "/projects/a/pinned-branches"));
        assert_eq!(decode_component("a%20b+c").as_deref(), Some("a b+c"));
        assert_eq!(decode_component("%zz"), None);
        assert_eq!(decode_component("%ff"), None);
    }

    #[test]
    fn a_port_is_read_like_node_reads_it_and_refused_like_node_refuses_it() {
        assert_eq!(["0", "8080", " 80abc"].map(|p| port_from(p).unwrap()), [0, 8080, 80]);
        for (text, got) in [("abc", "NaN"), ("", "NaN"), ("70000", "70000"), ("-1", "-1")] {
            assert_eq!(port_from(text).unwrap_err().to_string(), format!("options.port should be >= 0 and < 65536. Received type number ({got})."));
        }
    }

    async fn body_of(head: &str, first: &str, rest: &str) -> Option<String> {
        let head = format!("POST /kick HTTP/1.1\r\nHost: localhost\r\n{head}");
        read_body(&mut rest.as_bytes(), &head, first.as_bytes().to_vec()).await.unwrap().map(|b| String::from_utf8(b).unwrap())
    }

    #[tokio::test]
    async fn a_body_is_read_whole_however_it_is_framed() {
        assert_eq!(body_of("", "extra", "").await.as_deref(), Some(""));
        assert_eq!(body_of("Content-Length: 5", "ab", "cdefgh").await.as_deref(), Some("abcde"));
        let chunked = "Transfer-Encoding: Chunked";
        assert_eq!(body_of(chunked, "3\r", "\nabc\r\nA;x=1\r\n0123456789\r\n0\r\nT: v\r\n\r\n").await.as_deref(), Some("abc0123456789"));
        assert_eq!(body_of(chunked, "0\r\n\r\n", "").await.as_deref(), Some(""));
        let big = "x".repeat(9 << 20);
        assert_eq!(body_of(chunked, "", &format!("{:x}\r\n{big}\r\n0\r\n\r\n", big.len())).await.map(|b| b.len()), Some(big.len()));
    }

    #[tokio::test]
    async fn a_body_that_is_cut_short_or_badly_framed_is_no_body() {
        assert_eq!(body_of("Content-Length: 5", "ab", "c").await, None);
        assert_eq!(body_of("Content-Length: five", "abcde", "").await, None);
        let chunked = "Transfer-Encoding: chunked";
        for bad in ["zz\r\nabc\r\n0\r\n\r\n", "+3\r\nabc\r\n0\r\n\r\n", "3\r\nabcd\r\n0\r\n\r\n", "3\r\nabc\r\n", "3\r\nabc\r\n0\r\n", "ffffffffffffffff\r\nabc", ""] {
            assert_eq!(body_of(chunked, bad, "").await, None, "{bad:?}");
        }
        assert_eq!(body_of("Transfer-Encoding: gzip, chunked", "0\r\n\r\n", "").await, None);
        assert_eq!(body_of("Content-Length: 5\r\nTransfer-Encoding: chunked", "0\r\n\r\n", "").await, None);
    }

    #[test]
    fn only_an_empty_body_stands_for_no_fields() {
        assert_eq!(read_fields(b" \r\n\xEF\xBB\xBF", "a").unwrap(), json!({}));
        assert!(read_fields(b"{\"a\":", "a").unwrap_err().starts_with("SyntaxError: "));
        assert_eq!(read_fields(b"null", "a").unwrap_err(), "TypeError: Cannot read properties of null (reading 'a')");
        let body = json!({ "s": "x", "e": "", "n": 5, "z": 0, "f": false, "l": ["a"] });
        assert_eq!(["s", "e", "n", "z", "f", "l", "missing"].map(|k| id_field(&body, k)), [Some("x"), Some(""), Some("5"), None, None, Some("[\"a\"]"), None].map(|v| v.map(String::from)));
    }

    #[test]
    fn only_an_index_run_may_hold_up_leaving_past_half_a_minute() {
        let (s, cap) = (Duration::from_secs, Duration::from_secs(600));
        assert_eq!(drain_step(s(900), 0, 0, cap), Drain::Done);
        assert_eq!(drain_step(s(29), 1, 0, cap), Drain::Wait);
        assert_eq!(drain_step(s(30), 1, 0, cap), Drain::GiveUp);
        assert_eq!(drain_step(s(599), 2, 1, cap), Drain::Wait);
        assert_eq!(drain_step(s(600), 2, 1, cap), Drain::GiveUp);
        assert_eq!(drain_step(s(2), 1, 1, s(2)), Drain::GiveUp, "a cap below the other one");
    }

    #[test]
    fn a_refused_port_and_a_crash_are_recorded_in_todays_shapes() {
        let taken = bind_fallback(40000, &std::io::ErrorKind::AddrInUse.into(), DEFAULT_PORT);
        assert_eq!(taken.to_string(), r#"{"level":"warn","event":"daemon.bind.fallback","detail":{"refusedPort":40000,"code":"EADDRINUSE","nextPort":58451}}"#);
        assert_eq!(bind_fallback(DEFAULT_PORT, &std::io::ErrorKind::PermissionDenied.into(), 0)["detail"], json!({ "refusedPort": 58451, "code": "EACCES", "nextPort": "ephemeral" }));
        assert_eq!(crash_record("boom", Some("src/a.rs:1:2".into())).to_string(), r#"{"level":"error","event":"process.uncaughtException","error":{"message":"boom","stack":"boom\n    at src/a.rs:1:2","name":"panic"}}"#);
    }

    #[test]
    fn a_callers_text_stays_on_one_line() {
        assert_eq!(one_line("a\r\nb\tc\u{7f}é"), "a??b?c?é");
        assert_eq!(client_id("GET / HTTP/1.1\r\nX-Scrybe-Client-Id:  me:1 "), "me:1");
        assert_eq!(client_id("GET / HTTP/1.1\r\nX-Scrybe-Client-Id: "), "anon");
        assert_eq!(client_id("GET / HTTP/1.1"), "anon");
    }

    #[test]
    fn only_a_finished_run_over_everything_lists_the_projects() {
        assert!(with_projects(json!({ "status": "done", "project_id": "*" }))["projects"].is_array());
        for job in [json!({ "status": "running", "project_id": "*" }), json!({ "status": "done", "project_id": "a" })] {
            assert!(with_projects(job).get("projects").is_none());
        }
    }

    #[test]
    fn query_values_decode() {
        assert_eq!(query_param("a=1&project_id=my%20app", "project_id").as_deref(), Some("my app"));
        assert_eq!(query_param("a=1", "b"), None);
    }
}
