//! scrybe-relay: the process an MCP client starts. It answers the handshake itself, carries tool calls
//! to the one shared server, keeps that server alive with heartbeats, starts it when it's missing and
//! finds it again after a restart. It holds no index and no model.
mod json;

use std::io::{BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SUPPORTED_PROTOCOLS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST_PROTOCOL: &str = SUPPORTED_PROTOCOLS[0];
const VERSION: &str = env!("CARGO_PKG_VERSION");

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const COLD_START_DEFAULT_MS: u64 = 15_000;
const COLD_START_CEILING_MS: u64 = 20_000;
const CALL_START_BUDGET: Duration = Duration::from_secs(15);
const INIT_START_BUDGET: Duration = Duration::from_secs(30);
const POLL_EVERY: Duration = Duration::from_secs(2);
const POLL_FOR: Duration = Duration::from_secs(300);
const RESTART_START_AFTER: Duration = Duration::from_secs(2);

fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("SCRYBE_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let home = PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default());
    if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local")).join("scrybe").join("scrybe")
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join("scrybe")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share")).join("scrybe")
    }
}

fn read_pidfile() -> Option<String> {
    std::fs::read_to_string(data_dir().join("daemon.pid")).ok()
}

fn pidfile_port() -> Option<u16> {
    json::get(&read_pidfile()?, "port")?.parse().ok()
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum HttpError {
    /// Nothing reached the server, so trying again can't repeat work.
    Connect(String),
    /// The connection died with no answer, so the server may or may not have done the work.
    Lost(String),
    Other(String),
}

#[derive(Debug)]
struct Reply {
    status: u16,
    body: String,
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len());
    let mut rest = body;
    while let Some(i) = rest.windows(2).position(|w| w == b"\r\n") {
        let size = std::str::from_utf8(&rest[..i]).ok().and_then(|s| usize::from_str_radix(s.split(';').next().unwrap_or("").trim(), 16).ok()).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = i + 2;
        let end = (start + size).min(rest.len());
        out.extend_from_slice(&rest[start..end]);
        rest = rest.get(end + 2..).unwrap_or(&[]);
    }
    out
}

fn parse_reply(raw: &[u8]) -> Result<Reply, HttpError> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| HttpError::Lost("scrybe server closed the connection without answering".to_string()))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| HttpError::Other("malformed response from scrybe server".to_string()))?;
    let chunked = head.lines().any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked"));
    let body = &raw[split + 4..];
    let body = if chunked { dechunk(body) } else { body.to_vec() };
    Ok(Reply { status, body: String::from_utf8_lossy(&body).into_owned() })
}

fn http(port: u16, method: &str, path: &str, extra_header: &str, body: &str, timeout: Duration) -> Result<Reply, HttpError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2).min(timeout)).map_err(|e| HttpError::Connect(e.to_string()))?;
    s.set_read_timeout(Some(timeout)).and_then(|_| s.set_write_timeout(Some(timeout))).map_err(|e| HttpError::Other(e.to_string()))?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n{extra_header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(request.as_bytes()).map_err(|e| HttpError::Lost(e.to_string()))?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| match e.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => HttpError::Other(format!("scrybe server didn't answer within {} s", timeout.as_secs())),
        _ => HttpError::Lost(e.to_string()),
    })?;
    parse_reply(&raw)
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Health {
    Up,
    Draining,
    Down,
}

fn health(port: u16, timeout: Duration) -> Health {
    match http(port, "GET", "/health", "", "", timeout) {
        Ok(r) if (200..300).contains(&r.status) => {
            if json::get(&r.body, "draining") == Some("true") {
                Health::Draining
            } else {
                Health::Up
            }
        }
        _ => Health::Down,
    }
}

// ─── Relay ───────────────────────────────────────────────────────────────────

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Unknown,
    Serving,
    Degraded,
}

struct State {
    mode: Mode,
    poll_until: Option<Instant>,
    tools: Option<String>,
    daemon_pid: Option<String>,
}

enum RpcFail {
    /// The server wasn't there, or is going away: a replacement can take the call.
    Unreachable(String),
    Failed(String),
}

