//! Reranking. Mirrors `src/reranker.ts` and the rerank half of `src/config.ts`.
//!
//! Two backends: an HTTP rerank endpoint (Voyage-compatible) and a local cross-encoder.
//! Both blend the reranker's score with the original rank by position.
use crate::jsstr::{js_len, js_slice};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Never ask the reranker about more than this many candidates.
pub const MAX_CANDIDATES: usize = 500;
pub const DEFAULT_LOCAL_MODEL: &str = "Xenova/ms-marco-MiniLM-L-6-v2";
const VOYAGE_RERANK_URL: &str = "https://api.voyageai.com/v1/rerank";

#[derive(Clone, Debug, PartialEq)]
pub enum Backend {
    Http { url: String, model: String },
    Local { model: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RerankConfig {
    /// `None` means reranking is off.
    pub backend: Option<Backend>,
    pub api_key: String,
    pub fetch_multiplier: usize,
    pub blend_top3: (f64, f64),
    pub blend_tail: (f64, f64),
}

impl RerankConfig {
    pub fn enabled(&self) -> bool {
        self.backend.is_some()
    }

    /// How many candidates each source fetches before the cut to `top_k`.
    pub fn fetch_count(&self, top_k: usize) -> usize {
        if self.enabled() { (top_k * self.fetch_multiplier).min(MAX_CANDIDATES) } else { top_k }
    }
}

/// Read once per process, as the TypeScript reads it once at module load.
pub fn config() -> &'static RerankConfig {
    static CFG: OnceLock<RerankConfig> = OnceLock::new();
    CFG.get_or_init(|| build(|k| std::env::var(k).ok(), &mut |m| eprintln!("{m}")))
}

/// JavaScript `parseFloat`: leading whitespace skipped, the longest numeric prefix read, NaN if none.
pub fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    let int = digits(&mut i);
    let mut frac = false;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        frac = digits(&mut j);
        if int || frac {
            i = j;
        }
    }
    if !int && !frac {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if digits(&mut j) {
            i = j;
        }
    }
    t[..i].parse().unwrap_or(f64::NAN)
}

/// JavaScript `parseInt(s, 10)`, `None` for NaN.
fn js_parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    let n: i64 = rest[..end].parse().ok()?;
    Some(if neg { -n } else { n })
}

/// `parseBlendWeights`: exactly two comma-separated finite numbers summing to 1 (±0.01).
pub fn parse_blend_weights(raw: &str, name: &str) -> Result<(f64, f64)> {
    let parts: Vec<&str> = raw.split(',').collect();
    if parts.len() != 2 {
        bail!("{name}=\"{raw}\" is invalid: expected exactly 2 comma-separated floats (e.g. \"0.75,0.25\")");
    }
    let (w0, w1) = (js_parse_float(parts[0]), js_parse_float(parts[1]));
    if !w0.is_finite() || !w1.is_finite() {
        bail!("{name}=\"{raw}\" is invalid: values must be finite numbers");
    }
    let sum = w0 + w1;
    if (sum - 1.0).abs() > 0.01 {
        bail!("{name}=\"{raw}\" is invalid: weights must sum to 1.0 (±0.01), got {sum:.4}");
    }
    Ok((w0, w1))
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url).ok()?.host_str().map(str::to_string)
}

