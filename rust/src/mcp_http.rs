//! The opt-in `/mcp` endpoint: one JSON-RPC exchange per POST, no sessions, JSON answers only.
//! Mirrors `src/daemon/mcp-http.ts` and the rules of the SDK transport under it.
use crate::config::VERSION;
use crate::mcp::{Answer, Failed};
use serde_json::{json, Map, Value};
use std::future::Future;

const PROTOCOLS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const RELATED_TASK: &str = "io.modelcontextprotocol/related-task";

pub struct Reply {
    pub status: &'static str,
    pub kind: &'static str,
    pub body: String,
}

/// `isMcpHttpEnabled`.
pub fn enabled() -> bool {
    std::env::var("SCRYBE_DAEMON_MCP_HTTP").is_ok_and(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true"))
}

fn json_reply(status: &'static str, body: &Value) -> Reply {
    Reply { status, kind: "application/json", body: body.to_string() }
}

fn refusal(status: &'static str, code: i64, message: &str) -> Reply {
    json_reply(status, &json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }))
}

pub fn method_not_allowed() -> Reply {
    refusal("405 Method Not Allowed", -32000, "Method not allowed.")
}

/// The id as a response carries it. `None` unless it is a string or an integer JavaScript can hold.
fn id_of(v: &Value) -> Option<Value> {
    match v {
        Value::String(_) => Some(v.clone()),
        Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0).map(|f| json!(f as i64)),
        _ => None,
    }
}

fn meta_ok(holder: &Map<String, Value>) -> bool {
    let Some(meta) = holder.get("_meta") else { return true };
    let Some(meta) = meta.as_object() else { return false };
    meta.get("progressToken").is_none_or(|t| id_of(t).is_some()) && meta.get(RELATED_TASK).is_none_or(|t| t.is_object() && t["taskId"].is_string())
}

#[derive(Debug, PartialEq)]
enum Message {
    Request,
    /// A notification, or an answer to something never asked.
    Silent,
}

fn message_of(v: &Value) -> Option<Message> {
    let o = v.as_object()?;
    if o.get("jsonrpc")? != "2.0" {
        return None;
    }
    let only = |allowed: &[&str]| o.keys().all(|k| k == "jsonrpc" || allowed.contains(&k.as_str()));
    let id_valid = o.get("id").is_some_and(|id| id_of(id).is_some());
    let called = o.get("method").is_some_and(Value::is_string) && o.get("params").is_none_or(|p| p.as_object().is_some_and(meta_ok));
    if called && id_valid && only(&["id", "method", "params"]) {
        return Some(Message::Request);
    }
    let notification = called && only(&["method", "params"]);
    let result = id_valid && only(&["id", "result"]) && o.get("result").and_then(Value::as_object).is_some_and(meta_ok);
    let error = (id_valid || !o.contains_key("id")) && only(&["id", "error"]) && o.get("error").is_some_and(|e| id_of(&e["code"]).is_some_and(|c| c.is_number()) && e["message"].is_string());
    (notification || result || error).then_some(Message::Silent)
}

/// One thing wrong with a request's params, in the validator's own words.
fn issue(expected: &str, path: &[&str], got: Option<&Value>) -> Value {
    let got = got.map_or("undefined", crate::mcp::json_type_of);
    json!({ "expected": expected, "code": "invalid_type", "path": path, "message": format!("Invalid input: expected {expected}, received {got}") })
}

/// What is wrong with a known method's params: each field's path, the type it must have, and whether it must be there.
fn params_issues(method: &str, params: Option<&Value>) -> Vec<Value> {
    let fields: &[(&[&str], &str, bool)] = match method {
        "initialize" => &[(&["protocolVersion"], "string", true), (&["capabilities"], "object", true), (&["clientInfo"], "object", true), (&["clientInfo", "name"], "string", true), (&["clientInfo", "version"], "string", true)],
        "tools/call" => &[(&["task"], "object", false), (&["task", "ttl"], "number", false), (&["name"], "string", true), (&["arguments"], "record", false)],
        "tools/list" => &[(&["cursor"], "string", false)],
        _ => &[],
    };
    let Some(params) = params else {
        return if matches!(method, "initialize" | "tools/call") { vec![issue("object", &["params"], None)] } else { vec![] };
    };
    let mut out = vec![];
    for (path, expected, required) in fields {
        let (last, parents) = path.split_last().unwrap_or((&"", &[]));
        // A field of something missing or of the wrong type is not a problem of its own.
        let Some(holder) = parents.iter().try_fold(params, |v, k| v.get(k)).and_then(Value::as_object) else { continue };
        let got = holder.get(*last);
        let fits = got.map_or(!required, |v| crate::mcp::json_type_of(v) == if *expected == "record" { "object" } else { expected });
        if !fits {
            let full: Vec<&str> = std::iter::once("params").chain(path.iter().copied()).collect();
            out.push(issue(expected, &full, got));
        }
    }
    out
}

