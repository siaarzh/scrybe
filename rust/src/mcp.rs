//! MCP over stdio: newline-delimited JSON-RPC, the four read tools, same text-wrapped JSON results.
use crate::config::VERSION;
use crate::store::Store;
use crate::tools::{self, LookupInput};
use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const LATEST_PROTOCOL: &str = "2025-06-18";

fn tool_list() -> Value {
    json!([
        {
            "name": "list_projects",
            "description": "List all registered projects and their sources. Use this first to see what's indexed and searchable before calling search_code or search_knowledge.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "search_code",
            "description": "Semantically search code in a project using natural language. Use list_projects first to confirm the project has an indexed code source.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "query": { "type": "string" },
                    "top_k": { "type": "number", "default": 10 },
                    "branch": { "type": "string", "description": "Branch to search (default: current HEAD for code sources)" }
                },
                "required": ["project_id", "query"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "search_knowledge",
            "description": "Semantically search GitLab issues, webpages, or other knowledge sources indexed in a project. Use list_projects first to confirm the project has indexed knowledge sources. Optionally filter by source_id (specific source) or item_types. Known item_types: \"ticket\" = GitLab issue bodies; \"ticket_comment\" = individual issue comments (each with its own author, timestamp, and #note_NNN deep-link). Omit item_types to search both. Use [\"ticket_comment\"] to find architectural decisions made in comments, or [\"ticket\"] to find/deduplicate issue bodies.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "query": { "type": "string" },
                    "top_k": { "type": "number", "default": 10 },
                    "source_id": { "type": "string", "description": "Limit search to a specific source (optional)" },
                    "item_types": { "type": "array", "items": { "type": "string" }, "description": "Filter by item_type. Known values: \"ticket\" (issue bodies), \"ticket_comment\" (individual comments). Omit to return both." }
                },
                "required": ["project_id", "query"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "lookup_symbol",
            "description": "Deterministic exact-symbol lookup in a project's code index. Returns all chunks whose symbol_name matches the supplied name, without paying embedding / rerank cost. Use when you know a symbol name and need its location and source. No 'score' field — results are sorted by language, file path, start line. Empty symbol_name chunks (sliding-window fallback files, non-first sub-chunks of large decls) are always excluded.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "symbol_name": { "type": "string", "description": "Symbol name to look up. In 'suffix' mode (default), 'getName' matches both top-level 'getName' and dotted forms like 'User.getName'. In 'exact' mode, the full stored name must match (e.g. 'User.getName')." },
                    "match": { "type": "string", "enum": ["suffix", "exact"], "description": "Match mode. 'suffix' (default): matches bare name OR any 'Qualifier.name' form. 'exact': full stored symbol_name must equal the supplied value.", "default": "suffix" },
                    "branch": { "type": "string", "description": "Branch to scope results to. Accepts either a short name ('feat/example') or a qualified ref ('origin/feat/example') — the server resolves whichever form is indexed. If omitted, all indexed branches are searched." },
                    "source_id": { "type": "string", "description": "Restrict lookup to a specific source. Omit to search all code sources." },
                    "case_sensitive": { "type": "boolean", "description": "Case-sensitive match (default true). Pass false to match case-insensitively.", "default": true },
                    "limit": { "type": "number", "description": "Max results to return (default 50, max 200).", "default": 50 }
                },
                "required": ["project_id", "symbol_name"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }
    ])
}

fn text_result<T: Serialize>(v: &T) -> Value {
    let text = serde_json::to_string_pretty(v).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"));
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// The manifest shared clients read: same tools as tools/list.
pub fn manifest() -> Value {
    json!({ "daemon_version": VERSION, "tools": tool_list() })
}

/// Suggests a known key for an unknown one: a shared prefix first, then a small edit distance.
fn suggest_key(unknown: &str, known: &[&str]) -> Option<String> {
    if let Some(k) = known.iter().find(|k| **k != unknown && (k.starts_with(unknown) || unknown.starts_with(**k))) {
        return Some(k.to_string());
    }
    let distance = |a: &str, b: &str| {
        let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
        let mut row: Vec<usize> = (0..=b.len()).collect();
        for (i, ca) in a.iter().enumerate() {
            let mut diagonal = row[0];
            row[0] = i + 1;
            for (j, cb) in b.iter().enumerate() {
                let cost = usize::from(ca != cb);
                let next = (row[j + 1] + 1).min(row[j] + 1).min(diagonal + cost);
                diagonal = row[j + 1];
                row[j + 1] = next;
            }
        }
        row[b.len()]
    };
    let mut best: Option<(&str, usize)> = None;
    for k in known {
        let d = distance(unknown, k);
        if best.is_none_or(|(_, b)| d < b) {
            best = Some((k, d));
        }
    }
    best.filter(|(_, d)| *d <= 3).map(|(k, _)| k.to_string())
}

fn json_type_of(v: &Value) -> &'static str {
    match v {
        Value::Array(_) => "array",
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Object(_) => "object",
    }
}