/// `buildRerankConfig`, with the environment and the warning sink passed in.
pub fn build(env: impl Fn(&str) -> Option<String>, warn: &mut dyn FnMut(String)) -> RerankConfig {
    let non_empty = |k: &str| env(k).filter(|v| !v.is_empty());
    let mut blend = |name: &str, default: &str, fallback: (f64, f64)| {
        let raw = env(name).unwrap_or_else(|| default.to_string());
        parse_blend_weights(&raw, name).unwrap_or_else(|e| {
            warn(format!("[scrybe] {e}. Using default \"{default}\"."));
            fallback
        })
    };
    let blend_top3 = blend("SCRYBE_RERANK_BLEND_TOP3", "0.75,0.25", (0.75, 0.25));
    let blend_tail = blend("SCRYBE_RERANK_BLEND_TAIL", "0.40,0.60", (0.40, 0.60));
    // Today's build passes a non-numeric or non-positive multiplier straight through as a query limit.
    let fetch_multiplier = js_parse_int(&env("SCRYBE_RERANK_FETCH_MULTIPLIER").unwrap_or_else(|| "5".into()))
        .filter(|n| *n > 0)
        .map(|n| n as usize)
        .unwrap_or(5);
    let mut cfg = RerankConfig { backend: None, api_key: env("SCRYBE_RERANK_API_KEY").unwrap_or_default(), fetch_multiplier, blend_top3, blend_tail };
    if env("SCRYBE_RERANK").as_deref() != Some("true") {
        return cfg;
    }
    if env("SCRYBE_RERANK_PROVIDER").as_deref() == Some("local") {
        cfg.backend = Some(Backend::Local { model: env("SCRYBE_RERANK_MODEL").unwrap_or_else(|| DEFAULT_LOCAL_MODEL.into()) });
        return cfg;
    }
    if let Some(url) = env("SCRYBE_RERANK_BASE_URL").filter(|v| !v.is_empty()) {
        let model = env("SCRYBE_RERANK_MODEL").unwrap_or_default();
        if model.is_empty() {
            warn("[scrybe] SCRYBE_RERANK_BASE_URL is set but SCRYBE_RERANK_MODEL is missing. Reranking disabled.".into());
            return cfg;
        }
        cfg.backend = Some(Backend::Http { url, model });
        return cfg;
    }
    if non_empty("SCRYBE_CODE_EMBEDDING_BASE_URL").and_then(|u| host_of(&u)).as_deref() == Some("api.voyageai.com") {
        cfg.backend = Some(Backend::Http { url: VOYAGE_RERANK_URL.into(), model: env("SCRYBE_RERANK_MODEL").unwrap_or_else(|| "rerank-2.5".into()) });
        return cfg;
    }
    warn(
        "[scrybe] SCRYBE_RERANK=true is set but your embedding provider does not support auto-configured reranking. \
Options: set SCRYBE_RERANK_PROVIDER=local for in-process cross-encoder (no API key needed), \
switch to Voyage AI for auto-configured HTTP reranking, or \
set SCRYBE_RERANK_BASE_URL + SCRYBE_RERANK_MODEL for a custom HTTP reranker. \
Reranking is DISABLED."
            .into(),
    );
    cfg
}

/// A search hit the reranker can read and rescore.
pub trait Rerankable {
    fn content(&self) -> &str;
    fn set_score(&mut self, score: f64);
}

fn weights_for_rank(rank: usize, top3: (f64, f64), tail: (f64, f64)) -> (f64, f64) {
    if rank <= 3 {
        return top3;
    }
    if rank >= 11 {
        return tail;
    }
    let t = (rank as f64 - 3.0) / (11.0 - 3.0);
    (top3.0 + t * (tail.0 - top3.0), top3.1 + t * (tail.1 - top3.1))
}

/// `applyBlend`: position-aware blend of normalised rank and normalised rerank score, best first.
pub fn apply_blend<T: Rerankable>(candidates: Vec<T>, scores: &[f64], top_k: usize, top3: (f64, f64), tail: (f64, f64)) -> Vec<T> {
    let n = candidates.len();
    if n == 0 {
        return vec![];
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for &s in scores {
        if s < lo {
            lo = s;
        }
        if s > hi {
            hi = s;
        }
    }
    let range = hi - lo;
    let mut blended: Vec<(f64, T)> = candidates
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let rank = i + 1;
            let norm_rank = if n == 1 { 1.0 } else { 1.0 - (rank as f64 - 1.0) / (n as f64 - 1.0) };
            let norm_rerank = if range < 1e-10 { 1.0 } else { (scores[i] - lo) / range };
            let (wr, wx) = weights_for_rank(rank, top3, tail);
            (wr * norm_rank + wx * norm_rerank, c)
        })
        .collect();
    // Stable, like Array.prototype.sort with `b - a`.
    blended.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    blended
        .into_iter()
        .take(top_k)
        .map(|(s, mut c)| {
            c.set_score(s);
            c
        })
        .collect()
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().user_agent(crate::config::USER_AGENT).timeout(Duration::from_secs(600)).build().expect("HTTP client"))
}

