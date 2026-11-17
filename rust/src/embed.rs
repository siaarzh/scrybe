//! Local query embedding. Same ONNX file and pooling as `src/local-embedder.ts`.
use crate::config::data_dir;
use crate::jsstr::{js_len, js_slice};
use anyhow::{anyhow, Result};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokenizers::Tokenizer;

const MAX_SEQ_TOKENS: usize = 512;
const MAX_CHARS_PER_TOKEN: usize = 64;

pub struct Embedder {
    tokenizer: Tokenizer,
    session: Mutex<Session>,
    wants_token_type_ids: bool,
}

fn thread_count() -> usize {
    std::env::var("SCRYBE_ORT_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(2)
}

/// The library reads a model section through two throwaway JSON trees, which leaves the live
/// vocabulary scattered among freed scraps the allocator can't give back. For a unigram model,
/// free that copy whole and read the vocabulary again straight from the file.
fn load_tokenizer(path: &std::path::Path) -> Result<Tokenizer> {
    use tokenizers::models::unigram::Unigram;
    use tokenizers::ModelWrapper;
    let mut tokenizer = Tokenizer::from_file(path).map_err(|e| anyhow!("tokenizer: {e}"))?;
    if matches!(tokenizer.get_model(), ModelWrapper::Unigram(_)) {
        tokenizer.with_model(ModelWrapper::Unigram(Unigram::default()));
        release_free_memory();
        #[derive(serde::Deserialize)]
        struct File {
            model: Unigram,
        }
        let raw = std::fs::read_to_string(path)?;
        let file: File = serde_json::from_str(&raw).map_err(|e| anyhow!("tokenizer: {e}"))?;
        drop(raw);
        tokenizer.with_model(ModelWrapper::Unigram(file.model));
    }
    Ok(tokenizer)
}

impl Embedder {
    /// transformers.js adds special tokens and then cuts at the limit, so a long text loses its end
    /// marker. Hugging Face's own truncation would keep it, and the vector would differ.
    fn encode_ids(&self, text: &str) -> Result<Vec<u32>> {
        let enc = self.tokenizer.encode(text, true).map_err(|e| anyhow!("tokenizer: {e}"))?;
        let mut ids = enc.get_ids().to_vec();
        ids.truncate(MAX_SEQ_TOKENS);
        Ok(ids)
    }

    fn load(model: &str) -> Result<Self> {
        let dir = models_dir().join(model);
        let onnx = dir.join("onnx").join("model_quantized.onnx");
        if !onnx.exists() {
            anyhow::bail!("embedding model not found at {}", onnx.display());
        }
        let tokenizer = load_tokenizer(&dir.join("tokenizer.json"))?;
        let env = ort::init().build().map_err(|e| anyhow!("onnx: {e}"))?;
        let mut builder = Session::builder(&env).map_err(|e| anyhow!("onnx: {e}"))?;
        builder = builder.with_intra_threads(thread_count()).map_err(|e| anyhow!("onnx: {e}"))?;
        if std::env::var("SCRYBE_ORT_MEM_PATTERN").as_deref() == Ok("0") {
            builder = builder.with_memory_pattern(false).map_err(|e| anyhow!("onnx: {e}"))?;
        }
        builder = match std::env::var("SCRYBE_ORT_OPT").as_deref() {
            Ok("0") => builder.with_optimization_level(GraphOptimizationLevel::Disable),
            Ok("1") => builder.with_optimization_level(GraphOptimizationLevel::Level1),
            Ok("2") => builder.with_optimization_level(GraphOptimizationLevel::Level2),
            Ok("3") => builder.with_optimization_level(GraphOptimizationLevel::Level3),
            _ => Ok(builder),
        }
        .map_err(|e| anyhow!("onnx: {e}"))?;
        for kv in std::env::var("SCRYBE_ORT_CONFIG").unwrap_or_default().split(',').filter(|s| !s.is_empty()) {
            if let Some((k, v)) = kv.split_once('=') {
                builder = builder.with_config_entry(k, v).map_err(|e| anyhow!("onnx: {e}"))?;
            }
        }
        // The arena keeps a job's peak buffers for the life of the process; without it they go
        // back to malloc and the trim after each pass returns them. Same vectors either way.
        if std::env::var("SCRYBE_ORT_ARENA").as_deref() != Ok("1") {
            builder = builder.with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()]).map_err(|e| anyhow!("onnx: {e}"))?;
        }
        let session = builder.commit_from_file(&onnx).map_err(|e| anyhow!("onnx: {e}"))?;
        let wants_token_type_ids = session.inputs().iter().any(|i| i.name() == "token_type_ids");
        Ok(Embedder { tokenizer, session: Mutex::new(session), wants_token_type_ids })
    }

    /// Mean pooling over the attention mask, then L2 normalize.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let raw = self.encode_ids(text)?;
        let n = raw.len();
        let ids: Vec<i64> = raw.iter().map(|&v| v as i64).collect();
        let mask: Vec<i64> = vec![1; n];
        let mut inputs = vec![
            ("input_ids", Tensor::from_array(([1usize, n], ids))?.into_dyn()),
            ("attention_mask", Tensor::from_array(([1usize, n], mask.clone()))?.into_dyn()),
        ];
        if self.wants_token_type_ids {
            inputs.push(("token_type_ids", Tensor::from_array(([1usize, n], vec![0i64; n]))?.into_dyn()));
        }
        let mut session = self.session.lock().unwrap();
        let outputs = session.run(inputs).map_err(|e| anyhow!("onnx: {e}"))?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| anyhow!("onnx: {e}"))?;
        let dim = *shape.last().ok_or_else(|| anyhow!("onnx: empty output shape"))? as usize;
        let mut out = vec![0f32; dim];
        let mut count = 0f32;
        for (t, &m) in mask.iter().enumerate() {
            if m != 0 {
                for d in 0..dim {
                    out[d] += data[t * dim + d];
                }
                count += 1.0;
            }
        }
        out.iter_mut().for_each(|v| *v /= count.max(1.0));
        let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
        out.iter_mut().for_each(|v| *v /= norm);
        Ok(out)
    }
}

