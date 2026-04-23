# Configuration Reference

All configuration is via environment variables. Set them in `.env` or in the MCP server's `env` block in `~/.claude.json`.

**Precedence (highest to lowest):**
1. Shell environment / MCP `env` block
2. `<DATA_DIR>/.env` file (written by `scrybe init`)
3. Provider defaults derived from `EMBEDDING_BASE_URL`
4. `OPENAI_API_KEY` fallback (triggers OpenAI defaults)
5. **Local offline embedder** — `Xenova/multilingual-e5-small` (384d) — when none of the above are set

---

## Local embedder (default)

When no `EMBEDDING_*` or `OPENAI_API_KEY` env vars are set, Scrybe uses an in-process WASM/ONNX model — no API key, no network call after first download.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_LOCAL_EMBEDDER` | `Xenova/multilingual-e5-small` | HuggingFace model ID for the local embedder. Set by `scrybe init`. Override to use a different ONNX-compatible model. |

The model is downloaded on first use (~120 MB) and cached in `~/.cache/huggingface/hub/`. Subsequent runs load from cache.

---

## Code embedding (API provider)

Used for all `code` sources when an API provider is configured.

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_API_KEY` | — | API key. Falls back to `OPENAI_API_KEY` if not set. |
| `EMBEDDING_BASE_URL` | — | Base URL for the embeddings endpoint. Set to switch providers. |
| `EMBEDDING_MODEL` | auto | Model name. Auto-set for known providers; required for unknown ones. |
| `EMBEDDING_DIMENSIONS` | auto | Vector dimensions. Auto-set for known providers; required for unknown ones. |
| `EMBED_BATCH_SIZE` | `100` | Chunks per embedding request. Reduce if hitting rate limits. |
| `EMBED_BATCH_DELAY_MS` | `0` | Delay in ms between batches. |

---

## Text / knowledge embedding

Used for `ticket` and other knowledge sources. Falls back to the code embedding settings if not set.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_TEXT_EMBEDDING_API_KEY` | `EMBEDDING_API_KEY` | API key for knowledge sources. |
| `SCRYBE_TEXT_EMBEDDING_BASE_URL` | `EMBEDDING_BASE_URL` | Base URL for knowledge source embeddings. |
| `SCRYBE_TEXT_EMBEDDING_MODEL` | `EMBEDDING_MODEL` | Model for knowledge source embeddings. |
| `SCRYBE_TEXT_EMBEDDING_DIMENSIONS` | `EMBEDDING_DIMENSIONS` | Dimensions for knowledge source embeddings. |

---

## Indexing behaviour

| Variable                       | Default | Description                                                                                                                                                          |
|--------------------------------|---------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `SCRYBE_SCAN_CONCURRENCY`      | `32`    | Parallel file hash workers during the scan phase. Increase on fast SSDs, decrease if hitting file-handle limits.                                                     |
| `SCRYBE_EMBED_RETRY_DELAY_MS`  | `5000`  | Initial retry delay (ms) when the embedding API returns a 429. Doubles on each subsequent attempt (up to 5 total). Set to a lower value in test environments.        |

### `.scrybeignore`

Place a `.scrybeignore` file in a repo's root directory to control which files are indexed. Uses the same syntax as `.gitignore`.

**Behaviour:**
- Patterns are additive excludes on top of `.gitignore` — exclude files that git tracks but you don't want indexed
- Negation patterns (`!path`) override both `.gitignore` and Scrybe's hardcoded skip lists (`node_modules/`, `dist/`, lock files, etc.)
- If no `.scrybeignore` exists, behaviour is unchanged

**Example `.scrybeignore`:**
```gitignore
# Don't index test fixtures
tests/fixtures/
*.generated.ts

# But DO index this gitignored build output
!dist/api-types.d.ts

# Index a specific package from node_modules (yes, really)
!node_modules/my-local-pkg/
```

---

## Hybrid search

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_HYBRID` | `true` | Set to `false` to use vector-only search (no BM25). |
| `SCRYBE_RRF_K` | `60` | RRF rank-sensitivity constant. Higher = less sensitive to rank position. |

---

## Reranking

Optional post-retrieval re-scoring. Requires a reranking-capable provider (e.g. Voyage AI `rerank-2.5`).

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_RERANK` | `false` | Set to `true` to enable reranking. |
| `SCRYBE_RERANK_MODEL` | `rerank-2.5` | Reranker model. Auto-detected for Voyage AI. |
| `SCRYBE_RERANK_BASE_URL` | — | Reranker endpoint for non-Voyage providers. |
| `SCRYBE_RERANK_API_KEY` | `EMBEDDING_API_KEY` | API key for reranking. |
| `SCRYBE_RERANK_FETCH_MULTIPLIER` | `5` | Candidate pool = `top_k × multiplier` before reranking. |

When using Voyage AI, set only `SCRYBE_RERANK=true` — endpoint and model are auto-detected from `EMBEDDING_BASE_URL`.

---

## Known providers

| Provider | How to select | Default model | Dimensions | Reranking |
|----------|---------------|---------------|------------|-----------|
| **Local (offline)** | No env vars set (default) | `Xenova/multilingual-e5-small` | 384 | — |
| OpenAI | `EMBEDDING_BASE_URL=https://api.openai.com/v1` | `text-embedding-3-small` | 1536 | — |
| Voyage AI | `EMBEDDING_BASE_URL=https://api.voyageai.com/v1` | `voyage-code-3` (code) / `voyage-4` (text) | 1024 | `rerank-2.5` |
| Mistral | `EMBEDDING_BASE_URL=https://api.mistral.ai/v1` | `mistral-embed` | 1024 | — |

For unknown providers, set `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` explicitly.

**Switching providers:** changing model or dimensions invalidates all existing indexed data. Scrybe detects this and returns a `dimensions_mismatch` error until you run a full reindex of every project.

**Development tip:** keep all provider configs in `.env` as commented blocks and uncomment the active one — no MCP restart needed for CLI testing.