/// `validateParams`: unknown keys first, then missing required, then types and enums.
fn validate_params(tool: &str, schema: &Value, params: &Value) -> Result<(), String> {
    let empty = serde_json::Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    let known: Vec<&str> = properties.keys().map(String::as_str).collect();
    let given = params.as_object().unwrap_or(&empty);
    for key in given.keys() {
        if !properties.contains_key(key) {
            let hint = suggest_key(key, &known).map_or(String::new(), |s| format!(" (did you mean '{s}'?)"));
            return Err(format!("invalid params for {tool}: unknown key '{key}'{hint}"));
        }
    }
    for key in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if given.get(key).is_none_or(Value::is_null) {
            return Err(format!("invalid params for {tool}: missing required '{key}'"));
        }
    }
    for (key, value) in given {
        if value.is_null() {
            continue;
        }
        let prop = &properties[key];
        if let Some(expected) = prop["type"].as_str() {
            let actual = json_type_of(value);
            if actual != expected {
                return Err(format!("invalid params for {tool}: '{key}' must be of type {expected}, got {actual}"));
            }
        }
        if let (Some(allowed), Some(text)) = (prop["enum"].as_array(), value.as_str()) {
            if !allowed.iter().any(|a| a.as_str() == Some(text)) {
                let list: Vec<&str> = allowed.iter().filter_map(Value::as_str).collect();
                return Err(format!("invalid params for {tool}: '{key}' must be one of [{}], got '{text}'", list.join(", ")));
            }
        }
        if let (Some(want), Some(items)) = (prop["items"]["type"].as_str(), value.as_array()) {
            if let Some(bad) = items.iter().map(json_type_of).find(|t| *t != want) {
                return Err(format!("invalid params for {tool}: '{key}' elements must be of type {want}, got {bad}"));
            }
        }
    }
    Ok(())
}

/// Bad content from the caller is safe to echo. Anything else stays masked, like the daemon's RPC route.
/// Only the two search tools mark their errors this way today.
fn caller_facing(tool: &str, message: &str) -> bool {
    matches!(tool, "search_code" | "search_knowledge") && ((message.starts_with("Project '") && message.ends_with("not found")) || message.starts_with("NO_CODE_SOURCES") || message.starts_with("NO_KNOWLEDGE_SOURCES"))
}

/// Answers the shared-client call route. The tool's JSON goes out as written, with no text wrapping.
pub async fn rpc(store: &Store, req: &Value) -> String {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let fail = |code: i64, message: &str| json!({ "id": id, "error": { "code": code, "message": message } }).to_string();
    let name = req.get("method").and_then(Value::as_str).unwrap_or("");
    let args = req.get("params").cloned().unwrap_or_else(|| json!({}));
    let tools = tool_list();
    let Some(tool) = tools.as_array().and_then(|t| t.iter().find(|x| x["name"] == name)) else {
        return fail(-32601, &format!("method not found: {name}"));
    };
    if let Err(message) = validate_params(name, &tool["inputSchema"], &args) {
        return fail(-32602, &message);
    }
    match run_tool(store, name, &args).await {
        Ok(Ok(text)) => format!(r#"{{"id":{id},"result":{text}}}"#),
        Ok(Err(e)) if caller_facing(name, &e.message) => fail(-32602, &e.message),
        Ok(Err(e)) => {
            eprintln!("tool {name} failed: {}", e.message);
            fail(-32603, "internal error")
        }
        Err((code, message)) => fail(code, &message),
    }
}

fn missing(field: &str, tool: &str) -> (i64, String) {
    (-32602, format!("Invalid params for {tool}: '{field}' is required"))
}

fn str_arg<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str)
}

async fn call_tool(store: &Store, params: &Value) -> Result<Value, (i64, String)> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let empty = json!({});
    let a = params.get("arguments").unwrap_or(&empty);
    Ok(match run_tool(store, name, a).await? {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
        Err(e) => text_result(&e.to_json()),
    })
}

