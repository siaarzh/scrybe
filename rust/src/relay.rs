//! scrybe-relay: the process an MCP client starts. It carries stdio lines to the one shared server
//! and answers back, holding nothing else. Standard library only, so it stays a few MB.
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("SCRYBE_DATA_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default());
    if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home.join("AppData/Local")).join("scrybe").join("scrybe")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/scrybe")
    } else {
        std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".local/share")).join("scrybe")
    }
}

/// Reads `"port":N` from daemon.pid without a JSON parser.
fn port_from_pidfile() -> Option<u16> {
    let text = std::fs::read_to_string(data_dir().join("daemon.pid")).ok()?;
    let rest = text.split("\"port\"").nth(1)?;
    let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn port() -> Option<u16> {
    std::env::var("SCRYBE_DAEMON_PORT").ok().and_then(|p| p.parse().ok()).or_else(port_from_pidfile)
}

/// Starts the server named by SCRYBE_RELAY_SERVER, if any, and waits for its pidfile.
fn start_server() -> Option<u16> {
    let path = std::env::var("SCRYBE_RELAY_SERVER").ok()?;
    std::process::Command::new(path).arg("serve").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().ok()?;
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(p) = port() {
            if TcpStream::connect(("127.0.0.1", p)).is_ok() {
                return Some(p);
            }
        }
    }
    None
}

fn connect() -> Option<(TcpStream, u16)> {
    if let Some(p) = port() {
        if let Ok(s) = TcpStream::connect(("127.0.0.1", p)) {
            return Some((s, p));
        }
    }
    let p = start_server()?;
    TcpStream::connect(("127.0.0.1", p)).ok().map(|s| (s, p))
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

/// POSTs one JSON-RPC line. Returns the JSON messages to print, one per line.
fn forward(line: &str) -> Result<Vec<String>, String> {
    let (mut stream, port) = connect().ok_or("server not running")?;
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        line.len()
    );
    stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(line.as_bytes())).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed response")?;
    let headers = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let mut body = raw[split + 4..].to_vec();
    if headers.contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if headers.contains("text/event-stream") {
        return Ok(text.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect());
    }
    let status_ok = headers.starts_with("http/1.1 2");
    if !status_ok {
        return Err(format!("server answered {}", headers.lines().next().unwrap_or("")));
    }
    Ok(if text.trim().is_empty() { vec![] } else { vec![text.trim().replace('\n', " ")] })
}

/// The request id as raw JSON, so an error can answer the right call.
fn request_id(line: &str) -> Option<String> {
    let rest = line.split("\"id\"").nth(1)?;
    let value = rest.trim_start().strip_prefix(':')?.trim_start();
    let end = value.find([',', '}'])?;
    Some(value[..end].trim().to_string())
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let lines = match forward(&line) {
            Ok(lines) => lines,
            Err(e) => match request_id(&line) {
                Some(id) => vec![format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-32000,\"message\":\"scrybe relay: {}\"}}}}", e.replace('"', "'"))],
                None => vec![],
            },
        };
        for l in lines {
            if writeln!(out, "{l}").and_then(|_| out.flush()).is_err() {
                return;
            }
        }
    }
}
