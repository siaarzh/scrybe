//! OpenAI-compatible embedding client. Mirrors `src/embedder.ts`, `src/embed-batch-state.ts`, and the
//! request and retry behaviour of the openai package underneath them.
use crate::config::data_dir;
use crate::jsstr::{js_len, js_slice};
use crate::registry::EmbedConfig;
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

/// What one run has learned about the batch size this provider accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct Halving {
    pub effective: usize,
    pub max_failed: Option<usize>,
    pub halved: bool,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(600)).build().expect("HTTP client"))
}

pub fn decode_embedding(v: &Value) -> Option<Vec<f32>> {
    match v {
        Value::String(s) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
            Some(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
        }
        Value::Array(a) => a.iter().map(|x| x.as_f64().map(|n| n as f32)).collect(),
        _ => None,
    }
}

/// Validates a response body the way `embedTextsOnce` does.
pub fn parse_vectors(body: &Value, cfg: &EmbedConfig) -> Result<Vec<Vec<f32>>> {
    let mut items: Vec<(i64, Option<Vec<f32>>)> = body["data"].as_array().map_or(vec![], |d| d.iter().map(|i| (i["index"].as_i64().unwrap_or(0), decode_embedding(&i["embedding"]))).collect());
    items.sort_by_key(|(i, _)| *i);
    let bad = |v: &Option<Vec<f32>>| v.as_ref().is_none_or(|x| x.is_empty() || x.iter().any(|n| !n.is_finite()));
    if items.is_empty() || items.iter().any(|(_, v)| bad(v)) {
        let wanted = if cfg.encoding_float { " for encoding_format:\"float\"" } else { " after base64 decoding" };
        bail!("Embedding encoding mismatch for model \"{}\". Expected finite numeric arrays{wanted}. Check the endpoint's response encoding before changing dimensions.", cfg.model);
    }
    let vectors: Vec<Vec<f32>> = items.into_iter().filter_map(|(_, v)| v).collect();
    let actual = vectors[0].len() as i32;
    if actual != cfg.dimensions {
        let hint = if !cfg.encoding_float && actual * 4 == cfg.dimensions {
            "The endpoint may have returned float arrays to the SDK's base64 request. Set encoding_format:\"float\" on this custom preset and retry before changing dimensions."
        } else {
            "Check the model and response encoding before changing the configured dimensions."
        };
        bail!("Embedding model \"{}\" returned {actual}d vectors but config expects {}d. {hint}", cfg.model, cfg.dimensions);
    }
    Ok(vectors)
}

fn retryable(status: u16) -> bool {
    matches!(status, 408 | 409 | 429) || status >= 500
}

fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    if let Some(d) = retry_after.filter(|d| *d < Duration::from_secs(60)) {
        return d;
    }
    let base = (0.5 * 2f64.powi(attempt as i32)).min(8.0);
    let jitter = 1.0 - 0.25 * (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()) as f64 / 1e9);
    Duration::from_secs_f64(base * jitter)
}

fn retry_after(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    let text = |k: &str| h.get(k).and_then(|v| v.to_str().ok());
    if let Some(ms) = text("retry-after-ms").and_then(|v| v.parse::<f64>().ok()) {
        return Some(Duration::from_secs_f64(ms.max(0.0) / 1000.0));
    }
    text("retry-after").and_then(|v| v.parse::<f64>().ok()).map(|s| Duration::from_secs_f64(s.max(0.0)))
}