async fn scores_http(cfg: &RerankConfig, url: &str, model: &str, query: &str, docs: &[&str]) -> Result<Vec<f64>> {
    let body = serde_json::json!({
        "model": model,
        "query": query,
        "documents": docs,
        "top_k": docs.len(),
        "return_documents": false,
    });
    let res = http_client().post(url).header("Content-Type", "application/json").header("Authorization", format!("Bearer {}", cfg.api_key)).body(body.to_string()).send().await?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        bail!("Rerank API error {}: {text}", status.as_u16());
    }
    let data: serde_json::Value = res.json().await?;
    let Some(items) = data["data"].as_array() else { bail!("Rerank API reply has no data list") };
    let mut scores = vec![0.0; docs.len()];
    for item in items {
        // An index outside the candidate list is dropped; today's build would grow its score list.
        if let (Some(i), Some(s)) = (item["index"].as_u64(), item["relevance_score"].as_f64()) {
            if let Some(slot) = scores.get_mut(i as usize) {
                *slot = s;
            }
        }
    }
    Ok(scores)
}

/// `rerank`: reorder `candidates` (best first on entry) and keep `top_k`.
pub async fn rerank<T: Rerankable>(cfg: &RerankConfig, query: &str, candidates: Vec<T>, top_k: usize) -> Result<Vec<T>> {
    let Some(backend) = &cfg.backend else {
        return Ok(candidates.into_iter().take(top_k).collect());
    };
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    let scores = match backend {
        Backend::Http { url, model } => {
            let docs: Vec<&str> = candidates.iter().map(|c| c.content()).collect();
            scores_http(cfg, url, model, query, &docs).await?
        }
        Backend::Local { model } => match local_scores(model, query, &candidates).await {
            Ok(s) => s,
            Err(_) => {
                eprintln!("[scrybe] reranker model unavailable ({model}); returning non-reranked order");
                return Ok(candidates.into_iter().take(top_k).collect());
            }
        },
    };
    Ok(apply_blend(candidates, &scores, top_k, cfg.blend_top3, cfg.blend_tail))
}

/// The passage half of each pair is cut to this many UTF-16 units before tokenizing.
const LOCAL_MAX_PASSAGE_CHARS: usize = 1500;

/// A sequence-classification model run on (query, passage) pairs, as the text-classification pipeline runs it.
pub struct CrossEncoder {
    tokenizer: tokenizers::Tokenizer,
    session: Mutex<ort::session::Session>,
    max_len: usize,
    pad_id: i64,
    wants_token_type_ids: bool,
    shrink_arena: bool,
}

