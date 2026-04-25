# Daemon

Scrybe can run as a persistent background process that keeps every registered project's index fresh automatically. File-system changes trigger incremental reindex within seconds; git branch switches and remote fetches are handled without any manual command.

---

## How it works

```
scrybe daemon start
        ↓
src/daemon/main.ts          ← long-running process, pidfile, signal handlers
        ↓
src/daemon/http-server.ts   ← HTTP API on 127.0.0.1:58451 (ephemeral fallback)
        ↓ events
@parcel/watcher             ← FS watcher per code source (file changes → reindex)
.git/ watcher               ← HEAD / refs changes → branch-switch + commit reindex
fetch-poller                ← periodic git fetch → pinned-branch SHA delta → reindex
        ↓ jobs
src/daemon/queue.ts         ← concurrency-limited job queue (max(1, cpu/2) active)
        ↓
src/indexer.ts              ← same branch-aware indexer used by the CLI
```

The daemon is a single-process, multi-project orchestrator. It holds one LanceDB and one SQLite (`branch-tags.db`) connection and serializes writes per project. All runtime data stays in the same `DATA_DIR` as the CLI.

---

## Quick start

```bash
# Start the daemon
scrybe daemon start

# Check status (plain JSON)
scrybe daemon status

# Live terminal dashboard
scrybe daemon status --watch

# Stop gracefully
scrybe daemon stop

# Restart (stop + start)
scrybe daemon restart
```

The daemon writes a pidfile at `<DATA_DIR>/daemon.pid` containing `{pid, port, startedAt, version, dataDir, execPath}`. The port is ephemeral if `58451` is taken — clients always read the port from the pidfile.

---

## Pinned branches

By default the daemon only keeps the current HEAD of each project fresh. To also keep specific remote branches up-to-date in the background, pin them:

```bash
# Pin branches for background indexing
scrybe branch pin --project-id cmx-ionic main dev dev-2 dev-3 beta

# List pinned branches
scrybe branch list --pinned --project-id cmx-ionic

# Remove a pin (does NOT delete existing chunks — run scrybe gc to clean up)
scrybe branch unpin --project-id cmx-ionic dev-3

# Clear all pins for a source
scrybe branch unpin --all --project-id cmx-ionic --yes
```

Pinned branches are stored in `projects.json` under each source's `pinned_branches` field. The daemon fetches only those branches (narrow refspec) and queues a reindex whenever a pinned ref advances.

**Limits:** there is no hard cap, but a warning is emitted when a source has more than 20 pinned branches (disk usage + fetch time).

**Backfill:** when you pin a branch that hasn't been indexed yet, the daemon immediately queues a full reindex of that branch. You don't need to run `scrybe index --branch` manually.

---

## Git hooks (opt-in)

Install per-project git hooks so `git commit`, `git checkout`, `git merge`, and `git rebase` instantly kick the daemon:

```bash
scrybe hook install --project-id myrepo
scrybe hook uninstall --project-id myrepo
```

Hooks use a marker-delimited block (`# >>> scrybe >>>` / `# <<< scrybe <<<`) so they're non-destructive on existing hook files. `uninstall` strips only the scrybe block.

The hook line calls `scrybe daemon refresh --project-id myrepo` which reads the pidfile port and POSTs to `/kick`. If the daemon is not running the command exits 0 silently.

---

## Autostart on login

> **Note:** `scrybe daemon install`/`uninstall` (autostart management) are not yet implemented. Planned for v0.20+ as part of the "daemon-always-on" initiative.

For now, start the daemon manually or via your OS task scheduler:

```bash
scrybe daemon start   # foreground — add to OS autostart yourself
```

### Windows

Uses `schtasks /create /sc ONLOGON /it /rl LIMITED /f`. The `/it` flag allows the task to run interactively without UAC. Falls back to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` if `schtasks` fails.

### macOS

Writes `~/Library/LaunchAgents/com.scrybe.daemon.plist` and runs `launchctl load`. The plist includes `ThrottleInterval: 10` to prevent spin-loops on crash.

### Linux

Writes `~/.config/systemd/user/scrybe.service` and runs `systemctl --user enable --now scrybe`. No `sudo` required for user-scoped services.

---

## HTTP API reference (Contract 14)

Base URL: `http://127.0.0.1:<port>` — port discovered from `<DATA_DIR>/daemon.pid`.