impl Embedder {
    /// One forward pass over several texts, padded to the longest, as transformers.js does.
    fn embed_group(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let encs: Vec<Vec<u32>> = texts.iter().map(|t| self.encode_ids(t)).collect::<Result<_>>()?;
        let n = encs.iter().map(Vec::len).max().unwrap_or(0);
        let rows = encs.len();
        let pad = self.tokenizer.token_to_id("<pad>").unwrap_or(1) as i64;
        let mut ids = vec![pad; rows * n];
        let mut mask = vec![0i64; rows * n];
        for (r, e) in encs.iter().enumerate() {
            for (c, &id) in e.iter().enumerate() {
                ids[r * n + c] = id as i64;
                mask[r * n + c] = 1;
            }
        }
        let mut inputs = vec![
            ("input_ids", Tensor::from_array(([rows, n], ids))?.into_dyn()),
            ("attention_mask", Tensor::from_array(([rows, n], mask.clone()))?.into_dyn()),
        ];
        if self.wants_token_type_ids {
            inputs.push(("token_type_ids", Tensor::from_array(([rows, n], vec![0i64; rows * n]))?.into_dyn()));
        }
        let mut session = self.session.lock().unwrap();
        let outputs = session.run(inputs).map_err(|e| anyhow!("onnx: {e}"))?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| anyhow!("onnx: {e}"))?;
        let dim = *shape.last().ok_or_else(|| anyhow!("onnx: empty output shape"))? as usize;
        let mut out = Vec::with_capacity(rows);
        for r in 0..rows {
            let mut v = vec![0f32; dim];
            let mut count = 0f32;
            for t in 0..n {
                if mask[r * n + t] != 0 {
                    let base = (r * n + t) * dim;
                    for d in 0..dim {
                        v[d] += data[base + d];
                    }
                    count += 1.0;
                }
            }
            v.iter_mut().for_each(|x| *x /= count.max(1.0));
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
            v.iter_mut().for_each(|x| *x /= norm);
            out.push(v);
        }
        Ok(out)
    }
}

