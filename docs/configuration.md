# Configuration Reference

All configuration is via environment variables. Set them in `.env` or in the MCP server's `env` block in `~/.claude.json`.

**Precedence (highest to lowest):**
1. Shell environment / MCP `env` block
2. `<DATA_DIR>/.env` file (written by `scrybe init`)
3. Provider defaults derived from `EMBEDDING_BASE_URL`
4. `OPENAI_API_KEY` fallback (triggers OpenAI defaults)
5. **Local offline embedder** — `Xenova/multilingual-e5-small` (384d) — when none of the above are set

---

## Storage location

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_DATA_DIR` | OS-specific (see below) | Override the directory where Scrybe stores all state: `projects.json`, LanceDB tables, daemon socket, `.env`, jobs DB, ignores. |

**Default per platform:**
- Windows: `%LOCALAPPDATA%\scrybe\scrybe`
- macOS: `~/Library/Application Support/scrybe`
- Linux: `~/.local/share/scrybe` (or `$XDG_DATA_HOME/scrybe`)

Set this before running any `scrybe` command if you want to relocate state (e.g. point at a faster SSD). All processes — CLI, daemon, MCP server — must agree on the same value.

---

## Chunking

Controls how source files are split into chunks before embedding. Defaults are tuned for code; raise for prose-heavy sources only after measuring recall.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_CHUNK_SIZE` | `60` | Maximum lines per chunk. |
| `SCRYBE_CHUNK_OVERLAP` | `10` | Lines of overlap between adjacent chunks. Must be `<` `SCRYBE_CHUNK_SIZE` — startup fails otherwise. |

Changes apply on the next reindex; existing chunks keep their original boundaries until rewritten.

---

## Local embedder (default)

When no `EMBEDDING_*` or `OPENAI_API_KEY` env vars are set, Scrybe uses an in-process WASM/ONNX model — no API key, no network call after first download.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_LOCAL_EMBEDDER` | `Xenova/multilingual-e5-small` | HuggingFace model ID for the local embedder. Set by `scrybe init`. Override to use a different ONNX-compatible model. |
| `SCRYBE_MODEL_CACHE_DIR` | `${DATA_DIR}/models` | Where local model weights (embedder + reranker) are stored. Override to relocate or share the cache (e.g. across CI runs). |

The model is downloaded on first use (~120 MB) and cached under `${DATA_DIR}/models/` (overridable via `SCRYBE_MODEL_CACHE_DIR`). Weights survive reinstalls and npx cache wipes; subsequent runs load from cache.

---

## Code embedding (API provider)

Used for all `code` sources when an API provider is configured.

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_API_KEY` | — | API key. Falls back to `OPENAI_API_KEY` if not set. |
| `EMBEDDING_BASE_URL` | — | Base URL for the embeddings endpoint. Set to switch providers. |
| `EMBEDDING_MODEL` | auto | Model name. Auto-set for known providers; required for unknown ones. |
| `EMBEDDING_DIMENSIONS` | auto | Vector dimensions. Auto-set for known providers; required for unknown ones. |
| `EMBED_BATCH_SIZE` | `100` | Initial ceiling for chunks per embedding request. Scrybe auto-tunes the actual batch size per codebase and provider — you don't need to adjust this for normal use. |
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

Optional post-retrieval re-scoring. Use a reranking-capable HTTP provider (e.g. Voyage AI `rerank-2.5`) or the in-process local cross-encoder.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_RERANK` | `false` | Set to `true` to enable reranking. |
| `SCRYBE_RERANK_PROVIDER` | `http` | `http` (Voyage / custom endpoint) or `local` (in-process cross-encoder, no API key). |
| `SCRYBE_RERANK_MODEL` | `rerank-2.5` / `Xenova/ms-marco-MiniLM-L-6-v2` | Reranker model. Default depends on provider; auto-detected for Voyage AI. |
| `SCRYBE_RERANK_BASE_URL` | — | Reranker endpoint for non-Voyage HTTP providers. |
| `SCRYBE_RERANK_API_KEY` | `EMBEDDING_API_KEY` | API key for HTTP reranking (not needed for `local`). |
| `SCRYBE_RERANK_FETCH_MULTIPLIER` | `5` | Candidate pool = `top_k × multiplier` before reranking. |
| `SCRYBE_RERANK_BLEND_TOP3` | `0.75,0.25` | Retrieval,rerank weight blend for results at original rank ≤ 3. |
| `SCRYBE_RERANK_BLEND_TAIL` | `0.40,0.60` | Retrieval,rerank weight blend for results at original rank ≥ 11. |

When using Voyage AI, set only `SCRYBE_RERANK=true` — endpoint and model are auto-detected from `EMBEDDING_BASE_URL`. For a free, no-API-key option on any provider, set `SCRYBE_RERANK=true` and `SCRYBE_RERANK_PROVIDER=local` (downloads `Xenova/ms-marco-MiniLM-L-6-v2`, ~22 MB, on first use). Position-aware blending weights the first-stage rank against the reranker score, interpolating between the top-3 and tail weights above.

---

## Ticket source authentication

Tokens for ticket sources (GitLab, GitHub, etc.) can be stored as environment variables and referenced at fetch time using the `${VAR}` syntax. Recommended naming convention:

| Token type | Recommended env var | Example |
|----------|----------|---------|
| GitLab personal access token | `SCRYBE_GITLAB_TOKEN` | `scrybe source add --token '${SCRYBE_GITLAB_TOKEN}'` |
| GitHub personal access token | `SCRYBE_GITHUB_TOKEN` | `scrybe source add --token '${SCRYBE_GITHUB_TOKEN}'` |

Any environment variable name works (`GITLAB_PAT`, `GH_TOKEN`, etc.); these are just conventions. The variable is resolved at index/validate time, not at configuration time. Unset variables fail fast with an actionable error message naming the variable.

Literal tokens also work but trigger a one-time daemon-start warning — using env vars is recommended.

---

## Daemon lifecycle

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_NO_AUTO_DAEMON` | unset | Set to `1` to disable the MCP server's automatic daemon spawn. Useful if you manage the daemon manually or via a process supervisor. When set, run `scrybe daemon start` yourself. |
| `SCRYBE_DAEMON_KEEP_ALIVE` | unset | Set to `1` to disable the grace and no-client-ever shutdown timers. The daemon stays running until manually stopped or the system shuts down. This is set automatically by OS-level autostart entries (always-on mode). |
| `SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS` | `1800000` | Maximum time (ms, default 30min) a graceful shutdown waits for an in-flight reindex to finish before force-exiting. The idle shutdown timers also defer while a reindex is active, so a long index started from the CLI is no longer killed mid-job. |
| `SCRYBE_DEBUG_INDEXER` | unset | Set to `1` to emit per-batch embedding and write events (`indexer.embed.batch`, `indexer.write.completed`) to `daemon-log.jsonl`. Use when diagnosing chunk dedup or silent re-embed issues. Scan and job-summary events are always logged regardless of this flag. |
| `SCRYBE_MCP_COLD_START_WAIT_MS` | `15000` | How long the MCP shim waits for the daemon to become reachable at startup before falling back to the 1-tool placeholder. Set to `0` to disable the wait. Useful when MCP clients launch the shim before the daemon is up (e.g. cold-boot, slow Windows binding loads). |

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
