# scrybe

Self-hosted code memory with semantic search. Index your repos into a local vector database and search them by natural language — from the CLI or directly inside Claude Code via MCP.

## How it works

```
Claude Code (any project)
    ↕ MCP stdio
src/mcp-server.ts
    ↕
LanceDB (embedded, in-process)  ←  your indexed code
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

## CLI

```bash
# Register a project
node dist/index.js add-project --id myrepo --root /path/to/repo --languages ts,vue --desc "My frontend"

# Update a registered project
node dist/index.js update-project --id myrepo --languages ts,vue,css

# List registered projects
node dist/index.js list-projects

# Index a project (full rebuild)
node dist/index.js index --project-id myrepo --full

# Index incrementally (only changed files)
node dist/index.js index --project-id myrepo --incremental

# Show project info
node dist/index.js status --project-id myrepo

# Search
node dist/index.js search --project-id myrepo "authentication login flow"

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
| `add_project` | Register a new project |
| `update_project` | Update an existing project's path, languages, or description |
| `search_code` | Semantic search by natural language query |
| `reindex_project` | Trigger background reindex (`full` or `incremental`) |
| `reindex_status` | Poll a background reindex job |
| `cancel_reindex` | Cancel a running reindex job |