impl CrossEncoder {
    pub fn load_from(dir: &std::path::Path) -> Result<Self> {
        use crate::embed;
        let onnx = dir.join("onnx").join("model_quantized.onnx");
        if !onnx.exists() {
            bail!("reranker model not found at {}", onnx.display());
        }
        let mut tokenizer = embed::load_tokenizer(&dir.join("tokenizer.json"))?;
        // transformers.js ignores any truncation or padding the file declares and does its own, below.
        tokenizer.with_truncation(None).map_err(|e| anyhow!("tokenizer: {e}"))?;
        tokenizer.with_padding(None);
        let tcfg: serde_json::Value = std::fs::read_to_string(dir.join("tokenizer_config.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let max_len = tcfg["model_max_length"].as_u64().map(|n| n as usize).unwrap_or(512);
        let pad_id = tcfg["pad_token"].as_str().and_then(|t| tokenizer.token_to_id(t)).unwrap_or(0) as i64;
        let mut builder = ort::session::Session::builder(embed::ort_env()?).map_err(|e| anyhow!("onnx: {e}"))?;
        builder = builder.with_intra_threads(embed::thread_count()).map_err(|e| anyhow!("onnx: {e}"))?;
        let (arena, shrink_arena) = embed::arena_mode();
        if !arena {
            builder = builder.with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()]).map_err(|e| anyhow!("onnx: {e}"))?;
        }
        let session = builder.commit_from_file(&onnx).map_err(|e| anyhow!("onnx: {e}"))?;
        let wants_token_type_ids = session.inputs().iter().any(|i| i.name() == "token_type_ids");
        Ok(CrossEncoder { tokenizer, session: Mutex::new(session), max_len, pad_id, wants_token_type_ids, shrink_arena })
    }

    /// Pair ids and type ids, special tokens added, then cut at the model limit from the end.
    pub fn encode_pair(&self, query: &str, passage: &str) -> Result<(Vec<u32>, Vec<u32>)> {
        let enc = self.tokenizer.encode((query, passage), true).map_err(|e| anyhow!("tokenizer: {e}"))?;
        let mut ids = enc.get_ids().to_vec();
        let mut types = enc.get_type_ids().to_vec();
        ids.truncate(self.max_len);
        types.truncate(self.max_len);
        Ok((ids, types))
    }

    /// One relevance score per passage: the raw logit for a one-label model, else the positive class after softmax.
    /// Pairs run in passes of at most `budget` padded token slots, shortest first; `budget` 0 runs them all in
    /// one pass, as today's build does. The int8 model quantizes each pass as a whole, so a split changes scores.
    pub fn score_with_budget(&self, query: &str, passages: &[String], budget: usize) -> Result<Vec<f64>> {
        let encs: Vec<(Vec<u32>, Vec<u32>)> = passages.iter().map(|p| self.encode_pair(query, p)).collect::<Result<_>>()?;
        let groups = plan_passes(&encs.iter().map(|e| e.0.len()).collect::<Vec<_>>(), budget);
        let mut scores = vec![0.0; encs.len()];
        let n_groups = groups.len();
        for (g, group) in groups.into_iter().enumerate() {
            let part: Vec<&(Vec<u32>, Vec<u32>)> = group.iter().map(|&i| &encs[i]).collect();
            for (i, s) in group.into_iter().zip(self.score_pass(&part, g + 1 == n_groups)?) {
                scores[i] = s;
            }
        }
        crate::embed::release_free_memory();
        Ok(scores)
    }

    pub fn score(&self, query: &str, passages: &[String]) -> Result<Vec<f64>> {
        self.score_with_budget(query, passages, pass_budget())
    }

