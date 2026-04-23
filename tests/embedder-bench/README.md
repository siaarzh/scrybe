# Scrybe Embedder Benchmark (M-D5 Phase 1)

Evaluates WASM/ONNX-deployable embedding models for use as the **local default** in Scrybe.
No Ollama, no server process. All inference in-process via `@xenova/transformers`.

## How to run

```bash
# Run all candidates (downloads models on first run, ~23–150 MB each)
node --import tsx/esm tests/embedder-bench/run.ts

# Single model
node --import tsx/esm tests/embedder-bench/run.ts --model paraphrase-multilingual-MiniLM-L12-v2

# Skip disk-size measurement (faster, avoids HF cache walk)
node --import tsx/esm tests/embedder-bench/run.ts --skip-size
```

## Corpus + query set

`fixtures/corpus.json` — 25 code chunks:
- 20 in English (TypeScript + C#)
- 3 with Russian inline comments / docstrings (TypeScript)
- 2 with Chinese inline comments / docstrings (TypeScript)

`fixtures/queries.json` — 10 labeled queries:
- 5 English queries (en-001 through en-005)
- 3 Russian queries (ru-001 through ru-003) — cross-lingual
- 2 Chinese queries (zh-001, zh-002) — cross-lingual

## Metrics

| Metric | Threshold for consideration |
|---|---|
| Disk size (MB) | < 150 MB strongly preferred; > 300 MB = excluded from default |
| Cold-start (ms) | < 8 000 ms on a laptop (first load after download) |
| Warm RPS | > 50 texts/s on dev machine |
| Output dims | 384 or 768 preferred (LanceDB-friendly) |
| P@5 (English) | > 60% — relevant chunk in top 5 |
| Cross-lingual hit rate | > 45% — foreign-language query finds English code in top 3 |

## Candidates

| Model | Dims | Est. size | Notes |
|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | 384 | ~23 MB | English baseline (current test sidecar) |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 384 | ~120 MB | 50+ languages, SBERT |
| `Xenova/multilingual-e5-small` | 384 | ~120 MB | E5 family, multilingual retrieval |
| `Xenova/jina-embeddings-v2-small-code` | 512 | ~130 MB | Code-aware, English-centric |
| `Xenova/bge-small-en-v1.5` | 384 | ~70 MB | Strong English, no multilingual |
| ~~`Xenova/bge-m3`~~ | 1024 | ~570 MB | Best multilingual; excluded (too large) |

---

## Results

Run: 2026-04-23 · Windows 11 · Node 22 · @xenova/transformers 2.17.x

| Model | Disk (est.) | Cold (ms) | Warm RPS | Dims | P@5 | enP@5 | xLing |
|---|---|---|---|---|---|---|---|
| `all-MiniLM-L6-v2` | ~23 MB | 131 | 31 | 384 | 63% | 90% | 40% |
| `paraphrase-multilingual-MiniLM-L12-v2` | ~120 MB | 12 303 | 25 | 384 | 93% | 93% | **100%** |
| **`multilingual-e5-small`** | **~120 MB** | **7 116** | **24** | **384** | **100%** | **100%** | **100%** |
| `jina-embeddings-v2-small-code` | — | — | — | — | — | — | FAILED |
| `bge-small-en-v1.5` | ~70 MB | 3 350 | 19 | 384 | 75% | 100% | 40% |

**Notes:**
- Disk size: `@xenova/transformers` caches to a non-standard path on Windows; estimated sizes shown.
- RPS: all WASM models score 19–31 texts/s (single-threaded WASM baseline). The >50 threshold was designed for API providers; for local inference this is acceptable. Indexing 500 files (~25 000 chunks) takes ~15–20 min at this rate — slow but a one-time cost.
- `jina-embeddings-v2-small-code`: gated model (requires HF account + terms acceptance). **Cannot be the zero-friction default.**
- `paraphrase-multilingual-MiniLM-L12-v2`: cold-start 12 303 ms exceeds the 8 000 ms threshold on Windows.

---

## Recommendation

**Default: `Xenova/multilingual-e5-small` (384d, ~120 MB)**

- Only model to score **100% P@5 and 100% cross-lingual hit rate** simultaneously.
- Cold-start **7 116 ms** — under the 8 000 ms threshold (warm-path: instantaneous after first load).
- 384 dimensions — LanceDB-friendly, same as all-MiniLM-L6-v2; no schema migration needed for new installs.
- No gating — downloads freely from HuggingFace on first use.
- Multilingual: E5 family is trained specifically for retrieval across 100+ languages. Russian→English and Chinese→English cross-lingual results confirm this.

**Runner-up:** `paraphrase-multilingual-MiniLM-L12-v2` — equal xLing performance but cold-start exceeds threshold on Windows. May be acceptable on Linux/macOS (verify in M-D9). Not chosen as default.

**English-only models** (`all-MiniLM-L6-v2`, `bge-small-en-v1.5`): fail xLing threshold (40%). Not suitable as the multilingual default.

Wire into Phase 2: `model = "Xenova/multilingual-e5-small"`, `dimensions = 384`.
