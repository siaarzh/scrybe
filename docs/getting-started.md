# Getting Started

## 1. Install

```bash
git clone <repo-url>
cd scrybe
npm install
npm run build
```

## 2. Configure embedding

Copy `.env.example` to `.env` and set your embedding API key:

```env
EMBEDDING_API_KEY=your-key-here
```

By default this uses OpenAI. To use Voyage AI (recommended — code-optimized, free for first 200M tokens):

```env
EMBEDDING_API_KEY=pa-...
EMBEDDING_BASE_URL=https://api.voyageai.com/v1
```

See [configuration.md](configuration.md) for all options.

## 3. Register a project

Projects are containers. Add sources to them separately.

```bash
# Create the project
scrybe project add --id myrepo --desc "My frontend"

# Add a code source
scrybe source add -P myrepo -S code \
  --type code --root /absolute/path/to/repo --languages ts,vue

# Optionally add a GitLab issues source
scrybe source add -P myrepo -S gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...
```

## 4. (Optional) Add a `.scrybeignore`

Place a `.scrybeignore` in the repo root to fine-tune what gets indexed. Uses gitignore syntax. Negation patterns (`!path`) can override both `.gitignore` and Scrybe's built-in skip lists.

```gitignore
# Exclude large test fixtures
tests/fixtures/

# Force-include a gitignored build artifact
!dist/api-types.d.ts
```

See [configuration.md](configuration.md#scrybeignore) for full details.

## 5. Index

```bash
# Full index (required first time)
scrybe index -P myrepo --full

# Or index a single source
scrybe index -P myrepo -S code --full
```

After the initial full index, use `--incremental` for day-to-day resyncs — it only processes changed files/issues.

## 6. Search

```bash
# Search code
scrybe search -P myrepo "authentication login flow"

# Search knowledge (issues, etc.)
scrybe search knowledge -P myrepo "password reset broken"
```

## 7. Connect to Claude Code (MCP)

First, install the daemon for autostart so MCP probes connect instantly:

```bash
scrybe daemon install
```

Then add to `~/.claude.json` under `mcpServers`:

```json
"scrybe": {
  "type": "stdio",
  "command": "scrybe",
  "args": ["mcp"]
}
```

Restart Claude Code. The `mcp__scrybe__*` tools become available in all projects. `scrybe mcp` runs as a thin shim that talks HTTP to the daemon — heavy modules (embedder, lancedb, tree-sitter) load once on the daemon side, so cold MCP boot is sub-second.

If the daemon isn't installed or isn't running, the MCP server will surface a single `scrybe_daemon_unavailable` tool whose description includes the exact recovery command (`scrybe daemon install`, `scrybe daemon start`, or `scrybe daemon restart`).

## Day-to-day workflow

```bash
# After pulling new code
scrybe index -P myrepo -S code --incremental

# After new issues/comments in GitLab
scrybe index -P myrepo -S gitlab-issues --incremental
```

Or trigger it from Claude Code:
```
mcp__scrybe__reindex_source(project_id="myrepo", source_id="code", mode="incremental")
```
