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

/// Answers the shared-client call route. The result is the tool's JSON, with no text wrapping.
pub async fn rpc(store: &Store, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let params = json!({ "name": req.get("method").cloned().unwrap_or(Value::Null), "arguments": req.get("params").cloned().unwrap_or_else(|| json!({})) });
    match call_tool(store, &params).await {
        Ok(result) => {
            let text = result["content"][0]["text"].as_str().unwrap_or("null");
            let body: Value = serde_json::from_str(text).unwrap_or(Value::Null);
            json!({ "id": id, "result": body })
        }
        Err((code, message)) => json!({ "id": id, "error": { "code": code, "message": message } }),
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
    let top_k = a.get("top_k").and_then(Value::as_f64).map(|n| n as usize).unwrap_or(10);
    let result: Result<Value, tools::ToolError> = match name {
        "list_projects" => return Ok(text_result(&tools::list_projects())),
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
        other => return Ok(text_result(&json!({ "error": format!("Unknown tool: {other}") }))),
    };
    Ok(result.unwrap_or_else(|e| text_result(&e.to_json())))
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
