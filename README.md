# scrybe

[![npm version](https://img.shields.io/npm/v/scrybe-cli)](https://www.npmjs.com/package/scrybe-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Known Vulnerabilities](https://snyk.io/test/github/siaarzh/scrybe/badge.svg)](https://snyk.io/test/github/siaarzh/scrybe)

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
scrybe mcp-server
    ↕
LanceDB (embedded, in-process)
    ├── code_{hash}     ← per-source code tables (search_code)
    └── knowledge_{hash} ← per-source knowledge tables (search_knowledge)
```

No Docker. LanceDB runs in-process. All data lives in the OS user data directory:

- **Windows:** `%LOCALAPPDATA%\scrybe\scrybe\`
- **Linux:** `~/.local/share/scrybe/`
- **Mac:** `~/Library/Application Support/scrybe/`

> **Platform support:** Windows, Linux, and macOS are all tested in CI on every commit (matrix: `ubuntu-latest`, `windows-latest`, `macos-latest`). All three platforms are fully supported.

## Code chunking

Code files are chunked using Tree-sitter AST parsing, which aligns chunk boundaries with actual function, class, and method definitions. This significantly improves retrieval precision compared to arbitrary sliding-window splits.

**Supported languages (AST chunking):** TypeScript, TSX, JavaScript, JSX, C#, Vue, Python, Go, Ruby, Rust, Java

**Fallback:** unsupported languages and parse failures fall back to sliding-window chunking — no regression on existing indexed repos.

Each code chunk includes a `symbol_name` field (the enclosing function or class name) surfaced in search results.

## Knowledge sources

Scrybe can index non-code sources (GitLab issues, and future: webpages, Telegram) into a separate `knowledge_chunks` table and expose them via `search_knowledge`.

### Separate text embedding profile

Knowledge sources can use a separate embedding model — configure via `SCRYBE_KNOWLEDGE_EMBEDDING_*` vars. See [docs/configuration.md](docs/configuration.md).

### GitLab issues

Add a GitLab issues source to any project:

```bash
scrybe source add -P myrepo -S gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...

scrybe index -P myrepo -S gitlab-issues --full
```

Indexing is cursor-based and incremental — only issues updated since the last run are fetched. Rate-limit safe (50 ms between issues).

To rotate a token, remove and re-add the source:

```bash
scrybe source remove -P myrepo -S gitlab-issues
scrybe source add -P myrepo -S gitlab-issues \
  --type ticket --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 --gitlab-token glpat-new-token
```

## Requirements

- Node.js 22.5+

## Setup

### Quick start (recommended)

```bash
npx scrybe-cli@latest init
```

The wizard handles everything: picks an embedding provider, validates your API key, discovers repos, generates `.scrybeignore` files, and auto-registers the MCP server in `~/.claude.json` and `~/.cursor/mcp.json`.

### Manual setup

```bash
# 1. Install globally
npm install -g scrybe-cli

# 2. Register a project
scrybe project add --id myrepo --desc "My project"
scrybe source add -P myrepo -S primary \
  --type code --root /path/to/repo --languages ts,vue

# 3. Configure credentials (one-time)
#    Create/edit DATA_DIR/.env (printed by `scrybe doctor`)
SCRYBE_CODE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1
SCRYBE_CODE_EMBEDDING_API_KEY=your-key-here

# 4. Index
scrybe index -P myrepo -I

# 5. Register MCP (add to ~/.claude.json manually or use `scrybe init`)
```

### Diagnose issues

```bash
scrybe doctor          # check config, auth, indexes, MCP
scrybe doctor --json   # machine-readable output
```

## MCP server (Claude Code integration)

The recommended setup uses `npx` — no global install needed:

```json
"scrybe": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "scrybe-cli@latest", "mcp"]
}
```

Add to `~/.claude.json` under `mcpServers`. Credentials go in `<DATA_DIR>/.env` (shown by `scrybe doctor`).

If you installed globally (`npm install -g scrybe-cli`):

```json
"scrybe": {
  "type": "stdio",
  "command": "scrybe",
  "args": ["mcp"]
}
```

### Available tools

| Tool | Description |
| --- | --- |
| `list_projects` | List all registered projects and their sources |
| `add_project` | Register a new project container |
| `update_project` | Update a project's description |
| `remove_project` | Unregister a project and drop all its source tables |
| `add_source` | Add an indexable source to a project (code repo, GitLab issues, etc.) |
| `update_source` | Update an existing source's config (token rotation, root path, languages) |
| `remove_source` | Remove a source and drop its vector table |
| `search_code` | Semantic search over indexed code |
| `search_knowledge` | Semantic search over indexed knowledge sources (issues, docs) |
| `reindex_all` | Incrementally reindex all registered projects in the background |
| `reindex_project` | Trigger background reindex of all sources in a project |
| `reindex_source` | Trigger background reindex of a single source |
| `reindex_status` | Poll a background reindex job |
| `cancel_reindex` | Cancel a running reindex job |
| `list_jobs` | List background reindex jobs and their status |
| `queue_status` | Check what is currently running or queued in the reindex queue |
| `gc` | Run garbage collection: remove orphan chunks and compact LanceDB tables |
| `list_branches` | List branches indexed for a project's sources |
| `list_pinned_branches` | List branches pinned for background daemon indexing |
| `pin_branches` | Add or replace pinned branches on a code source |
| `unpin_branches` | Remove branches from the pinned list |
| `set_private_ignore` | Set or clear private ignore rules for a code source |
| `get_private_ignore` | Get the current private ignore rules for a source |
| `list_private_ignores` | List all private ignore rules across projects |

See [docs/mcp-reference.md](docs/mcp-reference.md) for full parameter documentation.

## Embedding providers

Scrybe uses an OpenAI-compatible embeddings API. The following env vars control which provider is used:

| Variable | Default | Description |
| --- | --- | --- |
| `SCRYBE_CODE_EMBEDDING_API_KEY` | — | API key for code embedding. |
| `SCRYBE_CODE_EMBEDDING_BASE_URL` | local | Base URL for the embeddings endpoint. Defaults to local in-process embedder. |
| `SCRYBE_CODE_EMBEDDING_MODEL` | auto | Model name. Auto-set for known providers. |
| `SCRYBE_CODE_EMBEDDING_DIMENSIONS` | auto | Vector dimensions. Auto-set for known providers. |
| `SCRYBE_EMBED_BATCH_SIZE` | `100` | Chunks per embedding request. Reduce if hitting rate limits. |
| `SCRYBE_EMBED_BATCH_DELAY_MS` | `0` | Delay in ms between batches. |

**Known providers** (model and dimensions are set automatically when `SCRYBE_CODE_EMBEDDING_BASE_URL` matches):
OpenAI (`api.openai.com`), Voyage AI (`api.voyageai.com`), Mistral (`api.mistral.ai`).

**Unknown providers:** if `SCRYBE_CODE_EMBEDDING_BASE_URL` points to an unlisted provider and `SCRYBE_CODE_EMBEDDING_MODEL` is not set, scrybe returns an error pointing you to `{base_url}/models` to discover available models.

Set `SCRYBE_CODE_EMBEDDING_API_KEY` explicitly. The old `OPENAI_API_KEY` fallback was removed in v0.29.0.

**Switching providers:** changing the model or dimensions makes all existing indexed data incompatible. Scrybe detects this automatically — `search_code` returns `error_type: "table_corrupt"` with repair instructions. Run `scrybe index -P <id> -S <id> --full` for each affected source, or `scrybe doctor --repair` to fix all corrupt sources in one pass.

### Example: Voyage AI (voyage-code-3)

Code-optimized, free for the first 200M tokens. Requires adding a payment method to unlock standard rate limits (3 RPM without one).

```env
SCRYBE_CODE_EMBEDDING_API_KEY=pa-...
SCRYBE_CODE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1
```

Model and dimensions are set automatically. To override:

```env
SCRYBE_CODE_EMBEDDING_MODEL=voyage-code-3
SCRYBE_CODE_EMBEDDING_DIMENSIONS=1024
```

## Hybrid search

Scrybe runs BM25 full-text search alongside vector search and merges results with Reciprocal Rank Fusion (RRF) — on by default. Configurable via `SCRYBE_HYBRID` and `SCRYBE_RRF_K`. See [docs/configuration.md](docs/configuration.md).

## Reranking

Optional post-retrieval re-scoring. Requires a reranking-capable provider (e.g. Voyage AI `rerank-2.5`).

When using Voyage AI, just set `SCRYBE_RERANK=true` — endpoint and model are auto-detected from `SCRYBE_CODE_EMBEDDING_BASE_URL`.

See [docs/configuration.md](docs/configuration.md) for all options.

## CLI

Projects are containers; sources are the actual indexable units (a code repo, GitLab issues, etc.).

```bash
# Create a project
scrybe project add --id myrepo --desc "My frontend"

