//! The one shared server. Mirrors `src/daemon/main.ts` and `http-server.ts`: data-dir ownership, a sticky
//! port, the Host and Origin gate on every route, jobs, heartbeats, and a shutdown that drains.
//! A small HTTP reader on purpose: one request per connection, no new compile cost.
//! Not yet: ticket polling, the vector index backfill, pinned-branch routes, the RSS guard, install.
use crate::autogc::{self, AutoGc};
use crate::config::{data_dir, VERSION};
use crate::index::refuse_live_data_dir;
use crate::jobs::{self, Queue, Request};
use crate::lifecycle::Lifecycle;
use crate::mcp;
use crate::registry;
use crate::store::Store;
use crate::watch::{self, Idle, WatchHealth};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const MAX_BODY: usize = 8 << 20;
pub const DEFAULT_PORT: u16 = 58451;
const DAEMON_TOOLS: &str = include_str!("daemon_tools.json");

struct Daemon {
    store: Arc<Store>,
    queue: Arc<Queue>,
    autogc: Arc<AutoGc>,
    lifecycle: Mutex<Lifecycle>,
    idle: Arc<Idle>,
    health: Arc<WatchHealth>,
    paused: AtomicBool,
    started_at: Instant,
    started_iso: String,
    port: u16,
    draining: AtomicBool,
    closing: AtomicBool,
    shutting_down: AtomicBool,
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
    matches!((method, path), ("POST", "/kick" | "/gc")) || (method == "DELETE" && path.starts_with("/jobs/")) || (matches!(method, "POST" | "DELETE") && path.starts_with("/projects/") && path.ends_with("/pinned-branches"))
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

    fn state_word(&self) -> &'static str {
        if self.paused.load(Ordering::SeqCst) {
            "paused"
        } else if self.idle.is_hot() {
            "hot"
        } else {
            "cold"
        }
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
            "state": self.state_word(),
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

    fn kick(&self, body: &Value) -> Value {
        let text = |k: &str| body[k].as_str().map(String::from);
        let ids: Vec<String> = match text("projectId") {
            Some(p) => vec![p],
            None => registry::list_projects().into_iter().map(|p| p.id).collect(),
        };
        let jobs: Vec<Value> = ids
            .into_iter()
            .map(|project| {
                let r = self.queue.submit(Request { project: project.clone(), source: text("sourceId"), branch: text("branch"), content_ref: text("contentRef"), full: body["mode"] == "full", gc_purge: None });
                let mut job = json!({ "jobId": r.job_id, "projectId": project, "sourceId": text("sourceId").unwrap_or_else(|| "all".into()), "branch": text("branch").unwrap_or_else(|| "HEAD".into()), "status": r.status });
                if let Some(q) = r.queue_position {
                    job["queuePosition"] = json!(q);
                }
                job["duplicateOfPending"] = json!(r.duplicate_of_pending);
                job
            })
            .collect();
        json!({ "jobs": jobs })
    }

    fn submit_tool(&self, a: &Value, source: Option<String>) -> Result<Value> {
        let project = a["project_id"].as_str().unwrap_or("").to_string();
        let full = a["mode"] == "full";
        if registry::get_project(&project).is_none() {
            anyhow::bail!("Project '{project}' not found");
        }
        let r = self.queue.submit(Request { project: project.clone(), source: source.clone(), branch: a["branch"].as_str().map(String::from), content_ref: a["content_ref"].as_str().map(String::from), full, gc_purge: None });
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
                self.queue.job_status(id).with_context(|| format!("Job '{id}' not found"))
            }
            "cancel_reindex" => {
                let id = a["job_id"].as_str().unwrap_or("");
                Ok(json!({ "job_id": id, "cancelled": self.queue.cancel(id, a["source_id"].as_str()) }))
            }
            "list_jobs" => self.queue.list_jobs(a["status"].as_str()).map(|jobs| json!({ "count": jobs.len(), "jobs": jobs })),
            "queue_status" => self.queue.rows.queue_status(a["project_id"].as_str()).map(|(running, queued)| json!({ "running": running, "queued": queued, "awaiting_migration": [] })),
            "status" => Ok(self.status_tool()),
            "gc" => self.gc_tool(a),
            _ => return None,
        })
    }

    fn status_tool(&self) -> Value {
        let mut out = json!({ "version": VERSION, "daemon_running": true, "daemon_pid": std::process::id(), "daemon_port": self.port, "daemon_version": VERSION });
        for (k, v) in registry::embedding_status().as_object().into_iter().flatten() {
            out[k] = v.clone();
        }
        out
    }

    async fn rpc(&self, req: &Value) -> String {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let name = req.get("method").and_then(Value::as_str).unwrap_or("");
        let args = req.get("params").cloned().unwrap_or_else(|| json!({}));
        let tools: Value = serde_json::from_str(DAEMON_TOOLS).unwrap_or(Value::Null);
        let Some(spec) = tools.as_array().and_then(|t| t.iter().find(|x| x["name"] == name)) else {
            return mcp::rpc(&self.store, req).await;
        };
        let fail = |code: i64, message: &str| json!({ "id": id, "error": { "code": code, "message": message } }).to_string();
        if let Err(message) = mcp::validate_params(name, &spec["inputSchema"], &args) {
            return fail(-32602, &message);
        }
        match self.run_tool(name, &args) {
            Some(Ok(result)) => json!({ "id": id, "result": result }).to_string(),
            Some(Err(e)) => {
                eprintln!("tool {name} failed: {e:#}");
                fail(-32603, "internal error")
            }
            None => fail(-32601, &format!("method not found: {name}")),
        }
    }

    fn manifest(&self) -> Value {
        let mut all = mcp::tool_list();
        let extra: Value = serde_json::from_str(DAEMON_TOOLS).unwrap_or(json!([]));
        if let (Some(a), Some(e)) = (all.as_array_mut(), extra.as_array()) {
            a.extend(e.iter().cloned());
        }
        json!({ "daemon_version": VERSION, "tools": all })
    }

    /// `shutdown` in main.ts: keep answering while jobs finish, then close and exit.
    async fn shutdown(self: Arc<Self>, why: String) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("[scrybe daemon] {why} — shutting down");
        self.draining.store(true, Ordering::SeqCst);
        let cap = std::env::var("SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(30 * 60 * 1000);
        let end = Instant::now() + Duration::from_millis(cap);
        while self.queue.active_count() > 0 && Instant::now() < end {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        self.closing.store(true, Ordering::SeqCst);
        self.queue.cancel_all();
        leave();
    }
}

