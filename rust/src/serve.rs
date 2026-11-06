//! The one shared server: spec MCP over HTTP at /mcp plus /health, on loopback.
//! A small HTTP reader on purpose: read tools only, one request per connection, no new compile cost.
use crate::config::{data_dir, VERSION};
use crate::index::refuse_live_data_dir;
use crate::mcp;
use crate::store::Store;
use anyhow::Result;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const MAX_BODY: usize = 8 << 20;

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Same rule as host-gate.ts: loopback Host only, and any Origin header means a browser.
fn allowed(head: &str) -> bool {
    if header(head, "origin").is_some() {
        return false;
    }
    let Some(host) = header(head, "host") else { return false };
    let name = host.rsplit_once(':').map_or(host, |(n, _)| n);
    name == "localhost" || name == "127.0.0.1"
}

async fn respond(s: &mut TcpStream, status: &str, kind: &str, body: &str) -> Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    s.write_all(head.as_bytes()).await?;
    s.write_all(body.as_bytes()).await?;
    Ok(())
}

async fn handle(mut s: TcpStream, store: Arc<Store>) -> Result<()> {
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
        return respond(&mut s, "403 Forbidden", "text/plain", "forbidden").await;
    }
    let request_line = head.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    match (method, path) {
        ("GET", "/health") => respond(&mut s, "200 OK", "application/json", &json!({ "status": "ok", "ready": true, "version": VERSION }).to_string()).await,
        ("GET", "/mcp/manifest") => respond(&mut s, "200 OK", "application/json", &mcp::manifest().to_string()).await,
        // Nothing here shuts down when clients leave, so there's nothing to track yet.
        ("POST", "/clients/heartbeat" | "/clients/unregister") => respond(&mut s, "200 OK", "application/json", "{}").await,
        ("POST", "/mcp" | "/mcp/rpc") => {
            let len: usize = header(&head, "content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
            if len > MAX_BODY {
                return respond(&mut s, "413 Payload Too Large", "text/plain", "too large").await;
            }
            let mut body = buf[head_end + 4..].to_vec();
            while body.len() < len {
                let mut chunk = vec![0u8; (len - body.len()).min(64 << 10)];
                let n = s.read(&mut chunk).await?;
                if n == 0 {
                    return Ok(());
                }
                body.extend_from_slice(&chunk[..n]);
            }
            let Ok(req) = serde_json::from_slice::<Value>(&body) else {
                let err = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } });
                return respond(&mut s, "400 Bad Request", "application/json", &err.to_string()).await;
            };
            if path == "/mcp/rpc" {
                return respond(&mut s, "200 OK", "application/json", &mcp::rpc(&store, &req).await).await;
            }
            match mcp::handle(&store, &req).await {
                Some(answer) => respond(&mut s, "200 OK", "application/json", &answer.to_string()).await,
                None => respond(&mut s, "202 Accepted", "text/plain", "").await,
            }
        }
        (_, "/mcp") => respond(&mut s, "405 Method Not Allowed", "text/plain", "method not allowed").await,
        _ => respond(&mut s, "404 Not Found", "text/plain", "not found").await,
    }
}

pub async fn serve(store: Store) -> Result<()> {
    // daemon.pid would point real clients at this unfinished server.
    refuse_live_data_dir()?;
    // Same lock file as the TypeScript daemon: the operating system drops it if this process dies.
    let owner = rusqlite::Connection::open(data_dir().join("daemon-owner.lock.db"))?;
    owner.busy_timeout(std::time::Duration::ZERO)?;
    if owner.execute_batch("BEGIN IMMEDIATE").is_err() {
        eprintln!("another server owns this data dir");
        return Ok(());
    }
    let port: u16 = std::env::var("SCRYBE_DAEMON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let bound = listener.local_addr()?.port();
    let pid = json!({ "pid": std::process::id(), "port": bound, "version": VERSION, "dataDir": data_dir().to_string_lossy() });
    std::fs::write(data_dir().join("daemon.pid"), pid.to_string())?;
    eprintln!("scrybe-rs serving on 127.0.0.1:{bound}");
    let store = Arc::new(store);
    let _owner = owner;
    loop {
        let (socket, _) = listener.accept().await?;
        let store = store.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(socket, store).await {
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
        assert!(allowed("POST /mcp HTTP/1.1\r\nHost: localhost:5000"));
        assert!(!allowed("POST /mcp HTTP/1.1\r\nHost: evil.example:5000"));
        assert!(!allowed("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: null"));
        assert!(!allowed("POST /mcp HTTP/1.1"));
    }
}