/// `planMicroBatches`: shortest first, each pass within the padded token-slot budget.
pub fn plan_micro_batches(texts: &[String], max_seq: usize, budget: usize) -> Vec<Vec<usize>> {
    let est = |t: &String| max_seq.min(js_len(t) + 2);
    let mut order: Vec<usize> = (0..texts.len()).collect();
    order.sort_by_key(|&i| est(&texts[i]));
    let mut groups = vec![];
    let mut i = 0;
    while i < order.len() {
        let (mut padded, mut n) = (0, 0);
        while i + n < order.len() {
            let next = padded.max(est(&texts[order[i + n]]));
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

fn token_budget() -> usize {
    let raw = std::env::var("SCRYBE_LOCAL_EMBED_TOKEN_BUDGET").ok().and_then(|v| v.parse::<f64>().ok()).filter(|n| n.is_finite() && *n > 0.0);
    (raw.map(|n| n as usize).unwrap_or(4096)).max(MAX_SEQ_TOKENS)
}

/// `resolveModelCacheDir`.
pub fn models_dir() -> std::path::PathBuf {
    match std::env::var("SCRYBE_MODEL_CACHE_DIR") {
        Ok(v) if !v.trim().is_empty() => std::path::PathBuf::from(v),
        _ => data_dir().join("models"),
    }
}

/// `isLocalModelCached`: loaded in this process, or its `config.json` is on disk.
pub fn is_cached(model: &str) -> bool {
    if MODELS.get().is_some_and(|m| m.lock().unwrap().contains_key(model)) {
        return true;
    }
    models_dir().join(model).join("config.json").exists()
}

/// The files the feature-extraction pipeline fetches for a quantized model. `config.json` goes last, so
/// its presence (the cache check above) means the rest arrived too.
const MODEL_FILES: [&str; 4] = ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json", "config.json"];

fn model_remote_host() -> String {
    std::env::var("SCRYBE_MODEL_REMOTE_HOST").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "https://huggingface.co".into())
}

fn download_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    // HTTP/1.1, as today's build fetches: one HTTP/2 stream's flow-control window caps a long-distance
    // download at about a third of the line speed.
    CLIENT.get_or_init(|| reqwest::Client::builder().http1_only().connect_timeout(std::time::Duration::from_secs(30)).read_timeout(std::time::Duration::from_secs(120)).build().expect("HTTP client"))
}

/// Called with the download's whole percent (0 to 99) each time it changes.
pub type DownloadProgress = std::sync::Arc<dyn Fn(u8) + Send + Sync>;

/// Byte-weighted percent over every file seen so far, as the pipeline's progress callback computes it:
/// silent until the files seen add up to 1 MB, so a small file finishing first can't read as 100,
/// capped at 99 because the job's move to embedding is what says the download finished, and never lower
/// than the last reading.
struct Meter {
    files: Vec<(u64, u64)>,
    last: Option<u8>,
    report: Option<DownloadProgress>,
}

impl Meter {
    const MIN_REPORT_BYTES: u64 = 1_000_000;

    fn update(&mut self, file: usize, loaded: u64, total: u64) {
        if total == 0 {
            return;
        }
        if self.files.len() <= file {
            self.files.resize(file + 1, (0, 0));
        }
        self.files[file] = (loaded, total);
        let (sum_loaded, sum_total) = self.files.iter().fold((0, 0), |(l, t), (fl, ft)| (l + fl, t + ft));
        if sum_total < Self::MIN_REPORT_BYTES {
            return;
        }
        let percent = ((sum_loaded as f64 / sum_total as f64) * 100.0).round().min(99.0) as u8;
        // A file joining the total would pull the share down; hold the high point instead.
        let percent = self.last.map_or(percent, |last| last.max(percent));
        if self.last != Some(percent) {
            self.last = Some(percent);
            if let Some(report) = &self.report {
                report(percent);
            }
        }
    }
}

async fn download_file(url: &str, dest: &std::path::Path, meter: &mut Meter, index: usize) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut resp = download_client().get(url).send().await.map_err(|e| anyhow!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("fetch failed: {} returned {}", url, resp.status());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let total = resp.content_length().unwrap_or(0);
    let mut loaded = 0u64;
    meter.update(index, 0, total);
    let part = dest.with_extension(format!("{}.part", dest.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let mut file = tokio::fs::File::create(&part).await?;
    while let Some(bytes) = resp.chunk().await.map_err(|e| anyhow!("fetch failed: {e}"))? {
        file.write_all(&bytes).await?;
        loaded += bytes.len() as u64;
        meter.update(index, loaded, total);
    }
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

/// Times the download client: to `dest` through the model download path, or into memory.
pub async fn debug_fetch(url: &str, dest: Option<&std::path::Path>) -> Result<u64> {
    if let Some(dest) = dest {
        let mut meter = Meter { files: vec![], last: None, report: None };
        download_file(url, dest, &mut meter, 0).await?;
        return Ok(std::fs::metadata(dest)?.len());
    }
    let mut resp = download_client().get(url).send().await?.error_for_status()?;
    let host = resp.url().host_str().unwrap_or("").to_string();
    let addr = resp.remote_addr().map_or(String::new(), |a| a.to_string());
    eprintln!("fetching from {host} ({addr}), {:?}", resp.version());
    let mut n = 0u64;
    while let Some(bytes) = resp.chunk().await? {
        n += bytes.len() as u64;
    }
    Ok(n)
}

/// First-use download into the model cache, as the pipeline does on its first load. Only the index path
/// calls this; search fails fast instead.
pub async fn ensure_model(model: &str, progress: Option<DownloadProgress>) -> Result<()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _held = LOCK.lock().await;
    let dir = models_dir().join(model);
    let host = model_remote_host();
    let mut meter = Meter { files: vec![], last: None, report: progress };
    for (index, file) in MODEL_FILES.iter().enumerate() {
        let dest = dir.join(file);
        if dest.exists() {
            continue;
        }
        let url = format!("{}/{}/resolve/main/{}", host.trim_end_matches('/'), model, file);
        download_file(&url, &dest, &mut meter, index).await.map_err(|e| anyhow!("{}", classify_load_error(&format!("{e:#}"))))?;
    }
    Ok(())
}

/// `classifyLocalLoadError`.
fn classify_load_error(msg: &str) -> String {
    let network = ["ENOTFOUND", "getaddrinfo", "fetch", "network"].iter().any(|k| msg.contains(k));
    let cut = |n: usize| msg.char_indices().nth(n).map_or(msg, |(i, _)| &msg[..i]).to_string();
    if network {
        format!("Model not cached and no network available. Run once with internet access to download the model (~120 MB): {}", cut(120))
    } else {
        format!("Local embedder failed to load: {}", cut(200))
    }
}

/// `embedLocalBatched`.
pub async fn embed_passages(model: &str, prefix: &str, texts: Vec<String>, max_chars: usize, batch_size: usize, download: Option<DownloadProgress>) -> Result<Vec<Vec<f32>>> {
    ensure_model(model, download).await?;
    let (model, prefix) = (model.to_string(), prefix.to_string());
    tokio::task::spawn_blocking(move || {
        let e = embedder(&model).map_err(|e| anyhow!("{}", classify_load_error(&format!("{e:#}"))))?;
        let budget = token_budget();
        let mut results: Vec<Vec<f32>> = vec![vec![]; texts.len()];
        for (b, window) in texts.chunks(batch_size.max(1)).enumerate() {
            let batch: Vec<String> = window
                .iter()
                .map(|t| {
                    let capped = if js_len(t) > max_chars { js_slice(t, max_chars) } else { t.clone() };
                    format!("{prefix}{}", cap_text(&capped))
                })
                .collect();
            for group in plan_micro_batches(&batch, MAX_SEQ_TOKENS, budget) {
                let refs: Vec<&str> = group.iter().map(|&k| batch[k].as_str()).collect();
                let vectors = e.embed_group(&refs)?;
                for (k, v) in group.into_iter().zip(vectors) {
                    results[b * batch_size.max(1) + k] = v;
                }
            }
        }
        release_free_memory();
        Ok(results)
    })
    .await?
}

fn rss_line() -> String {
    let st = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |k: &str| st.lines().find(|l| l.starts_with(k)).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) / 1024;
    #[cfg(target_env = "gnu")]
    let inuse = {
        let m = unsafe { libc::mallinfo2() };
        format!(", malloc in use {} MB, mmapped {} MB", (m.uordblks + m.hblkhd) >> 20, m.hblkhd >> 20)
    };
    #[cfg(not(target_env = "gnu"))]
    let inuse = String::new();
    format!("rss {} MB (anon {} MB{inuse})", field("VmRSS:"), field("RssAnon:"))
}

pub fn debug_load_mem(model: &str) -> Result<()> {
    let dir = models_dir().join(model);
    println!("start: {}", rss_line());
    if std::env::var("SCRYBE_LOAD_MEM_PARTS").as_deref() == Ok("1") {
        let raw = std::fs::read_to_string(dir.join("tokenizer.json"))?;
        let mut v: serde_json::Value = serde_json::from_str(&raw)?;
        drop(raw);
        println!("json parsed: {}", rss_line());
        let model: tokenizers::ModelWrapper = serde_json::from_value(v["model"].take())?;
        release_free_memory();
        println!("model part built (json model dropped): {}", rss_line());
        let norm: Option<tokenizers::NormalizerWrapper> = serde_json::from_value(v["normalizer"].take())?;
        release_free_memory();
        println!("normalizer built: {}", rss_line());
        drop(v);
        release_free_memory();
        println!("rest of json dropped: {}", rss_line());
        drop(norm);
        release_free_memory();
        println!("normalizer dropped: {}", rss_line());
        drop(model);
        release_free_memory();
        println!("model part dropped: {}", rss_line());
    }
    let tokenizer = load_tokenizer(&dir.join("tokenizer.json"))?;
    println!("tokenizer loaded: {}", rss_line());
    release_free_memory();
    println!("tokenizer loaded, after trim: {}", rss_line());
    drop(tokenizer);
    release_free_memory();
    println!("tokenizer dropped, after trim: {}", rss_line());
    let e = Embedder::load(model)?;
    println!("model loaded: {}", rss_line());
    release_free_memory();
    println!("model loaded, after trim: {}", rss_line());
    let _ = e.embed_group(&["passage: hello world"])?;
    println!("after one embed: {}", rss_line());
    drop(e);
    release_free_memory();
    println!("model dropped, after trim: {}", rss_line());
    Ok(())
}

/// Hand heap pages that are free but still mapped back to the OS.
pub fn release_free_memory() {
    #[cfg(target_env = "gnu")]
    unsafe {
        libc::malloc_trim(0);
    }
}

static MODELS: OnceLock<Mutex<HashMap<String, Arc<Embedder>>>> = OnceLock::new();
static LAST_USE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Experiment: drop the model after this many idle seconds and hand memory back to the OS.
fn start_idle_unload() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    let Some(secs) = std::env::var("SCRYBE_EMBED_IDLE_SECS").ok().and_then(|v| v.parse::<u64>().ok()) else { return };
    STARTED.call_once(|| {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let idle = LAST_USE.lock().unwrap().is_some_and(|t| t.elapsed().as_secs() >= secs);
            if idle {
                if let Some(m) = MODELS.get() {
                    m.lock().unwrap().clear();
                }
                *LAST_USE.lock().unwrap() = None;
                #[cfg(target_env = "gnu")]
                unsafe {
                    libc::malloc_trim(0);
                }
            }
        });
    });
}

