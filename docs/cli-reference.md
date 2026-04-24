# CLI Reference

All commands run via `scrybe <command> [options]`.

---

## Setup commands

### `init`

Interactive first-run wizard. Defaults to a **local offline embedder** (no API key or signup required). External providers (Voyage AI, OpenAI, Mistral) are accessible via "Use an external provider?" at the first prompt.

Guides through: provider setup → repo discovery → `.scrybeignore` generation → MCP auto-registration (Claude Code and Cursor) → optional initial index. Re-running on an already-configured machine short-circuits completed steps.

| Flag | Description |
|------|-------------|
| `--register-only` | Register repos and write MCP config, but skip the initial index (CI/scripting) |

```bash
scrybe init
scrybe init --register-only
```

Config is written to `<DATA_DIR>/.env` and picked up automatically on subsequent runs. Local embedder: writes `SCRYBE_LOCAL_EMBEDDER` + `EMBEDDING_DIMENSIONS`. External provider: writes `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_API_KEY`.

MCP auto-registration detects and offers to update: **Claude Code** (`~/.claude.json`), **Cursor** (`~/.cursor/mcp.json`), **Codex** (`~/.codex/config.toml`), **Cline** and **Roo Code** (VS Code globalStorage paths).

---

### `doctor`

One-shot diagnostics. Checks: DATA_DIR, Node version, provider config and auth (live test embedding), embedding dimensions match, schema version, projects.json integrity, LanceDB directory, branch-tags.db, per-source last-indexed and chunk count, daemon pidfile and HTTP health, git hook presence, and MCP configuration for Claude Code and Cursor.

| Flag | Description |
|------|-------------|
| `--json` | Output a stable `DoctorReport` JSON object (schemaVersion: 1) for machine consumption |
| `--strict` | Exit code 1 on warnings as well as failures |

```bash
scrybe doctor
scrybe doctor --json
scrybe doctor --strict
```

Exit codes: 0 = all ok, 1 = any failure (or any warning with `--strict`).

---

### Default (zero-config)

When run with no subcommand in a git repository:

- **No flags** — prints a hint to run `scrybe init` or `scrybe --auto`.
- **`--auto`** — registers the current directory as a project (id = directory basename) and runs an incremental index. Requires an interactive TTY.

```bash
# In an unregistered git repo:
scrybe --auto
```

---

## Project commands

### `add-project`

Register a new project container. Sources are added separately with `add-source`.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Unique project identifier |
| `--desc <text>` | | Human-readable description |

```bash
scrybe add-project --id myrepo --desc "My frontend"
```

---

### `update-project`

Update a project's description.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Project identifier |
| `--desc <text>` | | New description |

---

### `remove-project`

Unregister a project and drop all its source tables (vector data deleted).

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Project identifier |

---

### `list-projects`

List all registered projects and their sources, including indexing status and searchability.

No flags.

---

### `status`

Print full project JSON (sources, table names, last indexed timestamps, `branches_indexed` per source) and the data directory path.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |

---

## Source commands

### `add-source`

Add an indexable source to a project.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to add the source to |
| `--source-id <id>` | ✓ | Label for this source, e.g. `code`, `gitlab-issues` |
| `--type <type>` | ✓ | `code` or `ticket` |

**For `--type code`:**

| Flag | Required | Description |
|------|----------|-------------|
| `--root <path>` | ✓ | Absolute path to repo root |
| `--languages <langs>` | | Comma-separated language hints, e.g. `ts,vue` |

**For `--type ticket`:**

| Flag | Required | Description |
|------|----------|-------------|
| `--gitlab-url <url>` | ✓ | GitLab instance base URL |
| `--gitlab-project-id <id>` | ✓ | GitLab project ID or path |
| `--gitlab-token <token>` | ✓ | GitLab personal access token (validated against the API before saving) |

**Embedding overrides (optional, any type):**

| Flag | Description |
|------|-------------|
| `--embedding-base-url <url>` | Override embedding API base URL for this source |
| `--embedding-model <model>` | Override embedding model |
| `--embedding-dimensions <n>` | Override embedding dimensions |
| `--embedding-api-key-env <var>` | Name of the env var holding the API key (not the key itself) |