# Add a code source
scrybe source add -P myrepo -S primary --type code --root /path/to/repo --languages ts,vue

# Add a GitLab issues source
scrybe source add -P myrepo -S gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...

# Index all sources in a project (full rebuild)
scrybe index -P myrepo --full

# Index a specific source incrementally
scrybe index -P myrepo -S code -I

# Search code / knowledge
scrybe search code -P myrepo "authentication login flow"
scrybe search knowledge -P myrepo "password reset broken"

# List projects and their sources
scrybe project list

# Show status of all projects
scrybe status

# Remove a source or a whole project
scrybe source remove -P myrepo -S gitlab-issues
scrybe project remove myrepo

# Background job monitoring
scrybe jobs

# Manual garbage collection
scrybe gc

# Check index health and repair corrupt sources
scrybe doctor
scrybe doctor --repair
```

Per-source private ignores stored in DATA_DIR via `scrybe ignore` (or `set_private_ignore` MCP tool) — never committed.

See [docs/cli-reference.md](docs/cli-reference.md) for the full command reference.

## Uninstalling

To remove scrybe completely:

```bash
# Remove all indexes, MCP entries, git hook blocks, and DATA_DIR
scrybe uninstall

# Preview what will be removed without making changes
scrybe uninstall --dry-run

# Skip the confirmation prompt (for scripts)
scrybe uninstall --yes
```

`scrybe uninstall` reverses everything scrybe writes outside the binary itself: stops the daemon, removes its entry from every detected AI client config (Claude Code, Cursor, Codex, Cline, Roo Code), strips scrybe blocks from all registered repo git hooks, and deletes the data directory. A timestamped backup is created for every user file before modification.

After uninstalling:

```bash
npm uninstall -g scrybe-cli   # removes the CLI binary
```

## Upgrading

**Global install users** (`npm install -g scrybe-cli`): before upgrading, exit Claude Code, stop the daemon, then install:

```sh
scrybe daemon stop
npm install -g scrybe-cli
```

**npx users**: if you configured Claude Code with `npx -y scrybe-cli@latest mcp`, upgrades are automatic — npx fetches the latest version on each new session.

## Running as a background service

The daemon **starts automatically** when Claude Code calls any scrybe MCP tool (on-demand mode) and shuts down when there are no active clients. No manual setup required for basic use.

To keep the daemon running between sessions — so it can auto-index new commits in the background without Claude Code open — install it as a per-user service:

```bash
# Install as a per-user autostart (Windows / macOS / Linux — no admin needed)
scrybe daemon install

# Watch live status
scrybe status --watch

# Opt-in git hooks: git commit/checkout/merge → instant reindex
scrybe hook install -P myrepo

# Pin branches for background indexing beyond current HEAD
scrybe branch pin -P myrepo main dev staging
```

Daemon auto-cleans orphan chunks on idle — `scrybe gc` for manual cleanup.

See [docs/daemon.md](docs/daemon.md) for the full architecture, autostart details, and troubleshooting.

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

If you hit rate limits during indexing, tune `SCRYBE_EMBED_BATCH_SIZE` and `SCRYBE_EMBED_BATCH_DELAY_MS` in your `.env`.

## Known limitations

- **HTML / CSS / SCSS** use sliding-window chunking. Tree-sitter grammars exist for them but these languages have no function/class declarations, so chunk boundaries are arbitrary rather than semantic. Particularly noticeable for large single-page static sites.
- **Kotlin, PHP, Swift** fall back to sliding-window. Tree-sitter grammar packages exist but aren't wired up yet (easy to add when needed).

## Contributing

See [docs/contributing.md](docs/contributing.md) for how to run tests locally and add new tests.
