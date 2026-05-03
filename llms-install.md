# Installing scrybe (for AI agents)

This file tells AI coding assistants (Cline, Roo Code, etc.) how to install and wire up scrybe non-interactively. If you're a human, use [`README.md`](./README.md) — the `scrybe init` wizard is faster.

## What scrybe is

Self-hosted semantic code search. Indexes git repos into a local LanceDB vector database and exposes `search_code` / `search_knowledge` tools via MCP. Works offline by default (local WASM embedder, no API key required).

## Prerequisites

- **Node.js 22.5 or later** (`node --version` must report `v22.5.0+`).
- A git repository you want to index.

## Step 1 — Install globally

```bash
npm install -g scrybe-cli
```

Verify:

```bash
scrybe --version
```

## Step 2 — Register a project

Replace `<project-id>` with a short slug (lowercase, hyphens only) and `<absolute-path>` with the absolute path to the repo root.

```bash
scrybe add-project --id <project-id> --desc "<short description>"
scrybe add-source --project-id <project-id> --source-id primary \
  --type code --root <absolute-path>
```

No `--languages` flag is needed — scrybe sniffs extensions automatically.

## Step 3 — Index

```bash
scrybe index --project-id <project-id> --incremental
```

First run downloads ~120 MB for the local embedder. Subsequent runs only process changed files.

## Step 4 — Register scrybe as an MCP server

Add the following entry to the MCP settings file for the host agent.

### For Cline

File location (platform-specific):

- **Windows:** `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- **macOS:** `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Linux:** `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

Merge this entry into the existing `mcpServers` object (create the file with this content if it doesn't exist):

```json
{
  "mcpServers": {
    "scrybe": {
      "command": "npx",
      "args": ["-y", "scrybe-cli@latest", "mcp"]
    }
  }
}
```

### For Roo Code

File location:

- **Windows:** `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json`
- **macOS:** `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`
- **Linux:** `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`

Same JSON structure as Cline.

### For Codex

File: `~/.codex/config.toml` (create if absent). Add:

```toml
[mcp_servers.scrybe]
command = "npx"
args = ["-y", "scrybe-cli@latest", "mcp"]
```

## Step 5 — Verify

```bash
scrybe doctor
```

Expected: all checks green except possibly `daemon.hook.*` (git hooks are opt-in and unrelated to search working).

Then reload the host agent (Cline / Roo Code / Codex) so the new MCP entry is picked up. After reload, the agent should list `search_code`, `search_knowledge`, and other scrybe tools as available.

## Common options

### Index multiple repos

Repeat Steps 2 and 3 for each repo. Each project is independent; all are searchable in parallel.

### Use an external embedding provider (optional)

If you want Voyage AI, OpenAI, or another OpenAI-compatible endpoint instead of the default local embedder, create `<DATA_DIR>/.env`:

```env
EMBEDDING_BASE_URL=https://api.voyageai.com/v1
EMBEDDING_API_KEY=pa-...
```

`<DATA_DIR>` is reported by `scrybe doctor` — typically `%LOCALAPPDATA%\scrybe\scrybe\` on Windows, `~/.local/share/scrybe/` on Linux, `~/Library/Application Support/scrybe/` on macOS.

Then run a full reindex:

```bash
scrybe index --project-id <project-id> --full
```

(Switching providers changes embedding dimensions, which invalidates the existing index.)

### Add GitLab issues as a knowledge source

```bash
scrybe add-source --project-id <project-id> --source-id gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...
scrybe index --project-id <project-id> --source-id gitlab-issues --full
```

Indexed issues are searchable via the `search_knowledge` MCP tool.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `scrybe: command not found` | Check `npm bin -g` is on PATH |
| `scrybe doctor` reports "Node version" fail | Upgrade to Node 22.5 or later |
| MCP tools don't appear in agent | Reload the host agent after editing the MCP settings file |
| Indexing hangs on first run | Local embedder downloads ~120 MB — wait for network; subsequent runs are instant |
| Out-of-disk errors | LanceDB grows with index size; ~1 MB per 100 chunks is typical |

## Reference

- Full CLI reference: [`docs/cli-reference.md`](./docs/cli-reference.md)
- Full MCP tool reference: [`docs/mcp-reference.md`](./docs/mcp-reference.md)
- Configuration options: [`docs/configuration.md`](./docs/configuration.md)