All requests and responses use JSON. `/events` is SSE (`text/event-stream`). Unauthenticated on loopback only.

### `GET /health`

```json
{ "ready": true, "version": "0.15.0", "uptimeMs": 12345, "pid": 1234 }
```

### `GET /status`

Full daemon snapshot — see `DaemonStatus` in `src/daemon/http-server.ts`.

Key fields:
- `state`: `"hot" | "cold" | "paused"`
- `projects[].currentBranch` — last resolved HEAD branch
- `projects[].watcherHealthy` / `gitWatcherHealthy`
- `queue.active`, `queue.pending`, `queue.maxConcurrent`
- `recentEvents` — last 10 `DaemonEvent` objects

### `GET /events?since=<ISO>`

SSE stream of `DaemonEvent` objects (`data: {...}\n\n`). The optional `since` query param replays buffered events (ring buffer, last 100) newer than the given ISO timestamp.

Event types: `job.started`, `job.completed`, `job.failed`, `job.cancelled`, `watcher.event`, `state.changed`, `watcher.unhealthy`, `pinned.changed`.

### `POST /kick`

Trigger an immediate reindex. Body is optional:

```json
{ "projectId": "cmx-ionic", "sourceId": "primary", "branch": "main", "mode": "incremental" }
```

All fields optional — omit `projectId` to kick all projects. Returns `{ jobs: [{jobId, projectId, sourceId, branch}] }`.

### `POST /pause` / `POST /resume`

Pause suspends all FS and git watchers (unsubscribes). Resume re-subscribes. Returns `{ state: "paused" }` / `{ state: "hot" }`.

### `GET /projects`

List projects with runtime info: `id`, `rootPath`, `branches`, `lastIndexed`, `watcherHealthy`.

### `POST /shutdown`

Graceful stop: closes HTTP listener, aborts in-flight jobs, flushes log, calls `closeBranchTagsDB()`, removes pidfile, exits 0. Returns `{ state: "stopping" }`.

### Pinned-branches endpoints

```
GET    /projects/:projectId/sources/:sourceId/pinned-branches
POST   /projects/:projectId/sources/:sourceId/pinned-branches
DELETE /projects/:projectId/sources/:sourceId/pinned-branches
```

**GET** — returns `{ branches: string[] }`.

**POST** body: `{ branches: string[], mode?: "add" | "set" }`. Default `mode: "add"` merges; `"set"` replaces. Returns `{ branches, added, warnings }`. Unknown remote refs accepted but listed in `warnings`. Count > 20 also produces a warning.

**DELETE** body: `{ branches: string[] }` to remove specific branches, or `?all=true` query to clear the list. Returns `{ branches, removed }`.

All three persist immediately to `projects.json` and fire a `pinned.changed` SSE event.

Error responses: `400 invalid_source_type` (non-code source), `404 project_not_found`, `404 source_not_found`.

---

## DaemonClient (Contract 15)

`src/daemon/client.ts` exports a typed TS client for use by the VS Code extension (M-D3) and test helpers:

```ts
import { DaemonClient } from "./src/daemon/client.js";

// Discover from pidfile
const client = DaemonClient.fromPidfile();
if (!client) { console.error("daemon not running"); process.exit(1); }

// One-shot calls
const status = await client.status();
await client.kick({ projectId: "cmx-ionic", mode: "incremental" });

// SSE stream
for await (const event of client.watchEvents()) {
  console.log(event.event, event.projectId);
}

client.close(); // abort any open SSE stream
```

---

## Environment variables (Contract 16)

