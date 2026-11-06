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
        let dir = data_dir().join("models").join(model);
        let onnx = dir.join("onnx").join("model_quantized.onnx");
        if !onnx.exists() {
            anyhow::bail!("embedding model not found at {}: the read path does not download models", onnx.display());
        }
        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| anyhow!("tokenizer: {e}"))?;
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
        if std::env::var("SCRYBE_ORT_ARENA").as_deref() == Ok("0") {
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

/// `embedLocalBatched`.
pub async fn embed_passages(model: &str, prefix: &str, texts: Vec<String>, max_chars: usize, batch_size: usize) -> Result<Vec<Vec<f32>>> {
    let (model, prefix) = (model.to_string(), prefix.to_string());
    tokio::task::spawn_blocking(move || {
        let e = embedder(&model)?;
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
        Ok(results)
    })
    .await?
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

pub async fn embed_query(model: &str, prefix: &str, query: &str) -> Result<Vec<f32>> {
    let (model, text) = (model.to_string(), format!("{prefix}{}", cap_text(query)));
    tokio::task::spawn_blocking(move || embedder(&model)?.embed(&text)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planner_keeps_passes_inside_the_budget_and_visits_short_first() {
        let texts: Vec<String> = [10usize, 500, 12, 600, 11].iter().map(|n| "x".repeat(*n)).collect();
        let groups = plan_micro_batches(&texts, 512, 1024);
        assert_eq!(groups, vec![vec![0, 4, 2], vec![1, 3]]);
        // A single row over budget still goes through.
        assert_eq!(plan_micro_batches(&texts[3..4].to_vec(), 512, 100), vec![vec![0]]);
    }
}
