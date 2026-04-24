# scrybe

**No API key required. Works fully offline.**

Self-hosted code memory with semantic search. Index your repos and knowledge sources into a local vector database and search them by natural language — from the CLI or directly inside Claude Code via MCP.

A local WASM/ONNX embedder (`Xenova/multilingual-e5-small`, ~120 MB download on first run) is the default provider. To use Voyage AI, OpenAI, or a custom endpoint instead, run `scrybe init` and choose "Use an external provider".

## Why scrybe?

Ask your agent a natural-language question. scrybe returns the right chunks; Grep can't.

**Example** — real session in this repo:

> "How does incremental reindex decide which files changed?"

scrybe returns `src/indexer.ts:100-159` at score 0.81 — the exact function body that computes `toRemove` and `toReindex` from the cursor + `oldHashes` diff.

For contrast: `grep "incremental"` returns 34 hits across type declarations, CLI option strings, and tests. `grep "files changed"` returns 0 — the phrase doesn't appear in the code; only the *concept* does. Semantic search bridges that gap.

## How it works

```
Claude Code (any project)
    ↕ MCP stdio
src/mcp-server.ts
    ↕
LanceDB (embedded, in-process)
    ├── code_{hash}     ← per-source code tables (search_code)
    └── knowledge_{hash} ← per-source knowledge tables (search_knowledge)
```

No Docker. LanceDB runs in-process. All data lives in the OS user data directory:

- **Windows:** `%LOCALAPPDATA%\scrybe\scrybe\`
- **Linux:** `~/.local/share/scrybe/`
- **Mac:** `~/Library/Application Support/scrybe/`

> **Platform support:** Windows and Linux are tested in CI on every commit. macOS support is best-effort — it runs in CI but has not yet been validated by macOS users in production. If you hit a macOS-specific issue, please [open an issue](https://github.com/siaarzh/scrybe/issues/new/choose).

## Code chunking

Code files are chunked using Tree-sitter AST parsing, which aligns chunk boundaries with actual function, class, and method definitions. This significantly improves retrieval precision compared to arbitrary sliding-window splits.

**Supported languages (AST chunking):** TypeScript, TSX, JavaScript, JSX, C#, Vue, Python, Go, Ruby, Rust, Java

**Fallback:** unsupported languages and parse failures fall back to sliding-window chunking — no regression on existing indexed repos.

Each code chunk includes a `symbol_name` field (the enclosing function or class name) surfaced in search results.

## Knowledge sources

Scrybe can index non-code sources (GitLab issues, and future: webpages, Telegram) into a separate `knowledge_chunks` table and expose them via `search_knowledge`.

### Separate text embedding profile

Knowledge sources use natural language text rather than code, so a different embedding model is often better (e.g. `voyage-3` for multilingual issue text vs. `voyage-code-3` for code). Configure via:

| Variable | Default | Description |
| --- | --- | --- |
| `SCRYBE_TEXT_EMBEDDING_BASE_URL` | — | Falls back to `EMBEDDING_BASE_URL`. |
| `SCRYBE_TEXT_EMBEDDING_MODEL` | — | Falls back to `EMBEDDING_MODEL`. |
| `SCRYBE_TEXT_EMBEDDING_API_KEY` | — | Falls back to `EMBEDDING_API_KEY`. |
| `SCRYBE_TEXT_EMBEDDING_DIMENSIONS` | — | Falls back to `EMBEDDING_DIMENSIONS`. |

### GitLab issues

Add a GitLab issues source to any project:

```bash
scrybe add-source \
  --project-id myrepo \
  --source-id gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...

scrybe index --project-id myrepo --source-id gitlab-issues --full
```

Indexing is cursor-based and incremental — only issues updated since the last run are fetched. Rate-limit safe (50 ms between issues).

To rotate a token, remove and re-add the source:

```bash
scrybe remove-source --project-id myrepo --source-id gitlab-issues
scrybe add-source --project-id myrepo --source-id gitlab-issues \
  --type ticket --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 --gitlab-token glpat-new-token
```

## Requirements

- Node.js 20+
- An embedding API key (OpenAI by default; see [Embedding providers](#embedding-providers) for alternatives)

## Setup

### Quick start (recommended)

```bash
npx scrybe-cli init
```

The wizard handles everything: picks an embedding provider, validates your API key, discovers repos, generates `.scrybeignore` files, and auto-registers the MCP server in `~/.claude.json` and `~/.cursor/mcp.json`. Under 90 seconds to first search hit.

### Manual setup

```bash
# 1. Install globally
npm install -g scrybe-cli

# 2. Register a project
scrybe add-project --id myrepo --desc "My project"
scrybe add-source --project-id myrepo --source-id primary \
  --type code --root /path/to/repo --languages ts,vue

# 3. Configure credentials (one-time)
#    Create/edit DATA_DIR/.env (printed by `scrybe doctor`)
EMBEDDING_BASE_URL=https://api.voyageai.com/v1
EMBEDDING_API_KEY=your-key-here

