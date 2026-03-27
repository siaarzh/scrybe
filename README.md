# scrybe

Self-hosted code memory with semantic search. Index your repos into a local vector database and search them by natural language — from the CLI, HTTP API, or directly inside Claude Code via MCP.

## How it works

```
Claude Code
    ↕ MCP (auto-managed)
backend/mcp_server.py
    ↕ HTTP
Qdrant (Docker)  ←  your indexed code
```

## Requirements

- Python 3.11+
- Docker Desktop (with "Start on login" enabled)
- OpenAI API key (for embeddings)

## Setup

```bash
# 1. Clone and enter the repo
cd scrybe

# 2. Create virtual environment
python -m venv .venv
.venv\Scripts\activate

# 3. Install dependencies
pip install -e .

# 4. Configure environment
copy .env.example .env
# Edit .env and add your OPENAI_API_KEY

# 5. Start Qdrant
docker compose up -d
```

## Indexing a project

```bash
# Register a project
python cli.py add-project --id cmx-ionic --root C:\Users\serzh\repos\cmx-ionic --languages ts,vue --desc "Frontend"

# Index it (takes a minute or two on first run)
python cli.py index --project-id cmx-ionic

# List registered projects
python cli.py list-projects
```

## Searching

```bash
python cli.py search --project-id cmx-ionic "authentication login flow"
```

## HTTP API

```bash
uvicorn backend.api:app --reload
# Docs at http://localhost:8000/docs
```

## MCP server (Claude Code integration)

Add to your Claude Code `settings.json` under `mcpServers`:

```json
"scrybe": {
  "type": "stdio",
  "command": "/path/to/scrybe/.venv/Scripts/python.exe",
  "args": ["-m", "backend.mcp_server"],
  "env": {
    "PYTHONPATH": "/path/to/scrybe"
  }
}
```

Replace `/path/to/scrybe` with the absolute path to your clone. Make sure Qdrant is running (`docker compose up -d`) before starting a session.

Tools available: `search_code`, `reindex_project`, `reindex_status`, `cancel_reindex`, `list_projects`.