/// One logical request: the openai package retries twice by itself before anyone else sees an error.
async fn post(cfg: &EmbedConfig, texts: &[String]) -> Result<Value, ApiError> {
    let url = format!("{}/embeddings", cfg.base_url.trim_end_matches('/'));
    let cap = cfg.char_cap();
    let input: Vec<String> = texts.iter().map(|t| if js_len(t) > cap { js_slice(t, cap) } else { t.clone() }).collect();
    let encoding = if cfg.encoding_float { "float" } else { "base64" };
    let body = json!({ "model": cfg.model, "input": input, "encoding_format": encoding });
    let mut attempt = 0;
    loop {
        let sent = client().post(&url).bearer_auth(&cfg.credentials).json(&body).send().await;
        let (status, wait, message) = match sent {
            Err(e) => (0, None, format!("Connection error: {e}")),
            Ok(r) => {
                let status = r.status().as_u16();
                let wait = retry_after(r.headers());
                let refuse = r.headers().get("x-should-retry").and_then(|v| v.to_str().ok()) == Some("false");
                let text = r.text().await.unwrap_or_default();
                if (200..300).contains(&status) {
                    return serde_json::from_str(&text).map_err(|e| ApiError { status: 0, message: format!("invalid JSON from the embedding endpoint: {e}") });
                }
                let parsed: Option<Value> = serde_json::from_str(&text).ok();
                let message = parsed.as_ref().and_then(|b| b["error"]["message"].as_str().or(b["message"].as_str()).map(String::from)).unwrap_or_else(|| if text.is_empty() { format!("{status} status code (no body)") } else { format!("{status} {text}") });
                if refuse {
                    return Err(ApiError { status, message });
                }
                (status, wait, message)
            }
        };
        if attempt >= 2 || !(status == 0 || retryable(status)) {
            return Err(ApiError { status, message });
        }
        tokio::time::sleep(backoff(attempt, wait)).await;
        attempt += 1;
    }
}

/// `embedTexts`: a 429 that outlasts the package's own retries waits longer, up to 5 times.
pub async fn embed_texts(cfg: &EmbedConfig, texts: &[String]) -> Result<Vec<Vec<f32>>, ApiError> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let mut delay: u64 = std::env::var("SCRYBE_EMBED_RETRY_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000);
    for attempt in 0..5 {
        let failure = match post(cfg, texts).await {
            Ok(body) => match parse_vectors(&body, cfg) {
                Ok(v) => return Ok(v),
                Err(e) => ApiError { status: 0, message: e.to_string() },
            },
            Err(e) => e,
        };
        let is_429 = failure.status == 429 || (failure.status == 0 && failure.message.contains("429"));
        if is_429 && attempt < 4 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            delay *= 2;
            continue;
        }
        let shown = if failure.status != 0 { failure.status.to_string() } else if is_429 { "429".to_string() } else { "unknown".to_string() };
        let body = if cfg.credentials.is_empty() { failure.message } else { failure.message.replace(&cfg.credentials, "[redacted]") };
        return Err(ApiError { status: failure.status, message: format!("Embedding API error (HTTP {shown}): {body}") });
    }
    unreachable!("the last attempt always returns")
}

fn too_large(e: &ApiError) -> bool {
    matches!(e.status, 400 | 413) || e.message.contains("HTTP 400") || e.message.contains("HTTP 413")
}

/// `embedWithHalving`: splits a rejected batch, and remembers the first size that failed.
async fn with_halving(cfg: &EmbedConfig, texts: &[String], session: &mut Halving) -> Result<Vec<Vec<f32>>> {
    match embed_texts(cfg, texts).await {
        Ok(v) => Ok(v),
        Err(e) if !too_large(&e) => bail!("{}", e.message),
        Err(e) => {
            if texts.len() == 1 {
                bail!("bad_chunk: single chunk rejected by embedding API");
            }
            if !session.halved {
                session.max_failed = Some(texts.len());
                session.effective = (texts.len() / 2).max(1);
                session.halved = true;
            }
            let mid = texts.len() / 2;
            let mut left = Box::pin(with_halving(cfg, &texts[..mid], session)).await?;
            left.extend(Box::pin(with_halving(cfg, &texts[mid..], session)).await?);
            Ok(left)
        }
    }
}