# 4. Index
scrybe index --project-id myrepo --incremental

# 5. Register MCP (add to ~/.claude.json manually or use `scrybe init`)
```

### Diagnose issues

```bash
scrybe doctor          # check config, auth, indexes, MCP
scrybe doctor --json   # machine-readable output
```

## Embedding providers

Scrybe uses an OpenAI-compatible embeddings API. The following env vars control which provider is used:

| Variable | Default | Description |
| --- | --- | --- |
| `EMBEDDING_API_KEY` | — | Embedding API key. Falls back to `OPENAI_API_KEY` if not set. |
| `EMBEDDING_BASE_URL` | OpenAI | Base URL for the embeddings endpoint. Set to switch providers. |
| `EMBEDDING_MODEL` | auto | Model name. Auto-set for known providers; required for unknown ones. |
| `EMBEDDING_DIMENSIONS` | auto | Vector dimensions. Auto-set for known providers; required for unknown ones. |
| `EMBED_BATCH_SIZE` | `100` | Chunks per embedding request. Reduce if hitting rate limits. |
| `EMBED_BATCH_DELAY_MS` | `0` | Delay in ms between batches. Useful for strict rate-limit tiers. |

**Known providers** (model and dimensions are set automatically when `EMBEDDING_BASE_URL` matches):
OpenAI (`api.openai.com`), Voyage AI (`api.voyageai.com`), Mistral (`api.mistral.ai`).

**Unknown providers:** if `EMBEDDING_BASE_URL` points to an unlisted provider and `EMBEDDING_MODEL` is not set, scrybe returns an error pointing you to `{base_url}/models` to discover available models.

**Precedence** (highest to lowest):

1. Shell environment / MCP config `env` block
2. `.env` file (only applied if the key is not already set)
3. Provider defaults derived from `EMBEDDING_BASE_URL` hostname
4. Built-in fallbacks: `OPENAI_API_KEY` for the key, `text-embedding-3-small` / `1536` if no provider matched

Within explicit vars: `EMBEDDING_API_KEY` beats `OPENAI_API_KEY`; explicit `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` beat provider defaults.

**Development tip:** keep all provider configs in `.env` and comment/uncomment the active block to switch providers — no MCP restart needed for CLI testing.

**Switching providers:** changing the model or dimensions makes all existing indexed data incompatible. Scrybe detects this automatically — `search_code` and incremental reindexes return an error with instructions until you run `reindex_project` with `mode="full"` for every registered project.

### Example: Voyage AI (voyage-code-3)

Code-optimized, free for the first 200M tokens. Requires adding a payment method to unlock standard rate limits (3 RPM without one).

```env
EMBEDDING_API_KEY=pa-...
EMBEDDING_BASE_URL=https://api.voyageai.com/v1
```

Model and dimensions are set automatically. To override:

```env
EMBEDDING_MODEL=voyage-code-3
EMBEDDING_DIMENSIONS=1024
```

## Hybrid search

Scrybe runs BM25 full-text search alongside vector search and merges results with Reciprocal Rank Fusion (RRF). This improves recall for exact identifiers and keyword queries.

| Variable | Default | Description |
| --- | --- | --- |
| `SCRYBE_HYBRID` | `true` | Set to `false` to revert to vector-only search. |
| `SCRYBE_RRF_K` | `60` | RRF rank-sensitivity constant. Higher = less sensitive to rank position. |

## Reranking

Optional post-retrieval re-scoring that improves result relevance. Requires a reranking-capable provider (e.g. Voyage AI `rerank-2.5`).

| Variable | Default | Description |
| --- | --- | --- |
| `SCRYBE_RERANK` | `false` | Set to `true` to enable reranking. |
| `SCRYBE_RERANK_MODEL` | `rerank-2.5` | Reranker model. Auto-detected when using Voyage. |
| `SCRYBE_RERANK_BASE_URL` | — | Reranker endpoint for non-Voyage providers. |
| `SCRYBE_RERANK_API_KEY` | — | Falls back to `EMBEDDING_API_KEY` if not set. |
| `SCRYBE_RERANK_FETCH_MULTIPLIER` | `5` | Candidate pool = `topK × multiplier` before reranking. |

When using Voyage AI, just set `SCRYBE_RERANK=true` — the endpoint and model are auto-detected from `EMBEDDING_BASE_URL`.

## CLI

Projects are containers; sources are the actual indexable units (a code repo, GitLab issues, etc.).

```bash
# Create a project
scrybe add-project --id myrepo --desc "My frontend"

# Add a code source
scrybe add-source --project-id myrepo --source-id code \
  --type code --root /path/to/repo --languages ts,vue

# Add a GitLab issues source
scrybe add-source --project-id myrepo --source-id gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...

# Index all sources in a project (full rebuild)
scrybe index --project-id myrepo --full