```bash
# Code source
scrybe add-source --project-id myrepo --source-id code \
  --type code --root /path/to/repo --languages ts,vue

# GitLab issues source
scrybe add-source --project-id myrepo --source-id gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...
```

---

### `update-source`

Update an existing source's config. Only the flags you provide are changed — everything else stays as-is.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | ✓ | Source identifier |

**For `--type ticket` sources:**

| Flag | Description |
|------|-------------|
| `--gitlab-token <token>` | Rotate the GitLab personal access token |
| `--gitlab-url <url>` | Change the GitLab instance base URL |
| `--gitlab-project-id <id>` | Change the GitLab project ID or path |

**For `--type code` sources:**

| Flag | Description |
|------|-------------|
| `--root <path>` | Change the absolute path to repo root |
| `--languages <langs>` | Change comma-separated language hints |

**Embedding overrides (optional, any type):**

| Flag | Description |
|------|-------------|
| `--embedding-base-url <url>` | Override embedding API base URL for this source |
| `--embedding-model <model>` | Override embedding model |
| `--embedding-dimensions <n>` | Override embedding dimensions |
| `--embedding-api-key-env <var>` | Name of the env var holding the API key (not the key itself) |

```bash
# Rotate a GitLab token
scrybe update-source --project-id myrepo --source-id gitlab-issues \
  --gitlab-token glpat-newtoken
```

---

### `remove-source`

Remove a source from a project and drop its vector table.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | ✓ | Source identifier |

---

## Index commands

### `index`

Index or reindex a project (all sources), specific sources, or all registered projects.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Project to index (required unless `--all`) |
| `--source-ids <ids>` | | Comma-separated source IDs to index, e.g. `primary,gitlab-issues`. Required when using `--full` |
| `--all` | | Incrementally reindex all registered projects |
| `--full` | | Full reindex — clears and rebuilds from scratch. Requires `--source-ids` |
| `--incremental` | | Only process changed files / updated issues since last run (default) |
| `--branch <name>` | | Branch to index for code sources (default: current HEAD). Ignored for ticket sources |

```bash
# Incremental reindex of all registered projects
scrybe index --all

# Incremental reindex of all sources in a project (default mode)
scrybe index --project-id myrepo

# Full reindex of specific sources
scrybe index --project-id myrepo --source-ids primary --full
scrybe index --project-id myrepo --source-ids primary,gitlab-issues --full

# Incremental reindex of one source
scrybe index --project-id myrepo --source-ids gitlab-issues

# Index a specific git branch
scrybe index --project-id myrepo --source-ids primary --branch feat/my-feature
```

---

### `jobs`

List background reindex jobs from the current process.

| Flag        | Required | Description                       |
|-------------|----------|-----------------------------------|
| `--running` |          | Show only currently running jobs  |

```bash
scrybe jobs
scrybe jobs --running
```

---

### `gc`

Remove orphaned chunks from the vector store. Orphans accumulate when branches are deleted or full reindexes are skipped — they waste disk space and slightly skew search scores.

**Only operates on code sources** (since v0.14.1). Non-code sources (GitLab issues, etc.) are branch-agnostic and don't participate in `branch_tags` — a "stale" ticket chunk means its upstream issue was deleted, which can't be detected without an API fetch. That's a future `scrybe reconcile` command.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Limit GC to a specific project (default: all projects) |
| `--dry-run` | | Report orphans without deleting |

A chunk is orphaned when no `branch_tags` row references it (it was never re-tagged after its branch was dropped).

```bash
# Dry run — see what would be deleted
scrybe gc --dry-run

# Remove orphans in a single project
scrybe gc --project-id myrepo

# Remove orphans across all projects
scrybe gc
```

Run after deleting a long-lived branch or after migrating from v0.13.x.

---

## Search commands

### `search`

Semantic search over indexed code sources.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--top-k <n>` | | Number of results (default: 10) |
| `--branch <name>` | | Branch to search (default: current HEAD for code sources) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
scrybe search --project-id myrepo "authentication login flow"
scrybe search --project-id myrepo --branch feat/my-feature "new feature implementation"
```

