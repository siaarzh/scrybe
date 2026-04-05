# scrybe

Self-hosted code memory with semantic search. Index your repos and knowledge sources into a local vector database and search them by natural language — from the CLI or directly inside Claude Code via MCP.

## How it works

```
Claude Code (any project)
    ↕ MCP stdio
src/mcp-server.ts
    ↕
LanceDB (embedded, in-process)
    ├── code_chunks     ← indexed code files (search_code)
    └── knowledge_chunks ← indexed knowledge sources (search_knowledge)
```

No Docker. LanceDB runs in-process. All data lives in the OS user data directory:

- **Windows:** `%LOCALAPPDATA%\scrybe\scrybe\`
- **Linux:** `~/.local/share/scrybe/`
- **Mac:** `~/Library/Application Support/scrybe/`

## Requirements

- Node.js 20+
- An embedding API key (OpenAI by default; see [Embedding providers](#embedding-providers) for alternatives)

## Setup

```bash
# 1. Clone and enter the repo
cd scrybe

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Configure environment
copy .env.example .env   # Windows
# cp .env.example .env   # Linux/Mac
# Edit .env and set your embedding API key
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

Index all issues and comments from a GitLab project:

```bash
node dist/index.js add-project \
  --id myrepo-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...
```

Indexing is cursor-based and incremental — only issues updated since the last run are fetched. Rate-limit safe (50 ms between issues).

To rotate a token without re-registering:

```bash
node dist/index.js update-project --id myrepo-issues --gitlab-token glpat-...
```

## CLI

```bash
# Register a code project
node dist/index.js add-project --id myrepo --root /path/to/repo --languages ts,vue --desc "My frontend"

# Register a GitLab issues project
node dist/index.js add-project --id myrepo-issues --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...

# Update a registered project
node dist/index.js update-project --id myrepo --languages ts,vue,css
node dist/index.js update-project --id myrepo-issues --gitlab-token glpat-...

# List registered projects
node dist/index.js list-projects

# Index a project (full rebuild)
node dist/index.js index --project-id myrepo --full

# Index incrementally (only changed files / updated issues)
node dist/index.js index --project-id myrepo --incremental

# Show project info
node dist/index.js status --project-id myrepo

# Search code
node dist/index.js search --project-id myrepo "authentication login flow"

# Search knowledge sources
node dist/index.js search-knowledge --project-id myrepo-issues "password reset broken"

# Remove a project from the registry
node dist/index.js remove-project --id myrepo
```

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
| `list_projects` | List all registered projects |
| `add_project` | Register a new project (code or ticket source) |
| `update_project` | Update an existing project's path, languages, description, or token |
| `search_code` | Semantic search over indexed code files |
| `search_knowledge` | Semantic search over indexed knowledge sources (issues, docs, messages) |
| `reindex_project` | Trigger background reindex (`full` or `incremental`) |
| `reindex_status` | Poll a background reindex job |
| `cancel_reindex` | Cancel a running reindex job |

## Code chunking

Code files are chunked using Tree-sitter AST parsing, which aligns chunk boundaries with actual function, class, and method definitions. This significantly improves retrieval precision compared to arbitrary sliding-window splits.

**Supported languages (AST chunking):** TypeScript, TSX, JavaScript, JSX, C#, Vue, Python, Go, Ruby, Rust, Java

**Fallback:** unsupported languages and parse failures fall back to sliding-window chunking — no regression on existing indexed repos.

Each code chunk includes a `symbol_name` field (the enclosing function or class name) surfaced in search results.

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