/// The API branch of `embedBatched`.
pub async fn embed_batched(cfg: &EmbedConfig, texts: &[String], delay_ms: u64, session: &mut Halving) -> Result<Vec<Vec<f32>>> {
    let mut out = Vec::with_capacity(texts.len());
    let mut i = 0;
    while i < texts.len() {
        if i > 0 && delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        let end = (i + session.effective.max(1)).min(texts.len());
        out.extend(with_halving(cfg, &texts[i..end], session).await?);
        i = end;
    }
    Ok(out)
}

// ─── Batch-size memory between runs ──────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry {
    pub last_successful: usize,
    pub max_failed: usize,
}

/// `computeProbeSize`: halfway to the last failure, until the two meet.
pub fn probe_size(entry: Option<Entry>, ceiling: usize) -> usize {
    match entry {
        None => ceiling,
        Some(e) if e.max_failed.saturating_sub(e.last_successful) <= 1 => e.last_successful,
        Some(e) => (e.last_successful + e.max_failed) / 2,
    }
}

fn state_path() -> std::path::PathBuf {
    data_dir().join("embed-batch-state.json")
}

pub fn read_entry(key: &str) -> Option<Entry> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(state_path()).ok()?).ok()?;
    let e = &doc["entries"][key];
    Some(Entry { last_successful: e["lastSuccessful"].as_u64()? as usize, max_failed: e["maxFailed"].as_u64()? as usize })
}

pub fn write_entry(key: &str, entry: Entry) -> Result<()> {
    let path = state_path();
    let mut doc: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({ "schemaVersion": 1, "entries": {} }));
    if !doc["entries"].is_object() {
        doc["entries"] = json!({});
    }
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    doc["entries"][key] = json!({ "lastSuccessful": entry.last_successful, "maxFailed": entry.max_failed, "updatedAt": now });
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)? + "\n").context("writing embed-batch-state")?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> EmbedConfig {
        EmbedConfig { local: false, base_url: "http://x/v1".into(), model: "m".into(), dimensions: 2, credentials: "k".into(), encoding_float: false, max_input_tokens: None, query_prefix: String::new(), passage_prefix: String::new() }
    }

    #[test]
    fn probe_sizes_converge_like_the_typescript() {
        assert_eq!(probe_size(None, 100), 100);
        assert_eq!(probe_size(Some(Entry { last_successful: 50, max_failed: 100 }), 100), 75);
        assert_eq!(probe_size(Some(Entry { last_successful: 75, max_failed: 76 }), 100), 75);
        assert_eq!(probe_size(Some(Entry { last_successful: 100, max_failed: 0 }), 100), 100);
    }

    #[test]
    fn base64_and_float_replies_decode_and_sort_by_index() {
        let le = |a: f32, b: f32| base64::engine::general_purpose::STANDARD.encode([a.to_le_bytes(), b.to_le_bytes()].concat());
        let body = json!({ "data": [{ "index": 1, "embedding": le(1.0, 2.0) }, { "index": 0, "embedding": [3.0, 4.0] }] });
        assert_eq!(parse_vectors(&body, &cfg()).unwrap(), vec![vec![3.0, 4.0], vec![1.0, 2.0]]);
    }

    #[test]
    fn bad_replies_name_the_problem() {
        assert!(parse_vectors(&json!({ "data": [] }), &cfg()).unwrap_err().to_string().contains("encoding mismatch"));
        assert!(parse_vectors(&json!({ "data": [{ "index": 0, "embedding": ["x"] }] }), &cfg()).unwrap_err().to_string().contains("encoding mismatch"));
        let wrong = parse_vectors(&json!({ "data": [{ "index": 0, "embedding": [1.0] }] }), &EmbedConfig { dimensions: 4, ..cfg() }).unwrap_err().to_string();
        assert!(wrong.contains("returned 1d vectors but config expects 4d") && wrong.contains("encoding_format"), "{wrong}");
    }

    #[test]
    fn only_rejection_statuses_count_as_too_large() {
        assert!(too_large(&ApiError { status: 413, message: String::new() }));
        assert!(too_large(&ApiError { status: 400, message: String::new() }));
        assert!(!too_large(&ApiError { status: 500, message: String::new() }));
    }
}
