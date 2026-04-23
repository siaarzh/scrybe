# scrybe plugin for Claude Code

Adds a `search_code`-over-Grep guidance skill and a `/scrybe` reindex command to Claude Code.

## Install

```
/plugin install https://github.com/siaarzh/scrybe
```

Restart Claude Code after installing to activate.

## What it does

**Skill (always active):** Guides Claude to call `search_code` instead of `Grep` for
conceptual questions about how the codebase works. Multilingual queries work out of the
box — ask in Russian or Chinese, find English code.

**`/scrybe` command:** Checks if the current repo is indexed and triggers an incremental
reindex via the scrybe MCP server.

## Prerequisites

1. **scrybe installed globally:**
   ```bash
   npm install -g scrybe-cli
   ```
2. **At least one project indexed:**
   ```bash
   scrybe init
   ```
   Works offline by default — no API key or signup required. On first run, downloads
   the local embedding model (~120 MB).

3. **Editor restarted** after `scrybe init` so the MCP config is picked up.

## Usage

Ask Claude naturally:

- "how does authentication work in this codebase?"
- "where is the error handling for payments?"
- "найди логику авторизации" (Russian → finds English code)

Claude will call `search_code` automatically when the question is conceptual.
To reindex after a big pull: type `/scrybe`.

## Troubleshooting

**search_code returns no results:**
- Check registered projects: ask Claude to call `list_projects`
- Re-run `scrybe init` if the current repo isn't listed

**Model not found error:**
- The local embedding model downloads on first use; ensure internet access for the
  initial download, then it runs fully offline

**MCP server not connecting:**
- Run `scrybe doctor` in your terminal for a full diagnostic
