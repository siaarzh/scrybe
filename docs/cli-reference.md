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

One-shot diagnostics. Checks: DATA_DIR, Node version, provider config and auth (live test embedding), embedding dimensions match, schema version, projects.json integrity, LanceDB directory, branch-tags.db, per-source last-indexed and chunk count, daemon pidfile and HTTP health, always-on install state (skip-level recommendation when not installed), git hook presence, and MCP configuration for Claude Code and Cursor.

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

### `ignore`

Edit per-source private ignore rules. Rules are stored in `DATA_DIR/ignores/<project_id>/<source_id>.gitignore` and are **never committed** to the repo. Applied additively on top of `.gitignore` and committed `.scrybeignore`.

```bash
scrybe ignore        # interactive wizard
scrybe ignore edit   # same (alias)
```

**Wizard flow:**

1. Auto-detects the project from the current working directory (still asks to confirm)
2. If the project has more than one code source, asks which source to edit
3. Opens `$VISUAL` → `$EDITOR` → `notepad.exe` (Windows) / `open -t` (macOS) / `nano` (Linux) on the file
4. After closing the editor, prompts: *"Reindex now? [Y/n]"* — default Yes, enqueues an incremental reindex via the daemon

**New file template:** when no file exists yet, a header comment block is created with syntax examples before the editor opens.

**Rule layering order:**
1. Built-in skip rules (`node_modules`, `.git`, etc.)
2. `.gitignore` (working tree)
3. Committed `.scrybeignore` (working tree)
4. Private ignore (DATA_DIR)

> **Note:** `$EDITOR` / `$VISUAL` not set on Windows? The wizard falls back to `notepad.exe` automatically.

---

## Project commands

### `project add`

Register a new project container. Sources are added separately with `source add`.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Unique project identifier |
| `--desc <text>` | | Human-readable description |

```bash
scrybe project add --id myrepo --desc "My frontend"
```

---

### `project update`

Update a project's description.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Project identifier |
| `--desc <text>` | | New description |

---

### `project remove`

Unregister a project and drop all its source tables (vector data deleted).

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Project identifier |

---

### `project list`

List all registered projects and their sources, including indexing status and searchability.

No flags.

---

### `status`

Without `--project-id`: shows a unified health layout — daemon state, version, DATA_DIR, and a registry summary (chunk count + last indexed per source, truncated to 5 by default).

With `--project-id`: prints full project JSON (sources, table names, last indexed timestamps, `branches_indexed`) and the data directory path (previous behavior, unchanged).

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | — | Single-project JSON mode (legacy) |
| `--json` | — | Machine-readable output (`schemaVersion: 1`) |
| `--projects` | — | Hide daemon section, show only project registry |
| `--all` | — | Show all projects (no truncation to 5) |
| `--watch` | — | Live Ink dashboard (requires daemon) |

```bash
scrybe status
scrybe status --json
scrybe status --all
scrybe status --project-id cmx-core
```

**JSON shape (`--json`):**

```json
{
  "schemaVersion": 1,
  "scrybeVersion": "0.22.0",
  "dataDir": { "path": "...", "sizeBytes": 888888888 },
  "daemon": {
    "running": true, "pid": 47231, "uptimeMs": 187200, "activeJobs": 0,
    "clientCount": 1, "mode": "on-demand", "gracePeriodRemainingMs": null
  },
  "projects": [
    { "id": "cmx-core", "sources": [{ "sourceId": "primary", "chunks": 12847, "lastIndexed": "..." }] }
  ]
}
```

`mode` is `"on-demand"` (daemon shuts down after agents disconnect) or `"always-on"` (running via OS autostart with `SCRYBE_DAEMON_KEEP_ALIVE=1`). `gracePeriodRemainingMs` is `null` unless the daemon is in the idle grace window counting down to shutdown.

---

### `uninstall`

Completely reverses everything scrybe writes outside the binary: stops the daemon, removes its OS autostart entry (if installed), removes its MCP entry from all detected AI client configs, strips scrybe blocks from registered git hooks, and deletes DATA_DIR. Creates a timestamped backup (`.scrybe-backup-<epoch>`) for every user file before modifying it. Shows the full action plan before executing.

| Flag | Required | Description |
|------|----------|-------------|
| `--dry-run` | — | Show plan and exit without making any changes |
| `--yes` | — | Skip confirmation prompt (for CI/scripting) |

```bash
scrybe uninstall --dry-run   # preview
scrybe uninstall             # interactive
scrybe uninstall --yes       # non-interactive
```

**Exit codes:** `0` = success, `1` = partial failure (best-effort), `2` = preflight rejected (nothing done), `130` = user cancelled.

After running `scrybe uninstall`, remove the CLI binary with:

```bash
npm uninstall -g scrybe-cli
```