fn embedder(model: &str) -> Result<Arc<Embedder>> {
    start_idle_unload();
    *LAST_USE.lock().unwrap() = Some(std::time::Instant::now());
    let models = MODELS.get_or_init(Default::default);
    let mut guard = models.lock().unwrap();
    if let Some(e) = guard.get(model) {
        return Ok(e.clone());
    }
    let e = Arc::new(Embedder::load(model)?);
    // Loading leaves the tokenizer's parse buffers free but mapped.
    release_free_memory();
    guard.insert(model.to_string(), e.clone());
    Ok(e)
}

/// Mirrors `truncateForModel`: only ever cuts text the tokenizer would have dropped anyway.
fn cap_text(text: &str) -> &str {
    let budget = MAX_SEQ_TOKENS * MAX_CHARS_PER_TOKEN;
    if text.len() <= budget {
        return text;
    }
    let mut non_ws = 0;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            continue;
        }
        non_ws += 1;
        if non_ws > budget {
            return &text[..i];
        }
    }
    text
}

pub fn tokens(model: &str, text: &str) -> Result<Vec<u32>> {
    embedder(model)?.encode_ids(text)
}

/// `embedQuery`: the local model or the API, as the preset says.
pub async fn embed_query_for(cfg: &crate::registry::EmbedConfig, query: &str) -> Result<Vec<f32>> {
    if cfg.local {
        return embed_query(&cfg.model, &cfg.query_prefix, query).await;
    }
    let vectors = crate::embed_api::embed_texts(cfg, &[query.to_string()]).await.map_err(|e| anyhow::anyhow!("{}", e.message))?;
    vectors.into_iter().next().ok_or_else(|| anyhow::anyhow!("the embedding endpoint returned no vector"))
}