    fn score_pass(&self, encs: &[&(Vec<u32>, Vec<u32>)], last: bool) -> Result<Vec<f64>> {
        use ort::value::Tensor;
        let rows = encs.len();
        let n = encs.iter().map(|e| e.0.len()).max().unwrap_or(0).min(self.max_len);
        let mut ids = vec![self.pad_id; rows * n];
        let mut mask = vec![0i64; rows * n];
        let mut types = vec![0i64; rows * n];
        for (r, (e, t)) in encs.iter().enumerate() {
            for c in 0..e.len() {
                ids[r * n + c] = e[c] as i64;
                mask[r * n + c] = 1;
                types[r * n + c] = t[c] as i64;
            }
        }
        let mut inputs = vec![("input_ids", Tensor::from_array(([rows, n], ids))?.into_dyn()), ("attention_mask", Tensor::from_array(([rows, n], mask))?.into_dyn())];
        if self.wants_token_type_ids {
            inputs.push(("token_type_ids", Tensor::from_array(([rows, n], types))?.into_dyn()));
        }
        let mut session = self.session.lock().unwrap();
        // Hand the pass buffers back after the last pass: one batch of 50 long pairs needs about 3 GB.
        let shrink = if last && self.shrink_arena {
            let mut o = ort::session::RunOptions::new().map_err(|e| anyhow!("onnx: {e}"))?;
            o.set("memory.enable_memory_arena_shrinkage", "cpu:0").map_err(|e| anyhow!("onnx: {e}"))?;
            Some(o)
        } else {
            None
        };
        let outputs = match &shrink {
            Some(o) => session.run_with_options(inputs, o),
            None => session.run(inputs),
        }
        .map_err(|e| anyhow!("onnx: {e}"))?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| anyhow!("onnx: {e}"))?;
        let labels = shape.get(1).copied().unwrap_or(1).max(1) as usize;
        let mut scores = Vec::with_capacity(rows);
        for r in 0..rows {
            let row: Vec<f64> = data.get(r * labels..(r + 1) * labels).map(|s| s.iter().map(|&v| v as f64).collect()).unwrap_or_default();
            let s = match row.len() {
                0 => 0.0,
                1 => row[0],
                _ => {
                    let max = row.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    let exps: Vec<f64> = row.iter().map(|x| (x - max).exp()).collect();
                    let sum: f64 = exps.iter().sum();
                    exps[1] / sum
                }
            };
            scores.push(if s.is_finite() { s } else { 0.0 });
        }
        Ok(scores)
    }
}

/// Splitting the pairs keeps a search's peak under 1 GB instead of 3.
const DEFAULT_PASS_BUDGET: usize = 4096;

/// `SCRYBE_RERANK_TOKEN_BUDGET`: padded token slots per pass; `0` runs every pair in one pass.
fn pass_budget() -> usize {
    pass_budget_from(std::env::var("SCRYBE_RERANK_TOKEN_BUDGET").ok().as_deref())
}

fn pass_budget_from(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.trim().parse().ok()).unwrap_or(DEFAULT_PASS_BUDGET)
}

/// Groups of indices, shortest first, each within `budget` padded slots (always at least one pair).
fn plan_passes(lens: &[usize], budget: usize) -> Vec<Vec<usize>> {
    if budget == 0 || lens.is_empty() {
        return if lens.is_empty() { vec![] } else { vec![(0..lens.len()).collect()] };
    }
    let mut order: Vec<usize> = (0..lens.len()).collect();
    order.sort_by_key(|&i| lens[i]);
    let mut groups = vec![];
    let mut i = 0;
    while i < order.len() {
        let (mut padded, mut n) = (0, 0);
        while i + n < order.len() {
            let next = padded.max(lens[order[i + n]]);
            if n > 0 && next * (n + 1) > budget {
                break;
            }
            padded = next;
            n += 1;
        }
        groups.push(order[i..i + n].to_vec());
        i += n;
    }
    groups
}

/// Kept for the life of the process, as the pipeline cache is.
fn cross_encoder(model: &str) -> Result<Arc<CrossEncoder>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<CrossEncoder>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    if let Some(ce) = cache.get(model) {
        return Ok(ce.clone());
    }
    let ce = Arc::new(CrossEncoder::load_from(&crate::embed::models_dir().join(model))?);
    crate::embed::release_free_memory();
    cache.insert(model.to_string(), ce.clone());
    Ok(ce)
}