---

## Source commands

### `source add`

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
scrybe source add --project-id myrepo --source-id code \
  --type code --root /path/to/repo --languages ts,vue

# GitLab issues source
scrybe source add --project-id myrepo --source-id gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...
```

---

### `source update`

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
scrybe source update --project-id myrepo --source-id gitlab-issues \
  --gitlab-token glpat-newtoken
```

---

### `source remove`

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
| `--branch <name>` | | Branch to index for code sources (default: current HEAD). Ignored for ticket sources. Errors if `<name>` is not a resolvable git ref (use `origin/<name>` for remote-only branches) |
| `--detach` | | Submit the job to the daemon and return immediately with the job_id (no progress stream). For CI/scripted use. |

When the scrybe daemon is running, `scrybe index` routes the job through the daemon queue (serialised writes, no cross-process LanceDB conflicts). Use `SCRYBE_NO_AUTO_DAEMON=1` to force in-process mode.

Incremental deletion: files removed from disk are removed from branch-scoped search after the next incremental run. The underlying LanceDB rows remain as orphans until `scrybe gc` is run.

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

# Submit to daemon and return job_id immediately (CI use)
scrybe index --project-id myrepo --detach
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

**Daemon routing:** When the daemon is running, `scrybe gc` (without `--dry-run`) routes jobs through the daemon queue. This serializes gc with any in-flight reindex jobs on the same project, preventing LanceDB write conflicts. The command also cancels any pending auto-gc jobs in scope and resets idle timers so auto-gc doesn't immediately re-fire. Falls back to direct in-process execution when the daemon is down.

