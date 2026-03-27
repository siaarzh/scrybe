# scrybe

Self-hosted code memory with semantic search. Index your repos into a local vector database and search them by natural language — from the CLI, HTTP API, or directly inside Claude Code via MCP.

## How it works

```
Claude Code (any project)
    ↕ MCP stdio
backend/mcp_server.py
    ↕
Qdrant (embedded, in-process)  ←  your indexed code
```

No Docker. Qdrant runs in-process. All data lives in the OS user data directory:
- **Windows:** `%LOCALAPPDATA%\scrybe\scrybe\`
- **Linux:** `~/.local/share/scrybe/`
- **Mac:** `~/Library/Application Support/scrybe/`

## Requirements

- Python 3.11+
- OpenAI API key (for embeddings)

## Setup

```bash
# 1. Clone and enter the repo
cd scrybe

# 2. Create virtual environment
python -m venv .venv
.venv\Scripts\activate  # Windows
# source .venv/bin/activate  # Linux/Mac

# 3. Install dependencies
pip install -e .

# 4. Configure environment
copy .env.example .env   # Windows
# cp .env.example .env   # Linux/Mac
# Edit .env and set OPENAI_API_KEY
```

## CLI

```bash
# Register a project
python cli.py add-project --id myrepo --root /path/to/repo --languages ts,vue --desc "My frontend"

# Update a registered project
python cli.py update-project --id myrepo --languages ts,vue,css

# List registered projects
python cli.py list-projects

# Index a project (full rebuild)
python cli.py index --project-id myrepo --full

# Index incrementally (only changed files)
python cli.py index --project-id myrepo --incremental

# Check how many chunks are indexed
python cli.py status --project-id myrepo

# Search
python cli.py search --project-id myrepo "authentication login flow"

# Remove a project from the registry
python cli.py remove-project --id myrepo
```

## MCP server (Claude Code integration)

Add to `~/.claude.json` under `mcpServers`:

```json
"scrybe": {
  "type": "stdio",
  "command": "C:/path/to/scrybe/.venv/Scripts/python.exe",
  "args": ["-m", "backend.mcp_server"],
  "env": {
    "PYTHONPATH": "C:/path/to/scrybe",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

Replace `C:/path/to/scrybe` with the absolute path to your clone. `OPENAI_API_KEY` can be omitted if it's already set in `.env`.

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

## HTTP API (optional)

```bash
uvicorn backend.api:app --reload
# Interactive docs at http://localhost:8000/docs
```
