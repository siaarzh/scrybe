# scrybe plugin for Claude Code

Adds a `search_code`-over-Grep guidance skill, a `/scrybe` reindex command, and a search toll on keyword-only issue searches.

## Install

```
/plugin install https://github.com/siaarzh/scrybe
```

Restart Claude Code after installing to activate.

## What it does

**Skill (always active):** Guides Claude to call `search_code` instead of `Grep` for conceptual questions about how the codebase works. Multilingual queries work out of the box — ask in Russian or Chinese, find English code.

**`/scrybe` command:** Checks if the current repo is indexed and triggers an incremental reindex via the scrybe MCP server.

**Search guard (hook):** When Claude reaches for a keyword-only issue search such as `gh issue list`, the hook refuses the command and tells it to use `search_knowledge` instead. The refusal does not expire — there is no wait to sit out. This exists because keyword search silently misses the ticket that describes the same problem in different words, which is how duplicates get filed. Turn it off with `{"enabled": false}` in `toll.json`, or soften it to a timed wait or a note per command. Full reference: [docs/search-toll.md](../../docs/search-toll.md).

## Prerequisites

1. **scrybe installed globally:**
   ```bash
   npm install -g scrybe-cli
   ```
2. **At least one project indexed:**
   ```bash
   scrybe init
   ```
   Works offline by default — no API key or signup required. On first run, downloads the local embedding model (~120 MB).

3. **Editor restarted** after `scrybe init` so the MCP config is picked up.

## Usage

Ask Claude naturally:

- "how does authentication work in this codebase?"
- "where is the error handling for payments?"
- "найди логику авторизации" (Russian → finds English code)

Claude will call `search_code` automatically when the question is conceptual. To reindex after a big pull: type `/scrybe`.

## Troubleshooting

**search_code returns no results:**
- Check registered projects: ask Claude to call `list_projects`
- Re-run `scrybe init` if the current repo isn't listed

**Model not found error:**
- The local embedding model downloads on first use; ensure internet access for the initial download, then it runs fully offline

**MCP server not connecting:**
- Run `scrybe doctor` in your terminal for a full diagnostic

**The guard refuses a command you wanted to run:**
- It is config, not code. See [docs/search-toll.md](../../docs/search-toll.md) — `enabled: false` turns it off entirely, and a per-command `action` softens a refusal into a timed wait or a note.