| Variable | Default | Description |
|---|---|---|
| `SCRYBE_DAEMON_PORT` | `58451` | Preferred HTTP port; falls back to ephemeral if busy |
| `SCRYBE_DAEMON_PIDFILE` | `<DATA_DIR>/daemon.pid` | Override pidfile location |
| `SCRYBE_DAEMON_HOT_MS` | `60000` | HOT window duration in ms |
| `SCRYBE_DAEMON_COLD_MULTIPLIER` | `5` | Debounce multiplier in COLD state |
| `SCRYBE_DAEMON_FETCH_ACTIVE_MS` | `300000` | Fetch interval when HOT (5 min) |
| `SCRYBE_DAEMON_FETCH_IDLE_MS` | `1800000` | Fetch interval when COLD (30 min) |
| `SCRYBE_DAEMON_NO_FETCH` | — | Set to `1` to disable the fetch poller entirely |
| `SCRYBE_DAEMON_LOG_LEVEL` | `info` | `debug | info | warn | error` |
| `SCRYBE_DAEMON_FS_DEBOUNCE_MS` | `1500` | FS event debounce (HOT state) |
| `SCRYBE_DAEMON_GIT_DEBOUNCE_MS` | `300` | Git ref debounce |

---

## JSONL log (Contract 18)

The daemon appends every job lifecycle event to `<DATA_DIR>/daemon-log.jsonl`. Each line is a `DaemonEvent` JSON object (same shape as `/events` SSE). The file rotates at 10 MB; up to 2 archives are kept (`daemon-log.1.jsonl.gz`, `daemon-log.2.jsonl.gz`).

External consumers (tray apps, log shippers) can tail this file instead of subscribing to SSE.

---

## Troubleshooting

**Daemon won't start — "already running" but no process:**
The pidfile is stale (process died without cleanup, e.g. SIGKILL). Remove it manually:
```bash
rm "$(node dist/index.js status --project-id any 2>/dev/null | grep dataDir | ...)"
# or just delete <DATA_DIR>/daemon.pid directly
```
On the next `scrybe daemon start`, a stale pidfile is detected (PID not alive + `/health` fails) and cleaned up automatically.

**Search not updating after file change:**
- Check `scrybe daemon status` — `watcherHealthy` should be `true` for the project.
- If `false`, the watcher hit its retry cap. Restart the daemon: `scrybe daemon restart`.
- Verify `@parcel/watcher` has permission to watch the directory (antivirus / OneDrive on Windows can interfere).

**Pinned branch not being indexed:**
- Confirm `scrybe branch list --pinned --project-id <id>` shows the branch.
- Check that a remote named `origin` exists: `git remote -v` in the project root.
- Run `git fetch origin` manually once to establish credentials (the daemon's fetch poller uses whatever credential helper is configured).
- Check daemon logs: `tail <DATA_DIR>/daemon-log.jsonl | jq .` for `warn` entries on the branch.

**High CPU after a large commit:**
Normal — the daemon is indexing. `scrybe daemon status` shows `queue.active`. CPU drops to < 1% once the queue drains.

**Windows: cmd window flashes on login:**
The `schtasks /it` flag should suppress this. If it still flashes, the fallback `HKCU\Run` entry spawns a visible window. File a bug or switch to the `launchd` approach on WSL.

---

## Data flow: file change → search hit

```
File saved in editor
    → @parcel/watcher emits "update" event for rootPath
    → daemon debounces 1500 ms (HOT) / 7500 ms (COLD)
    → coalesces dirty paths into a Set
    → enqueues incremental reindex job
    → indexer: hash changed files → chunker → embedder → LanceDB upsert + branch-tag
    → search_code / scrybe search now returns new content
```

Typical latency: **< 5 s** from file save to searchable in HOT state.

---

## Architecture notes for M-D3 (VS Code extension)

- **Spawn pattern:** extension should spawn `scrybe daemon start` detached (`stdio: "ignore"`, `unref()`). Daemon survives VS Code close.
- **Port discovery:** read `<DATA_DIR>/daemon.pid` for the port; fall back to `SCRYBE_DAEMON_PORT` env var.
- **Focus ping:** POST `/kick` (no body) when the VS Code window gains focus to extend the HOT window.
- **Health check on activation:** if `/health` fails, start the daemon.
- **MCP config:** extension auto-writes `~/.claude.json` `mcpServers.scrybe` entry on first activation.

Cross-stub contracts 14–19 (HTTP surface, DaemonClient, env vars, test helpers, JSONL log, install scripts) are frozen as of v0.15.0 — additions are allowed, field renames/removals require an API version bump.
