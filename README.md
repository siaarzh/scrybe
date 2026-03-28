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
- OpenAI API key (for embeddings)

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
# Edit .env and set OPENAI_API_KEY
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
|---|---|
| `list_projects` | List all registered projects |
| `add_project` | Register a new project |
| `update_project` | Update an existing project's path, languages, or description |
| `search_code` | Semantic search by natural language query |
| `reindex_project` | Trigger background reindex (`full` or `incremental`) |
| `reindex_status` | Poll a background reindex job |
| `cancel_reindex` | Cancel a running reindex job |