fn is_initialize(v: &Value) -> bool {
    v["method"] == "initialize" && message_of(v).is_some() && params_issues("initialize", v.get("params")).is_empty()
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// `toCallToolResult`.
fn tool_result(outcome: Result<Answer, Failed>) -> Value {
    match outcome {
        Ok(answer) => json!({ "content": [{ "type": "text", "text": answer.pretty() }] }),
        Err(f) => json!({ "content": [{ "type": "text", "text": pretty(&json!({ "error": f.message })) }], "isError": true }),
    }
}

async fn answer_request<F, Fut>(request: &Value, id: &Value, tools: &Value, call: &F) -> Value
where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = Result<Answer, Failed>>,
{
    let error = |code: i64, message: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } });
    let method = request["method"].as_str().unwrap_or("");
    let params = request.get("params");
    if !matches!(method, "initialize" | "ping" | "tools/list" | "tools/call") {
        return error(-32601, "Method not found");
    }
    if params.and_then(|p| p.get("task")).is_some_and(|t| t.is_object() && t.get("ttl").is_none_or(Value::is_number)) {
        return error(-32603, &format!("Server does not support task creation (required for {method})"));
    }
    let issues = params_issues(method, params);
    if !issues.is_empty() {
        return error(-32603, &pretty(&json!(issues)));
    }
    let params = params.cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
            json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": "scrybe", "version": VERSION } })
        }
        "tools/list" => json!({ "tools": tools }),
        "tools/call" => {
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            tool_result(call(params["name"].as_str().unwrap_or("").to_string(), args).await)
        }
        _ => json!({}),
    };
    json!({ "result": result, "jsonrpc": "2.0", "id": id })
}