pub async fn embed_query(model: &str, prefix: &str, query: &str) -> Result<Vec<f32>> {
    if !is_cached(model) {
        anyhow::bail!(
            "LOCAL_MODEL_NOT_READY: Local embedding model \"{model}\" is not downloaded yet. Run an index first (scrybe index -P <project-id>) or use the MCP `init` tool to set up and download the model."
        );
    }
    let (model, text) = (model.to_string(), format!("{prefix}{}", cap_text(query)));
    tokio::task::spawn_blocking(move || embedder(&model)?.embed(&text)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_errors_read_as_todays() {
        assert!(classify_load_error("fetch failed: dns error").starts_with("Model not cached and no network available. Run once with internet access to download the model (~120 MB): fetch failed"));
        assert_eq!(classify_load_error("bad graph"), "Local embedder failed to load: bad graph");
        let long = "é".repeat(300);
        assert_eq!(classify_load_error(&long).chars().count(), "Local embedder failed to load: ".len() + 200);
    }

    #[test]
    fn download_percent_weighs_bytes_and_never_reads_100() {
        let seen = std::sync::Arc::new(Mutex::new(vec![]));
        let sink = seen.clone();
        let mut meter = Meter { files: vec![], last: None, report: Some(std::sync::Arc::new(move |p| sink.lock().unwrap().push(p))) };
        // A small file finishing first stays silent.
        meter.update(3, 500, 500);
        assert!(seen.lock().unwrap().is_empty());
        const MB: u64 = 1_000_000;
        for loaded in [0, 28 * MB, 28 * MB, 56 * MB, 113 * MB] {
            meter.update(0, loaded, 113 * MB);
        }
        // An unknown size never counts.
        meter.update(1, 10, 0);
        // A second file joining doesn't send it backwards.
        meter.update(2, 0, 17 * MB);
        meter.update(2, 17 * MB, 17 * MB);
        assert_eq!(*seen.lock().unwrap(), vec![0, 25, 50, 99]);
    }

    #[test]
    fn unigram_picks_the_best_scoring_split_through_the_compact_trie() {
        use tokenizers::models::unigram::Unigram;
        use tokenizers::Model;
        let vocab = [("<unk>", 0.0), ("a", -1.0), ("ab", -0.5), ("abc", -3.0), ("b", -1.0), ("c", -1.0), ("é", -1.0)];
        let model = Unigram::from(vocab.iter().map(|(t, s)| (t.to_string(), *s)).collect(), Some(0), false).unwrap();
        let split = |s: &str| model.tokenize(s).unwrap().into_iter().map(|t| t.value).collect::<Vec<_>>();
        assert_eq!(split("abc"), ["ab", "c"]);
        assert_eq!(split("abcab"), ["ab", "c", "ab"]);
        assert_eq!(split("ba"), ["b", "a"]);
        assert_eq!(split("éab"), ["é", "ab"]);
        assert_eq!(split("zab"), ["z", "ab"]);
    }

    #[test]
    fn config_json_is_fetched_last() {
        assert_eq!(MODEL_FILES.last(), Some(&"config.json"));
    }

    #[test]
    fn planner_keeps_passes_inside_the_budget_and_visits_short_first() {
        let texts: Vec<String> = [10usize, 500, 12, 600, 11].iter().map(|n| "x".repeat(*n)).collect();
        let groups = plan_micro_batches(&texts, 512, 1024);
        assert_eq!(groups, vec![vec![0, 4, 2], vec![1, 3]]);
        // A single row over budget still goes through.
        assert_eq!(plan_micro_batches(&texts[3..4].to_vec(), 512, 100), vec![vec![0]]);
    }
}
