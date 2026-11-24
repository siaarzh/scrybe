//! The process an MCP client starts. It answers the handshake itself, carries tool calls
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
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const COLD_START_DEFAULT_MS: u64 = 15_000;
const COLD_START_CEILING_MS: u64 = 20_000;
const CALL_START_BUDGET: Duration = Duration::from_secs(15);
const INIT_START_BUDGET: Duration = Duration::from_secs(30);
const POLL_EVERY_MS: u64 = 2_000;
const POLL_FOR_MS: u64 = 300_000;
/// The first version whose index format an older server can't read.
const UPGRADE_BOUNDARY: [u64; 3] = [0, 34, 0];
const OUT_OF_DATE: &str = "Run: scrybe daemon restart --force   (then reconnect)\n\nscrybe v0.34.0 upgraded lancedb. The running daemon is still on the old version\nand cannot use the new on-disk format helpers. Stop + start refreshes the daemon\nwith the new lancedb binary. Existing data is preserved (lancedb 0.27 reads\n0.14-written tables transparently).\n\nIf the stop command fails with EPERM on Windows, close all Claude Code / IDE\nsessions first — they hold the lancedb native binding open.";
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

/// A child inherits every inheritable handle on Windows, so the server would hold the client's pipes open after the relay exits.
#[cfg(windows)]
fn stop_inheriting_std_handles() {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(id: u32) -> *mut c_void;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 1;
    let invalid = usize::MAX as *mut c_void;
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE and STD_ERROR_HANDLE are -10, -11 and -12.
    for id in [-10i32, -11, -12] {
        // SAFETY: the handles are this process's own standard ones.
        unsafe {
            let handle = GetStdHandle(id as u32);
            if !handle.is_null() && handle != invalid {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

fn read_pidfile() -> Option<String> {
    let path = std::env::var_os("SCRYBE_DAEMON_PIDFILE").map_or_else(|| data_dir().join("daemon.pid"), PathBuf::from);
    std::fs::read_to_string(path).ok()
}

fn pidfile_port() -> Option<u16> {
    json::get(&read_pidfile()?, "port")?.parse().ok()
}

// ─── Versions ────────────────────────────────────────────────────────────────

/// The `major.minor.patch` a version starts with.
fn parse_version(v: &str) -> Option<[u64; 3]> {
    let mut parts = v.splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let rest = parts.next()?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    Some([major, minor, rest[..digits].parse().ok()?])
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Skew {
    /// The same version, or one that can't be told.
    None,
    /// Another minor or patch version: served, with a warning.
    Small,
    /// Too old to read today's index.
    PreUpgrade,
    Major,
}

/// `analyzeVersionSkew`, and the upgrade boundary checked before it.
fn skew(daemon: &str, own: &str) -> Skew {
    let (Some(d), Some(o)) = (parse_version(daemon), parse_version(own)) else { return Skew::None };
    if o >= UPGRADE_BOUNDARY && d < UPGRADE_BOUNDARY {
        Skew::PreUpgrade
    } else if d[0] != o[0] {
        Skew::Major
    } else if d != o {
        Skew::Small
    } else {
        Skew::None
    }
}

fn major_skew_message(daemon: &str, own: &str) -> String {
    format!("daemon version {daemon} is major-incompatible with shim {own}. Restart to update: scrybe daemon restart")
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

#[derive(PartialEq, Clone, Copy, Debug)]
enum Mode {
    Unknown,
    Serving,
    Degraded,
    /// The server is there, and older than today's index format.
    PreUpgrade,
    /// The server is there, under another major version.
    MajorSkew,
}

impl Mode {
    /// The server's own tools aren't offered, so its return is watched for.
    fn not_serving(self) -> bool {
        matches!(self, Mode::Degraded | Mode::PreUpgrade | Mode::MajorSkew)
    }
}

struct State {
    mode: Mode,
    poll_until: Option<Instant>,
    tools: Option<String>,
    daemon_pid: Option<String>,
    /// The pid and port of the server whose version was last looked at.
    checked: Option<(Option<String>, u16)>,
    daemon_version: String,
    warned_version: Option<String>,
}

impl State {
    fn new() -> Self {
        State { mode: Mode::Unknown, poll_until: None, tools: None, daemon_pid: None, checked: None, daemon_version: String::new(), warned_version: None }
    }
}

struct Manifest {
    version: String,
    tools: String,
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
    version: &'static str,
    poll_for: Duration,
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

/// A tool's answer as `tools/call` content. A search may come wrapped with a note about its index, which follows as its own block.
fn content_of(result: &str) -> String {
    let results = json::get(result, "results").filter(|r| r.starts_with('[') && json::get(result, "scrybe_envelope") == Some("1"));
    let Some(results) = results else { return text_result(result, false) };
    let answer = text_result(results, false);
    match json::get(result, "note").filter(|n| n.starts_with('"') && *n != "\"\"") {
        Some(note) => format!(r#"{},{{"type":"text","text":{note}}}]}}"#, &answer[..answer.len() - 2]),
        None => answer,
    }
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
            if new.not_serving() && !prev.not_serving() {
                st.poll_until = Some(Instant::now() + self.poll_for);
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
            stop_inheriting_std_handles();
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
                    // No time to wait for a start is no reason to hurry a busy server.
                    let wait = if budget.is_zero() { Duration::from_secs(2) } else { left.clamp(Duration::from_millis(250), Duration::from_secs(2)) };
                    match health(port, wait) {
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

    fn manifest(&self, port: u16) -> Option<Manifest> {
        let r = http(port, "GET", "/mcp/manifest", "", "", Duration::from_secs(5)).ok()?;
        if !(200..300).contains(&r.status) {
            return None;
        }
        let version = json::get(&r.body, "daemon_version").and_then(json::bare).unwrap_or("").to_string();
        json::get(&r.body, "tools").map(|tools| Manifest { version, tools: tools.to_string() })
    }

    /// Takes in a server's manifest: which mode its version puts this session in, and its tools if they are served.
    fn learn(&self, m: &Manifest) {
        let skew = skew(&m.version, self.version);
        let warn = {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            st.daemon_version = m.version.clone();
            let warn = skew == Skew::Small && st.warned_version.as_deref() != Some(m.version.as_str());
            if warn {
                st.warned_version = Some(m.version.clone());
            }
            warn
        };
        if warn {
            let _ = writeln!(std::io::stderr(), "[scrybe] daemon version {} differs from shim {} (minor/patch) — restart daemon to refresh tool surface", m.version, self.version);
        }
        match skew {
            Skew::PreUpgrade => self.set_mode(Mode::PreUpgrade),
            Skew::Major => self.set_mode(Mode::MajorSkew),
            Skew::None | Skew::Small => self.serve_tools(&m.tools),
        }
    }

    /// Looks at the version of the server on `port`, once per server. One that gives no manifest is taken as it is.
    fn check_version(&self, port: u16) {
        let key = (read_pidfile().and_then(|t| json::get(&t, "pid").map(str::to_string)), port);
        let known = {
            let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            st.checked.as_ref() == Some(&key) && !matches!(st.mode, Mode::Unknown | Mode::Degraded)
        };
        if known {
            return;
        }
        if let Some(m) = self.manifest(port) {
            self.state.lock().unwrap_or_else(|e| e.into_inner()).checked = Some(key);
            self.learn(&m);
        }
    }

    /// The answer to a call the server's version rules out.
    fn refusal(&self, name: &str) -> Option<String> {
        let (mode, version) = {
            let st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (st.mode, st.daemon_version.clone())
        };
        let why = match mode {
            Mode::PreUpgrade if matches!(name, "status" | "doctor" | "init") => return Some(self.offline_answer(name, "")),
            Mode::PreUpgrade => OUT_OF_DATE.to_string(),
            Mode::MajorSkew => major_skew_message(&version, self.version),
            _ => return None,
        };
        Some(text_result(&format!(r#"{{"error":{}}}"#, json::quote(&why)), false))
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
        let config_present = data_dir().join("config.json").exists();
        let Some(m) = port.and_then(|p| self.manifest(p)) else {
            self.set_mode(Mode::Degraded);
            return offline_tools(config_present);
        };
        self.learn(&m);
        match skew(&m.version, self.version) {
            Skew::PreUpgrade => offline_tools(config_present),
            Skew::Major => format!(r#"{{"tools":[{{"name":"scrybe_daemon_unavailable","description":{},"inputSchema":{{"type":"object","properties":{{}},"required":[]}}}}]}}"#, json::quote(&major_skew_message(&m.version, self.version))),
            Skew::None | Skew::Small => format!(r#"{{"tools":{}}}"#, m.tools),
        }
    }

    fn rpc_once(&self, port: u16, name: &str, args: &str) -> Result<String, RpcFail> {
        let header = format!("X-Scrybe-Client-Id: {}\r\nX-Scrybe-Envelope: 1\r\n", self.client_id);
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
            self.check_version(port);
            if let Some(refusal) = self.refusal(json::bare(name_raw).unwrap_or("")) {
                return refusal;
            }
            match self.rpc_once(port, name_raw, args) {
                Ok(body) => {
                    self.set_mode_after_call();
                    return match result_from_rpc(&body) {
                        Ok(result) => content_of(&result),
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
        if mode.not_serving() && polling {
            if let Some(m) = pidfile_port().filter(|p| health(*p, Duration::from_secs(2)) == Health::Up).and_then(|p| self.manifest(p)) {
                self.learn(&m);
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
            if let Some(m) = pidfile_port().and_then(|p| self.manifest(p)) {
                self.learn(&m);
            }
        }
    }
}

fn watch_loop<W: Write + Send>(relay: &Relay<W>, heartbeat_every: Duration, poll_every: Duration) {
    relay.heartbeat();
    relay.restart_check();
    let mut last_beat = Instant::now();
    loop {
        std::thread::sleep(poll_every.min(heartbeat_every));
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

/// The words after `--start`, or what starts a server from the registry.
pub fn start_cmd_from_args(args: &[String]) -> Vec<String> {
    match args.iter().position(|a| a == "--start") {
        Some(i) if i + 1 < args.len() => args[i + 1..].to_vec(),
        _ => default_start_cmd(),
    }
}

/// JavaScript's `parseInt`: leading digits, whatever follows. `None` for NaN and for a number below zero.
fn parse_int(raw: &str) -> Option<u64> {
    let t = raw.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    let (sign, rest) = match t.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    digits.parse::<f64>().ok().map(|n| n * sign).filter(|n| *n >= 0.0).map(|n| n as u64)
}

/// A wait named by the environment, when that is above zero.
fn wait_from(raw: Option<String>, default_ms: u64) -> Duration {
    Duration::from_millis(raw.and_then(|v| parse_int(&v)).filter(|ms| *ms > 0).unwrap_or(default_ms))
}

fn cold_budget_from(raw: Option<String>) -> Duration {
    let ms = raw.and_then(|v| parse_int(&v)).unwrap_or(COLD_START_DEFAULT_MS);
    Duration::from_millis(ms.min(COLD_START_CEILING_MS))
}

/// Serves the client on standard input until it goes. `start_cmd` is run when a server is needed.
pub fn run(start_cmd: Vec<String>) -> ! {
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let relay = Arc::new(Relay {
        out: Mutex::new(std::io::stdout()),
        client_id: format!("relay:{}:{started}", std::process::id()),
        start_cmd,
        auto_start: std::env::var("SCRYBE_NO_AUTO_DAEMON").as_deref() != Ok("1"),
        cold_budget: cold_budget_from(std::env::var("SCRYBE_MCP_COLD_START_WAIT_MS").ok()),
        version: VERSION,
        poll_for: wait_from(std::env::var("SCRYBE_MCP_LISTCHANGED_POLL_CEILING_MS").ok(), POLL_FOR_MS),
        state: Mutex::new(State::new()),
        start_gate: Mutex::new(None),
        starter_running: Arc::new(AtomicBool::new(false)),
        resolved: AtomicBool::new(false),
    });
    let beat = wait_from(std::env::var("SCRYBE_DAEMON_HEARTBEAT_MS").ok(), 30_000);
    let poll = wait_from(std::env::var("SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS").ok(), POLL_EVERY_MS);
    let watcher = relay.clone();
    std::thread::spawn(move || watch_loop(&watcher, beat, poll));

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
    fn a_note_about_the_index_follows_the_results_as_its_own_block() {
        assert_eq!(content_of(r#"{"scrybe_envelope":1,"results":[1],"note":"still \"building\""}"#), r#"{"content":[{"type":"text","text":"[\n  1\n]"},{"type":"text","text":"still \"building\""}]}"#);
        for plain in [r#"{"scrybe_envelope":1,"results":[1]}"#, r#"{"scrybe_envelope":1,"results":[1],"note":""}"#] {
            assert_eq!(content_of(plain), text_result("[1]", false), "{plain}");
        }
        for other in ["[1]", "3", r#"{"results":[1],"note":"x"}"#, r#"{"scrybe_envelope":2,"results":[1]}"#, r#"{"scrybe_envelope":1,"results":{}}"#] {
            assert_eq!(content_of(other), text_result(other, false), "{other}");
        }
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
        for odd in ["junk", "-5", ""] {
            assert_eq!(cold_budget_from(Some(odd.into())), Duration::from_millis(COLD_START_DEFAULT_MS));
        }
        assert_eq!(cold_budget_from(Some(" 1500ms".into())), Duration::from_millis(1500));
        for odd in [None, Some("0"), Some("-1"), Some("x")] {
            assert_eq!(wait_from(odd.map(String::from), POLL_EVERY_MS), Duration::from_secs(2));
        }
        assert_eq!(wait_from(Some("75".into()), POLL_FOR_MS), Duration::from_millis(75));
    }

    #[test]
    fn versions_are_compared_like_the_old_client() {
        assert_eq!(parse_version("0.54.0-rs.1"), Some([0, 54, 0]));
        for odd in ["", "0.54", "v1.2.3", "1.2.x", "a.b.c"] {
            assert_eq!(parse_version(odd), None, "{odd}");
        }
        for (daemon, own, want) in [("0.54.0-rs.1", "0.54.0", Skew::None), ("0.54.0", "0.53.2", Skew::Small), ("0.53.9", "0.54.0", Skew::Small), ("0.33.9", "0.54.0", Skew::PreUpgrade), ("0.33.9", "0.33.0", Skew::Small), ("0.34.0", "0.54.0", Skew::Small), ("1.0.0", "0.54.0", Skew::Major), ("0.54.0", "1.0.0", Skew::Major), ("0.33.0", "1.0.0", Skew::PreUpgrade), ("", "0.54.0", Skew::None)] {
            assert_eq!(skew(daemon, own), want, "{daemon} {own}");
        }
    }

    fn manifest(version: &str) -> Manifest {
        Manifest { version: version.into(), tools: "[1]".into() }
    }

    #[test]
    fn a_server_under_another_major_version_is_refused_until_it_is_replaced() {
        let r = test_relay();
        r.learn(&manifest("0.54.0-rs.1"));
        assert_eq!((r.refusal("search_code"), written(&r).as_str()), (None, ""));
        r.learn(&manifest("1.0.0"));
        assert_eq!(written(&r).matches("list_changed").count(), 1);
        let told = r.refusal("search_code").unwrap();
        assert!(told.contains("daemon version 1.0.0 is major-incompatible with shim 0.54.0. Restart to update: scrybe daemon restart") && !told.contains("isError"), "{told}");
        assert!(r.state.lock().unwrap().poll_until.is_some());
        r.learn(&manifest("0.53.0"));
        assert_eq!((r.refusal("search_code"), written(&r).matches("list_changed").count()), (None, 2));
    }

    #[test]
    fn a_server_from_before_the_index_upgrade_is_refused_but_the_offline_tools_answer() {
        let r = test_relay();
        r.learn(&manifest("0.33.2"));
        assert!(r.refusal("search_code").unwrap().contains("Run: scrybe daemon restart --force"));
        assert!(r.refusal("status").unwrap().contains("daemon_running"));
        assert_eq!(r.state.lock().unwrap().mode, Mode::PreUpgrade);
        r.learn(&manifest("0.54.0"));
        assert_eq!(r.refusal("search_code"), None);
    }

    #[test]
    fn a_small_difference_is_warned_about_once_for_each_version() {
        let r = test_relay();
        let warned = |r: &Relay<Vec<u8>>| r.state.lock().unwrap().warned_version.clone();
        r.learn(&manifest("0.54.0"));
        assert_eq!(warned(&r), None);
        r.learn(&manifest("0.55.0"));
        assert_eq!(warned(&r).as_deref(), Some("0.55.0"));
        assert_eq!((r.refusal("gc"), r.state.lock().unwrap().mode), (None, Mode::Serving));
    }

    fn test_relay() -> Arc<Relay<Vec<u8>>> {
        Arc::new(Relay {
            out: Mutex::new(Vec::new()),
            client_id: "t".into(),
            start_cmd: vec![],
            auto_start: false,
            cold_budget: Duration::ZERO,
            version: "0.54.0",
            poll_for: Duration::from_millis(POLL_FOR_MS),
            state: Mutex::new(State::new()),
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