/// The tool's result as pretty JSON text, or its error, or a problem with the call itself.
async fn run_tool(store: &Store, name: &str, a: &Value) -> Result<Result<String, tools::ToolError>, (i64, String)> {
    let pretty = |v: String| Ok::<String, tools::ToolError>(v);
    let text_of = |v: &Value| v["content"][0]["text"].as_str().unwrap_or("null").to_string();
    let top_k = a.get("top_k").and_then(Value::as_f64).map(|n| n as usize).unwrap_or(10);
    let result: Result<Value, tools::ToolError> = match name {
        "list_projects" => return Ok(pretty(text_of(&text_result(&tools::list_projects())))),
        "search_code" => {
            let project = str_arg(a, "project_id").ok_or_else(|| missing("project_id", name))?;
            let query = str_arg(a, "query").ok_or_else(|| missing("query", name))?;
            tools::search_code(store, project, query, top_k, str_arg(a, "branch")).await.map(|r| text_result(&r))
        }
        "search_knowledge" => {
            let project = str_arg(a, "project_id").ok_or_else(|| missing("project_id", name))?;
            let query = str_arg(a, "query").ok_or_else(|| missing("query", name))?;
            let types: Option<Vec<String>> = a.get("item_types").and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect());
            tools::search_knowledge(store, project, query, top_k, str_arg(a, "source_id"), types.as_deref()).await.map(|r| text_result(&r))
        }
        "lookup_symbol" => {
            let project = str_arg(a, "project_id").ok_or_else(|| missing("project_id", name))?;
            let symbol = str_arg(a, "symbol_name").ok_or_else(|| missing("symbol_name", name))?;
            let input = LookupInput {
                project_id: project,
                symbol_name: symbol,
                exact: str_arg(a, "match") == Some("exact"),
                branch: str_arg(a, "branch"),
                source_id: str_arg(a, "source_id"),
                case_sensitive: a.get("case_sensitive").and_then(Value::as_bool).unwrap_or(true),
                limit: a.get("limit").and_then(Value::as_f64).map(|n| n as usize).unwrap_or(50),
            };
            tools::lookup_symbol(store, input).await.map(|r| text_result(&r))
        }
        other => return Ok(pretty(text_of(&text_result(&json!({ "error": format!("Unknown tool: {other}") }))))),
    };
    Ok(result.map(|v| text_of(&v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({ "properties": { "project_id": { "type": "string" }, "top_k": { "type": "number" }, "match": { "type": "string", "enum": ["suffix", "exact"] }, "item_types": { "type": "array", "items": { "type": "string" } } }, "required": ["project_id"] })
    }

    #[test]
    fn argument_errors_match_the_daemon_word_for_word() {
        let check = |args: Value| validate_params("t", &schema(), &args).unwrap_err();
        assert_eq!(check(json!({ "project_ids": ["a"] })), "invalid params for t: unknown key 'project_ids' (did you mean 'project_id'?)");
        assert_eq!(check(json!({ "project_id": "a", "zzzzzzzzzzzzz": 1 })), "invalid params for t: unknown key 'zzzzzzzzzzzzz'");
        assert_eq!(check(json!({ "top_k": 1 })), "invalid params for t: missing required 'project_id'");
        assert_eq!(check(json!({ "project_id": null })), "invalid params for t: missing required 'project_id'");
        assert_eq!(check(json!({ "project_id": 5 })), "invalid params for t: 'project_id' must be of type string, got number");
        assert_eq!(check(json!({ "project_id": "a", "match": "x" })), "invalid params for t: 'match' must be one of [suffix, exact], got 'x'");
        assert_eq!(check(json!({ "project_id": "a", "item_types": [1] })), "invalid params for t: 'item_types' elements must be of type string, got number");
        assert!(validate_params("t", &schema(), &json!({ "project_id": "a", "top_k": null, "match": "exact" })).is_ok());
    }

    #[test]
    fn suggestions_prefer_prefixes_then_small_typos() {
        assert_eq!(suggest_key("symbol", &["project_id", "symbol_name"]).as_deref(), Some("symbol_name"));
        assert_eq!(suggest_key("qeury", &["project_id", "query"]).as_deref(), Some("query"));
        assert_eq!(suggest_key("completely_different", &["query"]), None);
    }
}

/// Answers one JSON-RPC message. None for a notification, which has no reply.
pub async fn handle(store: &Store, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned()?;
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
    let outcome: Result<Value, (i64, String)> = match req.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST_PROTOCOL);
            Ok(json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": "scrybe", "version": VERSION } }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => call_tool(store, &params).await,
        m => Err((-32601, format!("Method not found: {m}"))),
    };
    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

pub async fn serve(store: &Store) -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            write(&mut out, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })).await?;
            continue;
        };
        if let Some(msg) = handle(store, &req).await {
            write(&mut out, &msg).await?;
        }
    }
    Ok(())
}

async fn write(out: &mut tokio::io::Stdout, msg: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(msg)?;
    bytes.push(b'\n');
    out.write_all(&bytes).await?;
    out.flush().await?;
    Ok(())
}