/// Answers one POST. `header` looks a request header up, `call` runs a tool.
pub async fn answer<'h, F, Fut>(header: impl Fn(&str) -> Option<&'h str>, body: &[u8], tools: &Value, call: F) -> Reply
where
    F: Fn(String, Value) -> Fut,
    Fut: Future<Output = Result<Answer, Failed>>,
{
    let accept = header("accept").unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return refusal("406 Not Acceptable", -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    }
    let media = header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim();
    if !media.eq_ignore_ascii_case("application/json") {
        return refusal("415 Unsupported Media Type", -32000, "Unsupported Media Type: Content-Type must be application/json");
    }
    let text = String::from_utf8_lossy(body);
    let Ok(parsed) = crate::jsstr::parse_json(text.strip_prefix('\u{FEFF}').unwrap_or(&text)) else {
        return refusal("400 Bad Request", -32700, "Parse error: Invalid JSON");
    };
    let messages = match parsed {
        Value::Array(list) => list,
        one => vec![one],
    };
    let Some(kinds) = messages.iter().map(message_of).collect::<Option<Vec<_>>>() else {
        return refusal("400 Bad Request", -32700, "Parse error: Invalid JSON-RPC message");
    };
    if messages.iter().any(is_initialize) {
        if messages.len() > 1 {
            return refusal("400 Bad Request", -32600, "Invalid Request: Only one initialization request is allowed");
        }
    } else if let Some(asked) = header("mcp-protocol-version").filter(|v| !PROTOCOLS.contains(v)) {
        return refusal("400 Bad Request", -32000, &format!("Bad Request: Unsupported protocol version: {asked} (supported versions: {})", PROTOCOLS.join(", ")));
    }
    let mut answers: Vec<(Value, Value)> = vec![];
    for (message, _) in messages.iter().zip(&kinds).filter(|(_, k)| **k == Message::Request) {
        let Some(id) = id_of(&message["id"]) else { continue };
        let reply = answer_request(message, &id, tools, &call).await;
        // Two requests under one id share one answer.
        if answers.iter().all(|(seen, _)| *seen != id) {
            answers.push((id, reply));
        }
    }
    match answers.len() {
        0 => Reply { status: "202 Accepted", kind: "text/plain; charset=UTF-8", body: String::new() },
        1 => json_reply("200 OK", &answers[0].1),
        _ => json_reply("200 OK", &Value::Array(answers.into_iter().map(|(_, reply)| reply).collect())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn post(accept: &str, body: &str) -> (String, Value) {
        let header = |name: &str| match name {
            "accept" => Some(accept),
            "content-type" => Some("Application/JSON; charset=utf-8"),
            _ => None,
        };
        let call = |name: String, args: Value| async move {
            if name == "fails" { Err(Failed { code: -32603, message: "internal error".into() }) } else { Ok(Answer::Json(json!({ "name": name, "args": args }))) }
        };
        let r = answer(header, body.as_bytes(), &json!(["the tools"]), call).await;
        (r.status[..3].to_string(), serde_json::from_str(&r.body).unwrap_or(Value::Null))
    }

    const BOTH: &str = "application/json, text/event-stream";

    #[tokio::test]
    async fn both_answer_kinds_must_be_accepted() {
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(post(BOTH, ping).await, ("200".into(), json!({ "result": {}, "jsonrpc": "2.0", "id": 1 })));
        assert_eq!(post("*/*", ping).await.0, "406");
    }

    #[tokio::test]
    async fn only_whole_json_rpc_messages_are_taken() {
        for bad in [r#"{"id":1,"method":"ping"}"#, r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#, r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#, r#"{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}"#, r#"{"jsonrpc":"2.0","id":1,"method":"ping","x":1}"#, r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}"#, r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":5}}"#, "5", "null", "[5]"] {
            let (status, body) = post(BOTH, bad).await;
            assert_eq!((status.as_str(), &body["error"]["message"]), ("400", &json!("Parse error: Invalid JSON-RPC message")), "{bad}");
        }
        for quiet in [r#"{"jsonrpc":"2.0","method":"x"}"#, r#"{"jsonrpc":"2.0","id":1,"result":{}}"#, r#"{"jsonrpc":"2.0","error":{"code":1,"message":"m"}}"#, "[]"] {
            assert_eq!(post(BOTH, quiet).await.0, "202", "{quiet}");
        }
        assert_eq!(post(BOTH, r#"{"jsonrpc":"2.0","id":1.0,"method":"ping"}"#).await.1["id"], 1);
        assert_eq!(post(BOTH, "{x").await.1["error"]["message"], "Parse error: Invalid JSON");
    }

    #[tokio::test]
    async fn a_call_is_wrapped_and_a_failure_marked() {
        let call = |params: &str| format!(r#"{{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{params}}}"#);
        let (_, ok) = post(BOTH, &call(r#"{"name":"t","arguments":{"q":1}}"#)).await;
        assert_eq!(ok["result"], json!({ "content": [{ "type": "text", "text": "{\n  \"name\": \"t\",\n  \"args\": {\n    \"q\": 1\n  }\n}" }] }));
        let (_, bad) = post(BOTH, &call(r#"{"name":"fails"}"#)).await;
        assert_eq!(bad["result"], json!({ "content": [{ "type": "text", "text": "{\n  \"error\": \"internal error\"\n}" }], "isError": true }));
        let (_, none) = post(BOTH, &call("{}")).await;
        assert_eq!(none["error"]["code"], -32603);
        assert_eq!(none["error"]["message"], "[\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"params\",\n      \"name\"\n    ],\n    \"message\": \"Invalid input: expected string, received undefined\"\n  }\n]");
    }

    #[tokio::test]
    async fn a_batch_answers_its_requests_and_may_not_hold_an_initialize() {
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;
        let ping = r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#;
        assert_eq!(post(BOTH, init).await.1["result"]["protocolVersion"], PROTOCOLS[0]);
        assert_eq!(post(BOTH, &format!("[{init},{ping}]")).await.1["error"]["code"], -32600);
        assert_eq!(post(BOTH, &format!("[{ping},{ping}]")).await.1, json!({ "result": {}, "jsonrpc": "2.0", "id": 2 }));
        let list = r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#;
        assert_eq!(post(BOTH, &format!("[{ping},{list}]")).await.1[1]["result"]["tools"], json!(["the tools"]));
    }
}