struct Relay<W: Write + Send> {
    out: Mutex<W>,
    client_id: String,
    start_cmd: Vec<String>,
    auto_start: bool,
    cold_budget: Duration,
    state: Mutex<State>,
    start_gate: Mutex<Option<Instant>>,
    starter_running: Arc<AtomicBool>,
    resolved: AtomicBool,
}

/// These only read, so one lost with its server can go to the replacement without repeating any work.
fn resend_is_safe(name_raw: &str) -> bool {
    matches!(json::bare(name_raw), Some("search_code" | "search_knowledge" | "lookup_symbol" | "list_projects"))
}

fn default_start_cmd() -> Vec<String> {
    let npx: &[&str] = if cfg!(windows) { &["cmd", "/c", "npx"] } else { &["npx"] };
    npx.iter().copied().chain(["-y", "scrybe-cli@latest", "daemon", "up"]).map(String::from).collect()
}

fn text_result(raw_json: &str, is_error: bool) -> String {
    let flag = if is_error { r#","isError":true"# } else { "" };
    format!(r#"{{"content":[{{"type":"text","text":{}}}]{flag}}}"#, json::quote(&json::pretty(raw_json)))
}

fn error_result(message: &str) -> String {
    text_result(&format!(r#"{{"error":{}}}"#, json::quote(message)), true)
}

/// What `tools/call` returns for a good /mcp/rpc body. A background job answers with its id at once.
fn result_from_rpc(body: &str) -> Result<String, String> {
    if let Some(err) = json::get(body, "error").filter(|e| *e != "null") {
        let message = json::get(err, "message").unwrap_or(r#""scrybe server returned an error""#);
        return Err(format!(r#"{{"error":{message}}}"#));
    }
    let result = json::get(body, "result").unwrap_or("null");
    Ok(match json::get(result, "jobId") {
        Some(id) => format!(r#"{{"job_id":{id},"status":"started"}}"#),
        None => result.to_string(),
    })
}

fn offline_tools(config_present: bool) -> String {
    let (status, init) = if config_present {
        (
            "Return a quick scrybe status snapshot. The daemon is currently unavailable. To restore full tool access, run `scrybe daemon start` and reconnect.",
            "Attempt to start the scrybe daemon and guide reconnection. Scrybe is configured but the daemon is not running.",
        )
    } else {
        (
            "Return a quick scrybe status snapshot. Scrybe is not yet configured: run `scrybe init` from the command line to set up a provider, then reconnect.",
            "Guide scrybe initial setup. Scrybe is not yet configured: run `scrybe init` from the command line, then restart the daemon and reconnect.",
        )
    };
    let empty = r#"{"type":"object","properties":{},"required":[]}"#;
    format!(
        r#"{{"tools":[{{"name":"status","description":{},"inputSchema":{empty}}},{{"name":"doctor","description":"The scrybe daemon is unavailable, so this points you at the command-line health check.","inputSchema":{{"type":"object","properties":{{"section":{{"type":"string","description":"Optional section filter"}}}},"required":[]}}}},{{"name":"init","description":{},"inputSchema":{empty}}}]}}"#,
        json::quote(status),
        json::quote(init)
    )
}

impl<W: Write + Send> Relay<W> {
    fn write_line(&self, line: &str) {
        let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
        if out.write_all(line.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush()).is_err() {
            // The client has gone.
            std::process::exit(0);
        }
    }

    fn answer(&self, id: &str, result: &str) {
        self.write_line(&format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#));
    }

    fn answer_error(&self, id: &str, code: i64, message: &str) {
        self.write_line(&format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":{}}}}}"#, json::quote(message)));
    }

    fn set_mode(&self, new: Mode) {
        let notify = {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let prev = st.mode;
            st.mode = new;
            if new == Mode::Degraded && prev != Mode::Degraded {
                st.poll_until = Some(Instant::now() + POLL_FOR);
            }
            prev != Mode::Unknown && prev != new
        };
        if notify {
            self.list_changed();
        }
    }

    fn list_changed(&self) {
        self.write_line(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#);
    }

    fn start_server(&self, last_start: &mut Option<Instant>) {
        if !self.auto_start || self.starter_running.load(Ordering::SeqCst) || last_start.is_some_and(|t| t.elapsed() < RESTART_START_AFTER) {
            return;
        }
        let Some((program, args)) = self.start_cmd.split_first() else { return };
        *last_start = Some(Instant::now());
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        if let Ok(mut child) = cmd.spawn() {
            let running = self.starter_running.clone();
            running.store(true, Ordering::SeqCst);
            std::thread::spawn(move || {
                let _ = child.wait();
                running.store(false, Ordering::SeqCst);
            });
        }
    }

    /// A port with a live server, starting one if allowed. Only one thread does this at a time.
    fn ensure(&self, budget: Duration, may_start: bool) -> Option<u16> {
        let mut last_start = self.start_gate.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + budget;
        loop {
            let mut draining = None;
            match pidfile_port() {
                Some(port) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    match health(port, left.clamp(Duration::from_millis(250), Duration::from_secs(2))) {
                        Health::Up => return Some(port),
                        Health::Draining => draining = Some(port),
                        Health::Down if may_start => self.start_server(&mut last_start),
                        Health::Down => {}
                    }
                }
                None if may_start => self.start_server(&mut last_start),
                None => {}
            }
            if Instant::now() >= deadline {
                return draining;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn manifest_tools(&self, port: u16) -> Option<String> {
        let r = http(port, "GET", "/mcp/manifest", "", "", Duration::from_secs(5)).ok()?;
        if !(200..300).contains(&r.status) {
            return None;
        }
        json::get(&r.body, "tools").map(str::to_string)
    }

    /// Records a served tool list and tells the client if a restarted server changed it.
    fn serve_tools(&self, tools: &str) {
        let changed = {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let changed = st.mode == Mode::Serving && st.tools.as_deref().is_some_and(|t| t != tools);
            st.tools = Some(tools.to_string());
            changed
        };
        self.set_mode(Mode::Serving);
        if changed {
            self.list_changed();
        }
    }

    fn cold_budget_once(&self) -> Option<Duration> {
        (!self.resolved.swap(true, Ordering::SeqCst)).then_some(self.cold_budget)
    }

    fn list_tools(&self) -> String {
        let first = self.cold_budget_once();
        let may_start = first.is_some_and(|b| !b.is_zero());
        let port = self.ensure(first.unwrap_or(Duration::ZERO), may_start);
        if let Some(tools) = port.and_then(|p| self.manifest_tools(p)) {
            self.serve_tools(&tools);
            return format!(r#"{{"tools":{tools}}}"#);
        }
        self.set_mode(Mode::Degraded);
        offline_tools(data_dir().join("config.json").exists())
    }

    fn rpc_once(&self, port: u16, name: &str, args: &str) -> Result<String, RpcFail> {
        let header = format!("X-Scrybe-Client-Id: {}\r\n", self.client_id);
        let body = format!(r#"{{"id":"relay","method":{name},"params":{args}}}"#);
        let r = http(port, "POST", "/mcp/rpc", &header, &body, CALL_TIMEOUT).map_err(|e| match e {
            HttpError::Connect(m) => RpcFail::Unreachable(m),
            HttpError::Lost(m) if resend_is_safe(name) => RpcFail::Unreachable(m),
            HttpError::Lost(m) => RpcFail::Failed(m),
            HttpError::Other(m) => RpcFail::Failed(m),
        })?;
        if !(200..300).contains(&r.status) {
            let message = format!("daemon RPC returned HTTP {}", r.status);
            let draining = r.status == 503 && json::get(&r.body, "draining") == Some("true");
            return Err(if draining { RpcFail::Unreachable(message) } else { RpcFail::Failed(message) });
        }
        Ok(r.body)
    }

    fn call_tool(&self, name_raw: &str, args: &str) -> String {
        let budget = self.cold_budget_once().unwrap_or(CALL_START_BUDGET);
        let may_start = !budget.is_zero();
        let mut tried = None;
        let mut failure = String::from("scrybe server is not running");
        // The port we know, then a new one if the pidfile moved, then a started server.
        for attempt in 0..3 {
            let port = match attempt {
                2 => self.ensure(budget, may_start),
                _ => pidfile_port().filter(|p| tried != Some(*p)),
            };
            let Some(port) = port else { continue };
            tried = Some(port);
            match self.rpc_once(port, name_raw, args) {
                Ok(body) => {
                    self.set_mode_after_call();
                    return match result_from_rpc(&body) {
                        Ok(result) => text_result(&result, false),
                        Err(error) => text_result(&error, true),
                    };
                }
                Err(RpcFail::Failed(message)) => return error_result(&message),
                Err(RpcFail::Unreachable(message)) => failure = message,
            }
        }
        self.set_mode(Mode::Degraded);
        self.offline_answer(json::bare(name_raw).unwrap_or(""), &failure)
    }

    /// A call got through, so a degraded session is back and the client gets told to re-list.
    fn set_mode_after_call(&self) {
        let degraded = self.state.lock().unwrap_or_else(|e| e.into_inner()).mode == Mode::Degraded;
        if degraded {
            self.set_mode(Mode::Serving);
        }
    }

    fn offline_answer(&self, name: &str, failure: &str) -> String {
        let port = pidfile_port().map_or("null".to_string(), |p| p.to_string());
        match name {
            "status" => text_result(&format!(r#"{{"version":{},"daemon_running":false,"daemon_pid":null,"daemon_port":{port},"daemon_version":null,"note":"Answered by the relay: the scrybe server isn't reachable."}}"#, json::quote(VERSION)), false),
            "doctor" => error_result("The scrybe server isn't reachable and the relay can't run the health check itself. Run: scrybe doctor"),
            "init" => {
                let (ok, status, message) = if self.ensure(INIT_START_BUDGET, self.auto_start).is_some() {
                    (true, "daemon_started", "The scrybe daemon has been started. Then call `init` again with your provider settings to complete configuration.")
                } else if !data_dir().join("config.json").exists() {
                    (false, "config_missing", "Scrybe is not configured yet. Run `scrybe init` from the command line, then start the daemon with `scrybe daemon start` and reconnect.")
                } else {
                    (false, "daemon_unavailable", "Scrybe is configured but the daemon could not be started automatically. Run `scrybe daemon start` from the command line, then reconnect.")
                };
                text_result(&format!(r#"{{"ok":{ok},"status":{},"message":{}}}"#, json::quote(status), json::quote(message)), !ok)
            }
            _ => error_result(&format!("The scrybe server isn't reachable ({failure}). Run: scrybe daemon start")),
        }
    }

    fn initialize(&self, params: &str) -> String {
        let asked = json::get(params, "protocolVersion").and_then(json::bare);
        let version = asked.filter(|v| SUPPORTED_PROTOCOLS.contains(v)).unwrap_or(LATEST_PROTOCOL);
        format!(r#"{{"protocolVersion":"{version}","capabilities":{{"tools":{{"listChanged":true}}}},"serverInfo":{{"name":"scrybe","version":"{VERSION}"}}}}"#)
    }

    fn heartbeat(&self) {
        if let Some(port) = pidfile_port() {
            let body = format!(r#"{{"clientId":{},"pid":{}}}"#, json::quote(&self.client_id), std::process::id());
            let _ = http(port, "POST", "/clients/heartbeat", "", &body, Duration::from_secs(3));
        }
    }

    fn unregister(&self) {
        if let Some(port) = pidfile_port() {
            let body = format!(r#"{{"clientId":{}}}"#, json::quote(&self.client_id));
            let _ = http(port, "POST", "/clients/unregister", "", &body, Duration::from_secs(2));
        }
    }

    /// While degraded: has the server come back? While serving: did it restart with a different tool list?
    fn watch_tick(&self) {
        let (mode, polling) = {
            let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (st.mode, st.poll_until.is_some_and(|t| Instant::now() < t))
        };
        if mode == Mode::Degraded && polling {
            if let Some(port) = pidfile_port().filter(|p| health(*p, Duration::from_secs(2)) == Health::Up) {
                if let Some(tools) = self.manifest_tools(port) {
                    self.serve_tools(&tools);
                }
            }
        }
    }

    fn restart_check(&self) {
        let pid = read_pidfile().and_then(|t| json::get(&t, "pid").map(str::to_string));
        let (mode, moved) = {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let moved = pid.is_some() && st.daemon_pid.is_some() && st.daemon_pid != pid;
            if pid.is_some() {
                st.daemon_pid = pid;
            }
            (st.mode, moved)
        };
        if mode == Mode::Serving && moved {
            if let Some(tools) = pidfile_port().and_then(|p| self.manifest_tools(p)) {
                self.serve_tools(&tools);
            }
        }
    }
}

fn watch_loop<W: Write + Send>(relay: &Relay<W>, heartbeat_every: Duration) {
    relay.heartbeat();
    relay.restart_check();
    let mut last_beat = Instant::now();
    loop {
        std::thread::sleep(POLL_EVERY.min(heartbeat_every));
        relay.watch_tick();
        if last_beat.elapsed() >= heartbeat_every {
            last_beat = Instant::now();
            relay.heartbeat();
            relay.restart_check();
        }
    }
}

fn handle_line<W: Write + Send + 'static>(relay: &Arc<Relay<W>>, line: &str) {
    let Some(msg) = json::fields(line) else {
        relay.write_line(r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#);
        return;
    };
    let field = |k: &str| msg.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
    let (Some(id), Some(method)) = (field("id"), field("method").and_then(json::bare)) else {
        // A notification, or a reply to something we never asked. Neither gets an answer.
        return;
    };
    let params = field("params").unwrap_or("{}");
    match method {
        "initialize" => relay.answer(id, &relay.initialize(params)),
        "ping" => relay.answer(id, "{}"),
        "tools/list" | "tools/call" => {
            let (relay, id, method, params) = (relay.clone(), id.to_string(), method.to_string(), params.to_string());
            // One thread per call: a slow search must not hold up the others.
            std::thread::spawn(move || {
                if method == "tools/list" {
                    relay.answer(&id, &relay.list_tools());
                    return;
                }
                let Some(name) = json::get(&params, "name").filter(|n| n.starts_with('"')) else {
                    relay.answer_error(&id, -32602, "Invalid params: tools/call needs a tool name");
                    return;
                };
                let args = json::get(&params, "arguments").filter(|a| *a != "null").unwrap_or("{}");
                relay.answer(&id, &relay.call_tool(name, args));
            });
        }
        other => relay.answer_error(id, -32601, &format!("Method not found: {other}")),
    }
}

fn start_cmd_from_args(args: &[String]) -> Vec<String> {
    match args.iter().position(|a| a == "--start") {
        Some(i) if i + 1 < args.len() => args[i + 1..].to_vec(),
        _ => default_start_cmd(),
    }
}

fn cold_budget_from(raw: Option<String>) -> Duration {
    let ms = raw.and_then(|v| v.parse::<u64>().ok()).unwrap_or(COLD_START_DEFAULT_MS);
    Duration::from_millis(ms.min(COLD_START_CEILING_MS))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("scrybe-relay {VERSION}");
        return;
    }
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let relay = Arc::new(Relay {
        out: Mutex::new(std::io::stdout()),
        client_id: format!("relay:{}:{started}", std::process::id()),
        start_cmd: start_cmd_from_args(&args),
        auto_start: std::env::var("SCRYBE_NO_AUTO_DAEMON").as_deref() != Ok("1"),
        cold_budget: cold_budget_from(std::env::var("SCRYBE_MCP_COLD_START_WAIT_MS").ok()),
        state: Mutex::new(State { mode: Mode::Unknown, poll_until: None, tools: None, daemon_pid: None }),
        start_gate: Mutex::new(None),
        starter_running: Arc::new(AtomicBool::new(false)),
        resolved: AtomicBool::new(false),
    });
    let beat_ms = std::env::var("SCRYBE_DAEMON_HEARTBEAT_MS").ok().and_then(|v| v.parse().ok()).filter(|ms| *ms > 0).unwrap_or(30_000);
    let watcher = relay.clone();
    std::thread::spawn(move || watch_loop(&watcher, Duration::from_millis(beat_ms)));

    let mut input = std::io::stdin().lock();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        if !line.trim().is_empty() {
            handle_line(&relay, line.trim());
        }
    }
    relay.unregister();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A one-shot server that answers the next `n` connections with fixed bytes and returns what it read.
    fn fake_server(answers: Vec<Vec<u8>>) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for answer in answers {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).into_owned());
                s.write_all(&answer).unwrap();
            }
            seen
        });
        (port, handle)
    }

    #[test]
    fn reads_plain_and_chunked_replies() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec();
        let chunked = b"HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n".to_vec();
        let (port, server) = fake_server(vec![plain, chunked]);
        let a = http(port, "GET", "/health", "", "", Duration::from_secs(5)).unwrap();
        assert_eq!((a.status, a.body.as_str()), (200, "ok"));
        let b = http(port, "POST", "/mcp/rpc", "X-Scrybe-Client-Id: c\r\n", "{}", Duration::from_secs(5)).unwrap();
        assert_eq!((b.status, b.body.as_str()), (503, "hello world"));
        let seen = server.join().unwrap();
        assert!(seen[1].contains("X-Scrybe-Client-Id: c\r\n") && seen[1].ends_with("\r\n\r\n{}"), "{}", seen[1]);
        assert!(!seen[0].to_lowercase().contains("origin:"), "the server treats an Origin header as a browser");
    }

    #[test]
    fn a_refused_port_counts_as_never_reached() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(matches!(http(port, "GET", "/health", "", "", Duration::from_secs(1)), Err(HttpError::Connect(_))));
        assert_eq!(health(port, Duration::from_secs(1)), Health::Down);
    }

    #[test]
    fn a_silent_server_times_out_instead_of_hanging() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let t = Instant::now();
        let err = http(port, "GET", "/health", "", "", Duration::from_millis(300)).unwrap_err();
        assert!(matches!(err, HttpError::Other(_)), "{err:?}");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn an_answerless_close_is_an_error_not_a_panic() {
        assert!(parse_reply(b"").is_err());
        assert!(parse_reply(b"HTTP/1.1 nope\r\n\r\n").is_err());
    }

    #[test]
    fn only_read_tools_are_resent_after_a_lost_connection() {
        assert!(resend_is_safe(r#""search_code""#) && resend_is_safe(r#""lookup_symbol""#));
        assert!(!resend_is_safe(r#""reindex_project""#) && !resend_is_safe(r#""gc""#) && !resend_is_safe("7"));
        assert!(matches!(parse_reply(b""), Err(HttpError::Lost(_))));
        assert!(matches!(parse_reply(b"HTTP/1.1 nope\r\n\r\n"), Err(HttpError::Other(_))));
    }

    #[test]
    fn draining_health_is_told_apart() {
        let (port, server) = fake_server(vec![
            b"HTTP/1.1 200 OK\r\n\r\n{\"ready\":true,\"draining\":true}".to_vec(),
            b"HTTP/1.1 200 OK\r\n\r\n{\"ready\":true,\"draining\":false}".to_vec(),
            b"HTTP/1.1 503 Nope\r\n\r\n{}".to_vec(),
        ]);
        assert_eq!(health(port, Duration::from_secs(5)), Health::Draining);
        assert_eq!(health(port, Duration::from_secs(5)), Health::Up);
        assert_eq!(health(port, Duration::from_secs(5)), Health::Down);
        server.join().unwrap();
    }

    #[test]
    fn rpc_bodies_become_the_same_results_as_the_old_client() {
        assert_eq!(result_from_rpc(r#"{"id":"x","result":[1,{"a":2.50}]}"#).unwrap(), r#"[1,{"a":2.50}]"#);
        assert_eq!(result_from_rpc(r#"{"id":"x","result":{"jobId":"j1","other":1}}"#).unwrap(), r#"{"job_id":"j1","status":"started"}"#);
        assert_eq!(result_from_rpc(r#"{"id":"x","error":{"code":-32602,"message":"bad \"field\""}}"#).unwrap_err(), r#"{"error":"bad \"field\""}"#);
        assert_eq!(result_from_rpc(r#"{"id":"x","error":null,"result":3}"#).unwrap(), "3");
    }

    #[test]
    fn text_results_are_wrapped_like_the_old_client() {
        assert_eq!(text_result(r#"{"a":[1]}"#, false), r#"{"content":[{"type":"text","text":"{\n  \"a\": [\n    1\n  ]\n}"}]}"#);
        assert!(text_result("1", true).ends_with(r#","isError":true}"#));
    }

    #[test]
    fn start_command_and_budget_settings() {
        assert!(default_start_cmd().ends_with(&["-y".to_string(), "scrybe-cli@latest".to_string(), "daemon".to_string(), "up".to_string()]));
        let args: Vec<String> = ["--start", "node", "x.js", "daemon", "up"].map(String::from).to_vec();
        assert_eq!(start_cmd_from_args(&args), &args[1..]);
        assert_eq!(start_cmd_from_args(&["--start".to_string()]), default_start_cmd());
        assert_eq!(cold_budget_from(None), Duration::from_millis(COLD_START_DEFAULT_MS));
        assert_eq!(cold_budget_from(Some("0".into())), Duration::ZERO);
        assert_eq!(cold_budget_from(Some("99999".into())), Duration::from_millis(COLD_START_CEILING_MS));
        assert_eq!(cold_budget_from(Some("junk".into())), Duration::from_millis(COLD_START_DEFAULT_MS));
    }

    fn test_relay() -> Arc<Relay<Vec<u8>>> {
        Arc::new(Relay {
            out: Mutex::new(Vec::new()),
            client_id: "t".into(),
            start_cmd: vec![],
            auto_start: false,
            cold_budget: Duration::ZERO,
            state: Mutex::new(State { mode: Mode::Unknown, poll_until: None, tools: None, daemon_pid: None }),
            start_gate: Mutex::new(None),
            starter_running: Arc::new(AtomicBool::new(false)),
            resolved: AtomicBool::new(false),
        })
    }

    fn written(r: &Relay<Vec<u8>>) -> String {
        String::from_utf8(r.out.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn the_handshake_needs_no_server_and_echoes_tricky_ids() {
        let r = test_relay();
        handle_line(&r, r#"{"params":{"id":5,"protocolVersion":"2025-06-18"},"method":"initialize","id":"a,b}"}"#);
        let out = written(&r);
        assert!(out.starts_with(r#"{"jsonrpc":"2.0","id":"a,b}","result":{"protocolVersion":"2025-06-18""#), "{out}");
        assert!(out.contains(r#""listChanged":true"#));
        let r = test_relay();
        handle_line(&r, r#"{"id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#);
        assert!(written(&r).contains(&format!(r#""protocolVersion":"{LATEST_PROTOCOL}""#)));
    }

    #[test]
    fn notifications_get_no_answer_and_unknowns_get_an_error() {
        let r = test_relay();
        handle_line(&r, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(written(&r), "");
        handle_line(&r, r#"{"id":2,"method":"resources/list"}"#);
        assert!(written(&r).contains("-32601"));
        let r = test_relay();
        handle_line(&r, "not json");
        assert!(written(&r).contains("-32700"));
    }

    #[test]
    fn mode_changes_notify_only_on_a_real_change() {
        let r = test_relay();
        r.set_mode(Mode::Serving);
        assert_eq!(written(&r), "", "the first answer is already accurate");
        r.set_mode(Mode::Serving);
        assert_eq!(written(&r), "");
        r.set_mode(Mode::Degraded);
        assert_eq!(written(&r).matches("list_changed").count(), 1);
        r.set_mode(Mode::Serving);
        assert_eq!(written(&r).matches("list_changed").count(), 2);
    }

    #[test]
    fn a_restart_with_a_new_tool_list_notifies_and_the_same_list_does_not() {
        let r = test_relay();
        r.serve_tools("[1]");
        r.serve_tools("[1]");
        assert_eq!(written(&r), "");
        r.serve_tools("[1,2]");
        assert_eq!(written(&r).matches("list_changed").count(), 1);
    }
}