---

### `search-knowledge`

Semantic search over indexed knowledge sources (GitLab issues, etc.).

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--source-id <id>` | | Limit to a specific source |
| `--source-types <types>` | | Comma-separated source type filter. Known values: `ticket` (issue bodies), `ticket_comment` (individual comments) |
| `--top-k <n>` | | Number of results (default: 10) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
scrybe search-knowledge --project-id myrepo "password reset broken"
scrybe search-knowledge --project-id myrepo --source-types ticket "login error"
scrybe search-knowledge --project-id myrepo --source-types ticket_comment "architectural decision"
```

---

## Daemon commands

### `daemon start`

Start the background daemon. Writes a pidfile at `<DATA_DIR>/daemon.pid`. Exits 1 if a daemon is already running.

```bash
scrybe daemon start
```

---

### `daemon stop`

Graceful shutdown: calls `POST /shutdown`, waits up to 5 s for the pidfile to be removed.

```bash
scrybe daemon stop
```

---

### `daemon status`

Print the daemon's current status as JSON. Add `--watch` for a live Ink terminal dashboard (polls `/status` every 2 s and streams SSE events).

| Flag | Description |
|------|-------------|
| `--watch` | Live terminal dashboard (requires daemon running) |

```bash
scrybe daemon status
scrybe daemon status --watch
```

---

### `daemon restart`

Stop then start the daemon.

```bash
scrybe daemon restart
```

---

### `daemon install`

Install the daemon as a per-user autostart entry (no admin / sudo required). Platform-specific:

- **Windows** — logon Scheduled Task via `schtasks`, fallback to `HKCU\...\Run`
- **macOS** — `~/Library/LaunchAgents/com.scrybe.daemon.plist` + `launchctl load`
- **Linux** — `~/.config/systemd/user/scrybe.service` + `systemctl --user enable --now`

```bash
scrybe daemon install
scrybe daemon uninstall
```

---

### `daemon kick`

Trigger an immediate incremental reindex for a project by posting to the daemon's `/kick` endpoint. Used by git hooks.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Project to kick (default: all projects) |
| `--source-id <id>` | | Limit to a specific source |
| `--branch <name>` | | Branch to reindex (default: current HEAD) |
| `--mode <mode>` | | `full` or `incremental` (default: `incremental`) |

```bash
scrybe daemon kick --project-id myrepo
```

---

## Hook commands

### `hook install`

Append a marker-delimited scrybe block to `.git/hooks/post-commit`, `post-checkout`, `post-merge`, and `post-rewrite`. Safe to run on repos with existing hook content — only the scrybe block is added. Idempotent.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to install hooks for |

```bash
scrybe hook install --project-id myrepo
```

---

### `hook uninstall`

Remove the scrybe marker block from all git hooks in the project. Non-scrybe hook content is preserved.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to remove hooks from |

```bash
scrybe hook uninstall --project-id myrepo
```

---

## Pinned-branch commands

Pinned branches are code branches the daemon keeps indexed in the background (via periodic `git fetch` + incremental reindex). Only `code` sources support pinning.

### `pin list`

Print the pinned branches for a project source.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |

```bash
scrybe pin list --project-id cmx-ionic
```

---

### `pin add`

Add one or more branch names to the pinned list. Merges with the existing list (deduped). Emits a warning for unknown remote refs or when the total count exceeds 20. If the daemon is running, newly-pinned branches are backfilled immediately.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |
| `<branch...>` | ✓ | Branch names (positional) |

```bash
scrybe pin add --project-id cmx-ionic main dev dev-2 dev-3 beta
```

---

### `pin remove`

Remove specific branch names from the pinned list. Orphaned chunks remain until `scrybe gc` is run.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |
| `<branch...>` | ✓ | Branch names to remove (positional) |

```bash
scrybe pin remove --project-id cmx-ionic dev-3
```

---

### `pin clear`

Remove all pinned branches for a source. Asks for confirmation unless `--yes` is passed.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |
| `--yes` | | Skip confirmation prompt |

```bash
scrybe pin clear --project-id cmx-ionic --yes
```