# Index a specific source incrementally
scrybe index --project-id myrepo --source-id code --incremental

# Search code / knowledge
scrybe search --project-id myrepo "authentication login flow"
scrybe search-knowledge --project-id myrepo "password reset broken"

# List projects and their sources
scrybe list-projects

# Show project info
scrybe status --project-id myrepo

# Remove a source or a whole project
scrybe remove-source --project-id myrepo --source-id gitlab-issues
scrybe remove-project --id myrepo
```

See [docs/cli-reference.md](docs/cli-reference.md) for the full command reference.

## Running as a background service

Scrybe can run as a persistent daemon that keeps every project's index fresh automatically — no manual `scrybe index` required after the first full index.

```bash
# Start the daemon (indexes registered projects in background)
scrybe daemon start

# Watch live status in the terminal
scrybe daemon status --watch

# Install as a per-user autostart (Windows / macOS / Linux — no admin needed)
scrybe daemon install

# Opt-in git hooks: git commit/checkout/merge → instant reindex via /kick
scrybe hook install --project-id myrepo

# Pin branches for background indexing beyond current HEAD
scrybe pin add --project-id cmx-ionic main dev dev-2 dev-3 beta
scrybe pin list --project-id cmx-ionic
```

The daemon exposes a local HTTP API on `127.0.0.1:58451` (ephemeral fallback if busy). Port is persisted in `<DATA_DIR>/daemon.pid` so all clients — CLI, MCP server, VS Code extension — discover it automatically.

See [docs/daemon.md](docs/daemon.md) for the full architecture, HTTP API reference, pinned-branch details, and troubleshooting guide.

## MCP server (Claude Code integration)

Add to `~/.claude.json` under `mcpServers`:

```json
"scrybe": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/scrybe/dist/index.js", "mcp"],
  "env": {
    "OPENAI_API_KEY": "sk-..."
  }
}
```

Replace `/absolute/path/to/scrybe` with the absolute path to your clone. `OPENAI_API_KEY` can be omitted if it's already set in `.env`.

### Available tools

| Tool | Description |
| --- | --- |
| `list_projects` | List all registered projects and their sources |
| `add_project` | Register a new project container |
| `update_project` | Update a project's description |
| `remove_project` | Remove a project and all its source tables |
| `add_source` | Add a source to a project (code repo, GitLab issues, etc.) |
| `remove_source` | Remove a source and drop its vector table |
| `search_code` | Semantic search over indexed code |
| `search_knowledge` | Semantic search over indexed knowledge sources (issues, docs) |
| `reindex_project` | Trigger background reindex of all sources (`full` or `incremental`) |
| `reindex_source` | Trigger background reindex of a single source |
| `reindex_status` | Poll a background reindex job |
| `cancel_reindex` | Cancel a running reindex job |

See [docs/mcp-reference.md](docs/mcp-reference.md) for full parameter documentation.

## Documentation

Detailed reference docs live in [`docs/`](docs/):

| Doc | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Full setup walkthrough, first project, MCP config |
| [CLI reference](docs/cli-reference.md) | All commands and flags |
| [MCP reference](docs/mcp-reference.md) | All tools, parameters, return values, error types |
| [Configuration](docs/configuration.md) | All env vars by category |
| [Daemon](docs/daemon.md) | Background daemon, HTTP API, pinned branches, autostart |

## Indexing time

Full indexing time depends on project size, average file length, and your embedding provider's rate limits. Rough estimates measured with **Voyage AI `voyage-code-3`** (free tier, standard rate limits):

| Project size | Example | Files | Chunks | Estimated time |
| --- | --- | --- | --- | --- |
| Small | scripts, single package | < 500 | < 3k | < 5 min |
| Medium | typical frontend | ~1,700 | ~10k | ~15 min |
| Large | full backend | ~6,000 | ~25k | ~75 min |

**Throughput** is roughly **~600 chunks/min** on Voyage AI's free tier. Paid tiers or providers with higher rate limits will index significantly faster.

**Language affects chunk count** — languages with larger files (e.g. generated code, `.json`, migrations) produce more chunks per file and take longer per file scanned.

**Incremental reindex** (after the initial full index) only processes changed files, so day-to-day re-syncing is fast regardless of project size.

If you hit rate limits during indexing, tune `EMBED_BATCH_SIZE` and `EMBED_BATCH_DELAY_MS` in your `.env`.

## Known limitations

- **HTML / CSS / SCSS** use sliding-window chunking. Tree-sitter grammars exist for them but these languages have no function/class declarations, so chunk boundaries are arbitrary rather than semantic. Particularly noticeable for large single-page static sites.
- **Kotlin, PHP, Swift** fall back to sliding-window. Tree-sitter grammar packages exist but aren't wired up yet (easy to add when needed).

## Contributing

See [docs/contributing.md](docs/contributing.md) for how to run tests locally and add new tests.