**Auto-GC:** The daemon automatically schedules gc jobs on two triggers — see the [Auto-GC section](#auto-gc) for details.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Limit GC to a specific project (default: all projects) |
| `--dry-run` | | Report orphans without deleting (always runs in-process, never queued) |

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

Example output:

```
[0.842] src/auth/login.ts:12-34 (typescript) · loginUser
  Branches: master, feat/my-feature
export function loginUser(email: string, password: string) {
```

Each hit shows a `Branches: ...` line when the chunk is indexed on one or more branches. The list is sorted master/main first, then alphabetical.

---

### `search knowledge`

Semantic search over indexed knowledge sources (GitLab issues, etc.).

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--source-id <id>` | | Limit to a specific source |
| `--source-types <types>` | | Comma-separated source type filter. Known values: `ticket` (issue bodies), `ticket_comment` (individual comments) |
| `--top-k <n>` | | Number of results (default: 10) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
scrybe search knowledge --project-id myrepo "password reset broken"
scrybe search knowledge --project-id myrepo --source-types ticket "login error"
scrybe search knowledge --project-id myrepo --source-types ticket_comment "architectural decision"
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

**Deprecated** — use `scrybe status` instead. Prints a deprecation notice to stderr, then delegates to `scrybe status`. Will be removed in v2.0.

```bash
scrybe status          # use this instead
scrybe status --watch  # live dashboard
```

---

### `daemon restart`

Stop then start the daemon.

```bash
scrybe daemon restart
```

---

### `daemon install`

Register the daemon as a per-user autostart entry so it starts at login (always-on mode). No admin / sudo required. Platform-specific:

- **Windows** — logon Scheduled Task via `schtasks`; fallback to `HKCU\Software\...\Run`
- **macOS** — `~/Library/LaunchAgents/com.scrybe.daemon.plist` + `launchctl bootstrap`
- **Linux (systemd)** — `~/.config/systemd/user/scrybe.service` + `systemctl --user enable --now`
- **Linux (non-systemd)** — `@reboot` line in `crontab`

The autostart entry sets `SCRYBE_DAEMON_KEEP_ALIVE=1` so the daemon disables its idle-shutdown timers.

| Flag | Required | Description |
|------|----------|-------------|
| `--force` | | Reinstall even if already installed |

```bash
scrybe daemon install
scrybe daemon install --force   # reinstall / repair
```

---

### `daemon uninstall`

Remove the daemon autostart entry. Does not stop a running daemon or delete DATA_DIR.

```bash
scrybe daemon uninstall
```

---

### `daemon ensure-running`

Start the daemon if not running; no-op if already running. Quiet by default (no output). Intended for scripts and autotests that need the daemon up without interactive prompts.

| Flag | Required | Description |
|------|----------|-------------|
| `--verbose` | | Print status to stdout |

```bash
scrybe daemon ensure-running
scrybe daemon ensure-running --verbose
```

---

### `daemon refresh`

Trigger an immediate incremental reindex for a project by posting to the daemon's `/kick` endpoint. Used by git hooks.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Project to kick (default: all projects) |
| `--source-id <id>` | | Limit to a specific source |
| `--branch <name>` | | Branch to reindex (default: current HEAD) |
| `--mode <mode>` | | `full` or `incremental` (default: `incremental`) |

```bash
scrybe daemon refresh --project-id myrepo
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

## Branch commands

Pinned branches are code branches the daemon keeps indexed in the background (via periodic `git fetch` + incremental reindex). Only `code` sources support pinning.

### `branch list --pinned`

Print the pinned branches for a project source.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |

```bash
scrybe branch list --pinned --project-id cmx-ionic
```

---

### `branch pin`

Add one or more branch names to the pinned list. Merges with the existing list (deduped). Emits a warning for unknown remote refs or when the total count exceeds 20. If the daemon is running, newly-pinned branches are backfilled immediately.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |
| `<branch...>` | ✓ | Branch names (positional) |

```bash
scrybe branch pin --project-id cmx-ionic main dev dev-2 dev-3 beta
```

---

### `branch unpin`

Remove specific branch names from the pinned list. Orphaned chunks remain until `scrybe gc` is run.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |
| `<branch...>` | ✓ | Branch names to remove (positional) |

```bash
scrybe branch unpin --project-id cmx-ionic dev-3
```

---

### `branch unpin --all`

Remove all pinned branches for a source. Asks for confirmation unless `--yes` is passed.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | | Source identifier (default: `primary`) |
| `--yes` | | Skip confirmation prompt |

```bash
scrybe branch unpin --all --project-id cmx-ionic --yes
```

---

## Auto-GC

The daemon automatically schedules gc jobs to keep orphan chunks under control. Two triggers:

**Idle trigger:** After `SCRYBE_AUTO_GC_IDLE_MS` (default 5 min) of no queue activity for a project, the daemon checks for orphan chunks before enqueuing. It compares live LanceDB row counts against branch-tag counts for each code source. If all sources are balanced (no orphans), the gc enqueue is skipped — observable as an `auto-gc.skipped` event on the daemon SSE stream. If any source has more LanceDB rows than tagged chunks, or if the check fails (e.g. table locked), gc is enqueued. Timer state is process-memory only — a daemon restart starts a fresh idle window.

**Ratio trigger:** After each `indexSource` job completes, the daemon computes:
```
orphan_ratio = (LanceDB chunk count − tagged chunk count) / LanceDB chunk count
```
If `orphan_ratio > SCRYBE_AUTO_GC_RATIO` (default 15%) **and** no gc has run for that project in the last `SCRYBE_AUTO_GC_RATIO_DEBOUNCE_MS` (default 30 min), a gc job is enqueued. If the last gc for the project **failed**, the debounce is reset immediately so the next ratio check can fire without waiting.

**Auto-gc uses compaction-with-grace** (60s grace window) rather than full-purge. Manual `scrybe gc` uses full-purge compaction.

**Master disable:** Set `SCRYBE_AUTO_GC=0` to disable both triggers. Manual `scrybe gc` and the MCP `gc` tool continue to work regardless.

**Manual gc preempts auto-gc:** When `scrybe gc` or `mcp__scrybe__gc` is invoked, any pending auto-gc jobs in the same project scope are cancelled first, and idle timers are reset, to avoid redundant back-to-back runs.

**Daemon SSE events emitted by auto-gc:**

| Event | When |
|-------|------|
| `auto-gc.scheduled` | Idle or ratio trigger enqueued a gc job |
| `auto-gc.completed` | Auto-triggered gc job finished successfully |
| `auto-gc.failed` | Auto-triggered gc job failed |
| `auto-gc.skipped` | Idle trigger ran orphan check, found none, skipped enqueue |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRYBE_AUTO_GC` | `1` | Set `0` to disable both auto-gc triggers |
| `SCRYBE_AUTO_GC_IDLE_MS` | `300000` | Per-project idle window (ms) before idle gc fires |
| `SCRYBE_AUTO_GC_RATIO` | `0.15` | Orphan-ratio threshold (0–1) for ratio trigger |
| `SCRYBE_AUTO_GC_RATIO_DEBOUNCE_MS` | `1800000` | Min time (ms) between ratio-triggered gcs per project |
| `SCRYBE_LANCE_COMPACT_THRESHOLD` | `10` | Lance version count threshold that triggers compaction |
| `SCRYBE_LANCE_GRACE_MS` | `60000` | Grace window (ms) before `compactTableWithGrace` runs |
| `SCRYBE_NO_AUTO_DAEMON` | — | Set `1` to prevent auto-spawning the daemon |
| `SCRYBE_DAEMON_MAX_CONCURRENT` | `max(1, cpus/2)` | Max simultaneous jobs in daemon queue |
| `SCRYBE_DEBUG_INDEXER` | — | Set `1` to enable verbose indexer diagnostic logging |