async fn local_scores<T: Rerankable>(model: &str, query: &str, candidates: &[T]) -> Result<Vec<f64>> {
    // The pipeline downloads on first use, on the search path.
    crate::embed::ensure_model(model, None).await?;
    let passages: Vec<String> = candidates.iter().map(|c| if js_len(c.content()) > LOCAL_MAX_PASSAGE_CHARS { js_slice(c.content(), LOCAL_MAX_PASSAGE_CHARS) } else { c.content().to_string() }).collect();
    let (model, query) = (model.to_string(), query.to_string());
    tokio::task::spawn_blocking(move || cross_encoder(&model)?.score(&query, &passages)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Debug, Clone, PartialEq)]
    struct C(&'static str, f64);
    impl Rerankable for C {
        fn content(&self) -> &str {
            self.0
        }
        fn set_score(&mut self, s: f64) {
            self.1 = s;
        }
    }

    fn cfg_from(pairs: &[(&str, &str)]) -> (RerankConfig, Vec<String>) {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut warnings = vec![];
        let c = build(|k| m.get(k).cloned(), &mut |w| warnings.push(w));
        (c, warnings)
    }

    #[test]
    fn pass_size_parsing() {
        assert_eq!(pass_budget_from(None), 4096);
        assert_eq!(pass_budget_from(Some("0")), 0, "0 is still one pass");
        assert_eq!(pass_budget_from(Some(" 1024 ")), 1024);
        assert_eq!(pass_budget_from(Some("junk")), 4096);
    }

    /// Needs the cross-encoder's folder, so it runs only when `SCRYBE_TEST_RERANK_MODEL_DIR` points at one.
    #[test]
    fn cross_encoder_pairs_match_transformers_js_and_rank_sensibly() {
        let Ok(dir) = std::env::var("SCRYBE_TEST_RERANK_MODEL_DIR") else { return };
        let ce = CrossEncoder::load_from(std::path::Path::new(&dir)).unwrap();
        let q = "how are search results reranked";
        // Ids as transformers.js 2.17.2 gives them for the same pair.
        let (ids, types) = ce.encode_pair(q, "def calibrate_gadget(level):\n    return level * 3\n").unwrap();
        assert_eq!(ids, [101, 2129, 2024, 3945, 3463, 2128, 26763, 2098, 102, 13366, 10250, 12322, 11657, 1035, 11721, 24291, 1006, 2504, 1007, 1024, 2709, 2504, 1008, 1017, 102]);
        assert_eq!(types.iter().filter(|&&t| t == 0).count(), 9);
        assert_eq!(ce.encode_pair(q, "").unwrap().0, [101, 2129, 2024, 3945, 3463, 2128, 26763, 2098, 102, 102]);
        // Cut from the end at the model limit, so the closing separator is lost.
        let (long, _) = ce.encode_pair(q, &"rerank the results ".repeat(400)).unwrap();
        assert_eq!(long.len(), 512);
        assert_ne!(long[511], 102);
        let scores = ce.score(q, &["Search results are reranked by a cross-encoder and blended with their rank.".into(), "The fan spins at three thousand RPM.".into()]).unwrap();
        assert!(scores[0] > scores[1], "{scores:?}");
    }

    #[test]
    fn passes_stay_within_the_budget_and_cover_every_pair() {
        assert_eq!(plan_passes(&[5, 1, 3], 0), vec![vec![0, 1, 2]]);
        assert!(plan_passes(&[], 4096).is_empty());
        let lens = [512, 10, 300, 512, 40, 512];
        let groups = plan_passes(&lens, 1024);
        assert_eq!(groups, vec![vec![1, 4, 2], vec![0, 3], vec![5]]);
        // A pair longer than the budget still gets a pass of its own.
        assert_eq!(plan_passes(&[600], 512), vec![vec![0]]);
    }

    #[test]
    fn parse_float_matches_javascript() {
        assert_eq!(js_parse_float(" 0.75abc"), 0.75);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert_eq!(js_parse_float("5."), 5.0);
        assert_eq!(js_parse_float("1e-1x"), 0.1);
        assert_eq!(js_parse_float("1e"), 1.0);
        assert_eq!(js_parse_float("-Infinity"), f64::NEG_INFINITY);
        assert!(js_parse_float("abc").is_nan());
        assert!(js_parse_float(".").is_nan());
        assert!(js_parse_float("").is_nan());
    }

    #[test]
    fn blend_weights_are_checked() {
        assert_eq!(parse_blend_weights("0.6, 0.4", "X").unwrap(), (0.6, 0.4));
        assert!(parse_blend_weights("0.6", "X").unwrap_err().to_string().contains("exactly 2"));
        assert!(parse_blend_weights("a,b", "X").unwrap_err().to_string().contains("finite"));
        assert!(parse_blend_weights("0.5,0.6", "X").unwrap_err().to_string().contains("got 1.1000"));
    }

    #[test]
    fn config_follows_todays_precedence() {
        assert_eq!(cfg_from(&[]).0.backend, None);
        assert_eq!(cfg_from(&[("SCRYBE_RERANK", "true"), ("SCRYBE_RERANK_PROVIDER", "local")]).0.backend, Some(Backend::Local { model: DEFAULT_LOCAL_MODEL.into() }));
        let (c, w) = cfg_from(&[("SCRYBE_RERANK", "true"), ("SCRYBE_RERANK_BASE_URL", "http://x/rerank")]);
        assert_eq!(c.backend, None);
        assert!(w[0].contains("SCRYBE_RERANK_MODEL is missing"));
        let (c, _) = cfg_from(&[("SCRYBE_RERANK", "true"), ("SCRYBE_RERANK_BASE_URL", "http://x/rerank"), ("SCRYBE_RERANK_MODEL", "m")]);
        assert_eq!(c.backend, Some(Backend::Http { url: "http://x/rerank".into(), model: "m".into() }));
        let (c, _) = cfg_from(&[("SCRYBE_RERANK", "true"), ("SCRYBE_CODE_EMBEDDING_BASE_URL", "https://api.voyageai.com/v1")]);
        assert_eq!(c.backend, Some(Backend::Http { url: VOYAGE_RERANK_URL.into(), model: "rerank-2.5".into() }));
        let (c, w) = cfg_from(&[("SCRYBE_RERANK", "true")]);
        assert_eq!(c.backend, None);
        assert!(w[0].contains("Reranking is DISABLED"));
        let (c, w) = cfg_from(&[("SCRYBE_RERANK_BLEND_TOP3", "1,1"), ("SCRYBE_RERANK_FETCH_MULTIPLIER", "3x")]);
        assert_eq!((c.blend_top3, c.fetch_multiplier), ((0.75, 0.25), 3));
        assert!(w[0].ends_with("Using default \"0.75,0.25\"."));
    }

    #[test]
    fn fetch_count_is_capped() {
        let (mut c, _) = cfg_from(&[("SCRYBE_RERANK", "true"), ("SCRYBE_RERANK_PROVIDER", "local")]);
        assert_eq!(c.fetch_count(10), 50);
        assert_eq!(c.fetch_count(200), MAX_CANDIDATES);
        c.backend = None;
        assert_eq!(c.fetch_count(10), 10);
    }

    #[test]
    fn blend_matches_the_formula() {
        let cands: Vec<C> = ["a", "b", "c", "d", "e"].iter().map(|s| C(s, 0.0)).collect();
        // The reranker likes the last candidate best.
        let out = apply_blend(cands, &[0.0, 0.1, 0.2, 0.3, 1.0], 3, (0.75, 0.25), (0.40, 0.60));
        // a: 0.75*1 + 0.25*0 = 0.75; e: rank 5, t=0.25 -> w=(0.6625, 0.3375): 0 + 0.3375; b: 0.75*0.75 + 0.25*0.1 = 0.5875
        assert_eq!(out.iter().map(|c| c.0).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(out[0].1, 0.75);
        assert_eq!(out[1].1, 0.75 * 0.75 + 0.25 * 0.1);
        // Equal rerank scores normalise to 1 and keep the original order.
        let out = apply_blend(vec![C("x", 0.0), C("y", 0.0)], &[0.3, 0.3], 2, (0.75, 0.25), (0.40, 0.60));
        assert_eq!(out, vec![C("x", 1.0), C("y", 0.25)]);
    }
}