fn leave() -> ! {
    let _ = std::fs::remove_file(data_dir().join("daemon.pid"));
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

    let mut body = buf[head_end + 4..].to_vec();
    let len: usize = header(&head, "content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return respond(&mut s, "413 Payload Too Large", "text/plain", "too large").await;
    }
    while body.len() < len {
        let mut chunk = vec![0u8; (len - body.len()).min(64 << 10)];
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let parsed: Value = if body.iter().all(u8::is_ascii_whitespace) { json!({}) } else { serde_json::from_slice(&body).unwrap_or(Value::Null) };

    match (method, path) {
        ("GET", "/status") => json_res(&mut s, "200 OK", &d.status()).await,
        ("GET", "/events") => events(s, d, query).await,
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
        ("POST", "/kick") => json_res(&mut s, "200 OK", &d.kick(&parsed)).await,
        ("POST", "/gc") => {
            let purge = parsed["mode"].as_str() != Some("grace");
            let scope: Vec<String> = match parsed["scope"].as_array().filter(|a| !a.is_empty()) {
                Some(list) => list.iter().filter_map(Value::as_str).map(String::from).collect(),
                None => registry::list_projects().into_iter().filter(|p| p.sources.iter().any(|x| x.kind() == "code")).map(|p| p.id).collect(),
            };
            json_res(&mut s, "200 OK", &d.gc(scope, parsed["sourceId"].as_str().map(String::from), purge)).await
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
            d.paused.store(true, Ordering::SeqCst);
            json_res(&mut s, "200 OK", &json!({ "state": "paused" })).await
        }
        ("POST", "/resume") => {
            d.paused.store(false, Ordering::SeqCst);
            d.idle.touch();
            json_res(&mut s, "200 OK", &json!({ "state": "hot" })).await
        }
        ("POST", "/shutdown") => {
            json_res(&mut s, "200 OK", &json!({ "state": "stopping" })).await?;
            tokio::spawn(d.clone().shutdown("HTTP /shutdown".to_string()));
            Ok(())
        }
        ("POST", "/clients/heartbeat") => {
            if let Some(id) = parsed["clientId"].as_str() {
                d.lifecycle.lock().unwrap().heartbeat(id, Instant::now());
            }
            json_res(&mut s, "200 OK", &json!({ "ok": true })).await
        }
        ("POST", "/clients/unregister") => {
            if let Some(id) = parsed["clientId"].as_str() {
                d.lifecycle.lock().unwrap().unregister(id, Instant::now());
            }
            json_res(&mut s, "200 OK", &json!({ "ok": true })).await
        }
        ("GET", "/mcp/manifest") => json_res(&mut s, "200 OK", &d.manifest()).await,
        ("POST", "/mcp/rpc") => {
            if parsed.is_null() {
                return json_res(&mut s, "200 OK", &json!({ "id": null, "error": { "code": -32600, "message": "invalid request: body is not valid JSON" } })).await;
            }
            let answer = d.rpc(&parsed).await;
            respond(&mut s, "200 OK", "application/json", &answer).await
        }
        (_, "/mcp") => {
            let enabled = std::env::var("SCRYBE_DAEMON_MCP_HTTP").ok().is_some_and(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true"));
            if !enabled {
                return json_res(&mut s, "404 Not Found", &json!({ "error": "Not found" })).await;
            }
            if method != "POST" {
                return json_res(&mut s, "405 Method Not Allowed", &json!({ "jsonrpc": "2.0", "error": { "code": -32000, "message": "Method not allowed." }, "id": null })).await;
            }
            match mcp::handle(&d.store, &parsed).await {
                Some(answer) => respond(&mut s, "200 OK", "application/json", &answer.to_string()).await,
                None => respond(&mut s, "202 Accepted", "text/plain", "").await,
            }
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
    loop {
        match feed.recv().await {
            Ok(line) => s.write_all(format!("data: {line}\n\n").as_bytes()).await?,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => return Ok(()),
        }
    }
}

fn retryable_bind(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied)
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

async fn bind_sticky() -> Result<TcpListener> {
    if let Some(p) = std::env::var("SCRYBE_DAEMON_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
        return Ok(TcpListener::bind(("127.0.0.1", p)).await?);
    }
    let stale = std::fs::read_to_string(data_dir().join("daemon.pid")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["port"].as_u64()).map(|p| p as u16);
    let mut last = None;
    for port in port_candidates(stale) {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok(l),
            Err(e) if retryable_bind(&e) => {
                eprintln!("[scrybe daemon] port {port} refused ({e})");
                last = Some(e);
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(anyhow::anyhow!("All candidate ports were refused (stale pidfile port, {DEFAULT_PORT}, and an OS-assigned ephemeral port): {last:?}"))
}

async fn wait_for_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => return "SIGTERM",
                _ = tokio::signal::ctrl_c() => return "SIGINT",
            }
        }
    }
    let _ = tokio::signal::ctrl_c().await;
    "SIGINT"
}

pub async fn serve(store: Store) -> Result<()> {
    // daemon.pid would point real clients at this unfinished server.
    refuse_live_data_dir()?;
    std::fs::create_dir_all(data_dir())?;
    // Same lock file as the TypeScript daemon: the operating system drops it if this process dies.
    let owner = rusqlite::Connection::open(data_dir().join("daemon-owner.lock.db"))?;
    owner.busy_timeout(Duration::ZERO)?;
    if owner.execute_batch("BEGIN IMMEDIATE").is_err() {
        eprintln!("another server owns this data dir");
        return Ok(());
    }
    let listener = bind_sticky().await?;
    let port = listener.local_addr()?.port();
    let store = Arc::new(store);
    let queue = Queue::new(store.clone())?;
    let interrupted = queue.rows.mark_interrupted()?;
    if interrupted > 0 {
        eprintln!("[scrybe] marked {interrupted} job(s) from an earlier server as interrupted");
    }
    let started_iso = jobs::now_iso();
    let exec = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let pid = json!({ "pid": std::process::id(), "port": port, "startedAt": started_iso, "version": VERSION, "dataDir": data_dir().to_string_lossy(), "execPath": exec });
    std::fs::write(data_dir().join("daemon.pid"), pid.to_string())?;
    eprintln!("[scrybe daemon] started pid={} port={port} dataDir={}", std::process::id(), data_dir().display());

    let now = Instant::now();
    let (idle, health) = (Arc::new(Idle::from_env()), Arc::new(WatchHealth::default()));
    let d = Arc::new(Daemon { store, queue: queue.clone(), autogc: AutoGc::new(queue.clone()), lifecycle: Mutex::new(Lifecycle::from_env(now)), idle: idle.clone(), health: health.clone(), paused: AtomicBool::new(false), started_at: now, started_iso, port, draining: AtomicBool::new(false), closing: AtomicBool::new(false), shutting_down: AtomicBool::new(false) });
    let _owner = owner;
    d.autogc.start();
    watch::start(queue.clone(), idle, health, &registry::list_projects());
    autogc::sweep_ephemeral(&queue);

    let ticking = d.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let active = ticking.queue.active_count();
            let leave_now = ticking.lifecycle.lock().unwrap().tick(Instant::now(), active);
            if let Some(reason) = leave_now {
                eprintln!("[scrybe daemon] no active clients ({}) — shutting down", reason.as_str());
                ticking.clone().shutdown(reason.as_str().to_string()).await;
            }
        }
    });

    let signals = d.clone();
    tokio::spawn(async move {
        let first = wait_for_signal().await;
        tokio::spawn(signals.clone().shutdown(first.to_string()));
        let second = wait_for_signal().await;
        eprintln!("[scrybe daemon] {second} received again while shutting down — forcing immediate exit");
        leave();
    });

    loop {
        let (socket, _) = listener.accept().await?;
        let d = d.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(socket, d).await {
                eprintln!("request failed: {e:#}");
            }
        });
    }
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
        assert!(work_accepting("DELETE", "/jobs/abc"));
        assert!(work_accepting("POST", "/projects/a/sources/b/pinned-branches"));
        assert!(!work_accepting("GET", "/jobs/abc"));
        assert!(!work_accepting("POST", "/mcp/rpc"));
    }

    #[test]
    fn query_values_decode() {
        assert_eq!(query_param("a=1&project_id=my%20app", "project_id").as_deref(), Some("my app"));
        assert_eq!(query_param("a=1", "b"), None);
    }
}
