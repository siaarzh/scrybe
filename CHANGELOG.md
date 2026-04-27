# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.26.1] — 2026-04-27

Patch — unblocks the MCP handshake when scrybe is spawned by the Claude Code VS Code extension.

### Fixed

- **`Error loading webview: Could not register service worker: InvalidStateError` on new chats in the Claude Code VS Code extension.** `runMcpServer()` awaited `bootstrapDaemon()` *before* calling `server.connect(transport)`, so the MCP stdio handshake was blocked behind daemon-bootstrap work. Inside bootstrap, `isDaemonRunning()` falls into a 2-second HTTP `/health` probe whenever `pidfile.execPath !== process.execPath` — which is *always* the case when MCP is spawned by VS Code's bundled Node binary against a daemon started by system Node. The resulting ~2 s stall in MCP startup raced with the extension's webview init and left the document in an invalid state for service-worker registration. Fixed by connecting the transport first and running `bootstrapDaemon()` as fire-and-forget afterwards — the handshake is now immediate, daemon spawn/probe happens in the background, and the first heartbeat retries silently until the daemon is up. CLI-spawned MCP (terminal Claude Code) was unaffected because its `execPath` matched the daemon's.

---

## [0.26.0] — 2026-04-26

M-D16 — Bloat UX + Compaction Coverage. Folds in three bugfixes from the post-v0.25.2 fresh-user audit, replaces the misleading "stale Lance versions" footer with an honest at-a-glance HEALTH column, and closes three `maybeCompact` coverage gaps in the vector-store layer. Minor bump because the `ps` human output drops the cryptic VERS column and replaces it with a HEALTH column — soft-breaking for anything that scraped the previous text.

### Added

- **`HEALTH` column in `scrybe ps --all` output.** Each row renders either `Healthy` or `Bloated *`. The asterisk references a footer legend `* run 'scrybe gc' to reclaim disk space` that only appears when at least one source is bloated. Silence = healthy. Replaces the previous `VERS` column (Lance manifest count, internal jargon).
- **Bloat threshold = `2 × SCRYBE_LANCE_COMPACT_THRESHOLD`** (default 20). Fires only when auto-compact has tried but couldn't reclaim — actionable signal, not noise during normal indexing. Tunable via the existing env var (no new var introduced).
- **`flags: string[]` field per source in `scrybe ps --json`.** Bloated source emits `["bloat"]`, healthy source emits `[]`. Additive only; `schemaVersion` stays at `1`. `versionCount` retained for diagnostics.
- **`scrybe gc` final line reports actual reclaimed bytes** — `Done. Reclaimed N.N <unit> across N table(s).` Sourced from `OptimizeStats.prune.bytesRemoved` (real Lance-reported number). Always prints, even when 0 B (steady-state-after-recent-gc case).

### Fixed

- **`scrybe ps` previously warned "stale Lance versions detected" based on total disk size > 100 MB.** This compared total `.lance` directory size against 100 MB and labelled the result "stale" — for users with several indexed projects (1+ GB of legitimate vector data), the warning fired permanently and never went away after `scrybe gc`. Lance also keeps VERS=2 immediately after `optimize({cleanupOlderThan: now})` because the compaction itself writes a new manifest version — that's healthy steady-state, not bloat. The signal was wrong by design; the fix replaces total-size with per-table version count crossing the auto-compact threshold (the only honest cheap signal we can compute without parsing manifests). Surfaced via the new HEALTH column above.
- **Three `maybeCompact` coverage gaps in `src/vector-store.ts`.** The M-D13 invariant was "every write op trailed by `await maybeCompact(table)`". Three callsites violated it: `deleteKnowledgeSource` (line 320), `createFtsIndex` (line 191), and `createKnowledgeFtsIndex` (line 299). Added the missing trailing call in each. Practical impact is small (1-3 missed compaction triggers per index pass, vs hundreds for upserts) but the invariant matters for predictability.
- **`scrybe gc` hangs after prompt response.** `process.stdin.once("data", ...)` resumed stdin (flowing mode) but never paused it. After the once-listener fired, stdin stayed open and kept the event loop alive, so the process never exited even after `Pruned N empty project(s).` printed. Fixed by calling `process.stdin.pause()` inside the data callback before resolving. Same pattern bug fixed in 3 other prompts: `branch unpin --all`, deprecated `pin clear --all`, and zero-arg `scrybe` register-prompt.
- **`scrybe gc` reports orphan counts capped at 10.** `listChunkIds()` in `vector-store.ts` called `.query()...toArray()` without `.limit()`. LanceDB defaults the result-set limit to 10 when none is set, so every source with >10 orphans always reported "10 orphan chunk(s)". Fixed by adding `.limit(Number.MAX_SAFE_INTEGER)` to read all rows.
- **`scrybe projects` falsely flags local-embedder sources as "Not searchable — missing config".** `isSearchable()` in `registry.ts` always demanded `EMBEDDING_API_KEY`/`OPENAI_API_KEY`, even when the source's resolved embedding config has `provider_type === "local"` (in-process Xenova WASM model needs no API key). Searches succeeded but the listing UI showed every source with a red ✗ and a "Requires env var EMBEDDING_API_KEY" line. Fixed by short-circuiting `isSearchable()` to return `{ ok: true }` when `provider_type === "local"`.

### Changed

- **`compactTable(tableName)` now returns `Promise<number>`** (bytes reclaimed) instead of `Promise<void>`. Existing callers in `src/migrations.ts` and tests that ignore the return value are unaffected.
- **`COMPACT_THRESHOLD` is now exported from `src/vector-store.ts`** (was file-private). Used by the CLI to compute the bloat tip threshold without re-parsing the env var.

### Tests

- New `tests/scenarios/bloat-display.test.ts` (Scenario 13) — covers HEALTH column rendering across healthy/bloated/post-gc states, the conditional legend block, the absence of the dropped VERS column, and `ps --json` `flags` field. Also adds two regression assertions for the [Unreleased] bugs that v0.25.2 fixed but no scenario test ever caught: `gc`-prompt-no-stdin-hang and `gc`-orphan-count-not-capped-at-10.
- New `tests/registry-searchable.test.ts` — direct unit coverage of `isSearchable()` for local-provider, api-provider with/without keys, OPENAI_API_KEY legacy fallback, and never-indexed sources.
- Extended `tests/scenarios/gc.test.ts` (Scenario 7) — asserts the new `Reclaimed N <unit> across N table(s)` line in `scrybe gc` output.
- Extended `tests/vector-store.test.ts` — asserts `compactTable` returns a non-negative number, and returns 0 when called on a missing table.

---

## [0.25.2] — 2026-04-26

### Fixed

- **`scrybe gc` hangs after prompt response** — see v0.26.0 entry; fix shipped in v0.25.2 but the regression scenario was added in v0.26.0.
- **`scrybe gc` reports orphan counts capped at 10** — see v0.26.0 entry; fix shipped in v0.25.2 but the regression scenario was added in v0.26.0.
- **`scrybe projects` falsely flags local-embedder sources as "Not searchable — missing config"** — see v0.26.0 entry; fix shipped in v0.25.2 but the unit test was added in v0.26.0.

---

## [0.25.1] — 2026-04-26

### Fixed

- **Scenario 14 (FS-watch roundtrip) flaky on macOS CI** — wrapped in `describe.skipIf(skipOnMacCI)` to mirror the existing pattern in `tests/daemon-fs-watch.test.ts` and `tests/daemon-git-checkout.test.ts`. macOS GH Actions runners cannot reliably deliver FSEvents within the test deadline (already documented in v0.19.0 CHANGELOG: "macOS is best-effort — watcher tests skipped in CI sandbox"). The new scenario shipped without that guard. Test still runs on Linux, Windows, and on local macOS.

---

## [0.25.0] — 2026-04-26

### Added

- **Scenario test harness** (`tests/scenarios/`) — CLI-level tests that spawn the real built binary against a clean DATA_DIR. Catches Commander parsing bugs, output formatting regressions, exit codes, cross-command state, and daemon lifecycle — class of bugs that passed 400+ unit tests undetected.
  - `tests/scenarios/helpers/spawn.ts` — `runScrybe()` / `runScrybeWithStdin()` primitives
  - `tests/scenarios/helpers/repo.ts` — `makeTempRepo()` with `commit()` / `branch()` / `checkout()`
  - `tests/scenarios/serializers.ts` — snapshot redaction (paths, timestamps, sizes, PIDs, ports, versions)
  - 9 scenario files, 48 tests covering: fresh register→index→search, remove→re-add→full (M-D13 Fix 1), Lance bloat threshold (M-D13 Fix 4), migration registry idempotency (M-D13 Fix 6), search `-P` flag collision (M-D13 Fix 3), branch CLI contract, gc cleanup, wizard no-answers, uninstall, daemon on-demand, FS-watch roundtrip, DATA_DIR wipe+restart.
- **`test:scenarios` npm script** — runs `vitest run --config vitest.scenarios.config.ts`; independent of unit suite.
- **`test:all` npm script** — `npm run test && npm run build && npm run test:scenarios` sequential.
- **CI: scenario step added** — GH Actions test.yml runs `npm run test:scenarios` after `npm test` on ubuntu/macos/windows matrix.

---

## [0.24.0] — 2026-04-26

### Breaking

- **`--auto` flag removed.** Bare `scrybe` inside an unregistered git repo now performs the same register-and-index flow directly (no flag needed). Non-TTY and already-registered cases fall back to the hint output as before.

### Added

- **`daemon up`** — new canonical name for `scrybe daemon ensure-running`. `ensure-running` still works as an alias through v0.x.
- **`project rm` / `project delete` / `project ls`** — Commander aliases on `project remove` and `project list`. Same for `source rm`, `source ls`, `source delete`.
- **`project remove <id>` positional** — project id now accepted as a positional arg (`scrybe project rm myrepo`); `--id` flag kept as backward-compat alias. Same for `project update`.
- **`scrybe ps` — aligned columns** — source lines now print as `PROJECT  SOURCE  CHUNKS  SIZE  VERS  LAST INDEXED` with fixed-width padding.
- **`gc` — prune empty projects (C5)** — after chunk-orphan pass + Lance compaction, `gc` offers to remove registry entries with zero sources (interactive confirm in TTY, skipped in non-TTY / with `-P`).
- **`search code/knowledge` missing `-P` hint (C12)** — deprecated bare `scrybe search <query>` without `--project-id` now prints a helpful hint instead of "Project 'undefined' not found".
- **Update-available banner (F1)** — `scrybe ps` / `scrybe status` show a one-line banner when a newer `scrybe-cli` version is available on npm (24 h cache, suppressed by `NO_UPDATE_NOTIFIER=1` or `CI=1`).
- **`scrybe doctor` spinner (D1)** — doctor shows a `@clack/prompts` spinner while running checks; prints summary on completion.

### Fixed

- **Wizard W1** — "Add a repo by path manually?" prompt no longer fires after user chose Skip.
- **Wizard W2** — MCP client "Apply to …" prompts default to **No** (user must opt-in).
- **Wizard W3** — Outro correctly reports "nothing applied" when user declined all MCP prompts.
- **Wizard W4** — MCP client diff blocks now labeled with correct name (Claude Code / Cursor / Codex / Cline / Roo Code) instead of always "Cursor".
- **Wizard W5** — "Restart your agent" hint suppressed when 0 MCP configs were applied.
- **Wizard W6** — All "Restart your editor" messages reworded to "Restart your agent (Claude Code, Cursor, etc.)".
- **Wizard W7** — Always-on prompt checks existing autostart state; offers Keep/Switch-to-on-demand when already enabled.
- **Wizard W8** — ESC during repo multiselect continues wizard instead of cancelling. Explicit "Skip" item added.
- **Doctor D2** — Chunk count now uses `countTableRows` (same as `ps`) instead of `listChunkIds.length`, eliminating the reported discrepancy.
- **Doctor D3 / MCP label** — Doctor MCP section uses correct per-client names (same fix as W4).
- **`project list` readability (C3)** — per-source lines now show `✓` / `○` / `✗` status icon + padded columns. Non-searchable reasons consolidated in a footer block.
- **SQLite ExperimentalWarning suppressed (C1)** — `process.removeAllListeners("warning")` at entrypoint; warning no longer leaks on every CLI invocation.

---

## [0.23.2] — 2026-04-26

### Fixed

- **`--full` reindex is a no-op after `project remove` → `project add`** — `removeProject`/`removeSource` now call `wipeSource` before dropping the LanceDB table. `wipeSource` deletes all `branch_tags` rows and all `hashes/*.json` files for every branch of the removed source. Previously these were left behind, causing `BranchSessionImpl` to snapshot stale `knownChunkIds` on the next full reindex, which made the skip-embed fast-path fire on every chunk → 0 rows written to LanceDB → silent false success.
- **Full-mode session starts with empty `knownChunkIds`** — `BranchSessionImpl` constructor now conditionally pre-fetches: incremental mode reads the existing set (cross-branch dedup), full mode starts with an empty set so that every chunk is treated as new and actually sent to the embedder.
- **`files_reindexed` reported pre-count instead of actual count** — `indexer.ts` previously set `files_reindexed: toReindex.size` (files *scheduled*) before embedding ran. Now `filesReindexed` is a running counter incremented per file only when `newKeyChunks.length > 0` (chunks actually written to LanceDB). This fixes the misleading `"0 chunks indexed, 2 files reindexed"` output.
- **Exit code 2 when files scheduled but 0 chunks written** — `scrybe index` now exits with code 2 (not 0) when `files_reindexed > 0 && chunks_indexed === 0`, distinguishing false success from "nothing to do" (both 0 → exit 0). Affected CI scripts that `|| true` the index command are unaffected; scripts that check `== 0` will now correctly detect the failure.
- **`search code -P <id> <query>` flag collision** — parent `search` command declared `-P` as a short flag, causing Commander to consume it before delegating to the `code`/`knowledge` subcommands. Removed `-P` from parent (kept `--project-id` long form). `-P` on `search code` and `search knowledge` now works correctly.
- **LanceDB table bloat grows unbounded** — `vector-store.ts` now calls `table.optimize({ cleanupOlderThan })` after every `upsert` and row-level `delete` when the version count exceeds `SCRYBE_LANCE_COMPACT_THRESHOLD` (default: 10, hidden env override). A 1-hour grace window protects concurrent daemon readers. `scrybe gc` performs a full-purge compaction (no grace) on all registered tables after removing orphan chunks.

### Added

- **`scrybe ps` bloat columns** — `scrybe status` / `scrybe ps` now shows table size and version count per source: `52,633 chunks · 7.3 GB · 142 versions · last indexed 26m ago`. Footer warning when total exceeds 100 MB: `⚠ 14.2 GB of stale Lance versions detected. Run 'scrybe gc' to reclaim.`
- **Migration registry** — `schema.json` now tracks `migrations_applied` and `last_written_by`. On first post-upgrade start, a `compact-tables-v0.23.2` migration runs once and compacts every existing table (full-purge, no grace). Subsequent starts skip it. Non-destructive: does not bump the schema version, does not wipe hashes or branch-tags.

### Behavior changes

- `scrybe index` exits with code 2 (not 0) when `files_reindexed > 0 && chunks_indexed === 0`. Previously this was a silent false success.

---

## [0.23.1] — 2026-04-26

### Fixed

- **Windows: console-window flashes at session start** — three sources eliminated, net effect 6 → 0 flashes when Claude Code launches the MCP server.
  - `branch-state.resolveBranchForPath` now reads `.git/HEAD` directly (with worktree pointer support) instead of shelling out to `git rev-parse`. Removes one flash per registered code project at daemon boot.
  - `daemon/install/windows`: all `schtasks`/`reg` `spawnSync` calls now pass `windowsHide: true` (defensive — autostart-setup path).
  - `daemon/spawn-detached` on Windows: routes the detached daemon spawn through a tiny `wscript.exe` + auto-generated VBS launcher in `DATA_DIR`. `windowsHide: true` only sets `SW_HIDE`, not `CREATE_NO_WINDOW`, so `node.exe` would still briefly allocate a console; `wscript.exe` is GUI-subsystem (no console allocation) and `Run cmd, 0, False` launches the child fully hidden.

---

## [0.23.0] — 2026-04-25

### Added

- **`noun verb` CLI style** — all entity commands adopt `project add/update/remove/list`, `source add/update/remove/list`, `search code/knowledge`, `job list`, `branch list/pin/unpin`. Old flat-verb names (`add-project`, `add-source`, etc.) still work as deprecated aliases through v0.x — they print a deprecation notice to stderr and will be removed at v1.0.
- **`-P`/`-S` short flags** — short forms for `--project-id` and `--source-id` on all commands that accept them. Other new short flags: `-y` (--yes), `-a` (--all), `-p` (--pinned on branch list), `-I` (--incremental), `-f` (--full).
- **`scrybe daemon refresh`** — renamed from `daemon kick`; `kick` still works with a deprecation notice.
- **`scrybe branch list/pin/unpin`** — new canonical group replacing `pin list/add/remove/clear`; old `pin` group still works with deprecation notices.
- **`SCRYBE_NO_DEPRECATION_WARNING=1`** env var — suppresses all deprecation notices (useful for CI scripts that still use old command names).
- **Shell completion** — `scrybe completion bash|zsh|powershell` prints a completion script.
- **Per-command examples** — all commands have at least one example in `--help` output.
- **`scrybe ps`** — global alias for `scrybe status`.
- **`scrybe projects/sources/jobs/branches`** — documented plural shortcuts for `project/source/job/branch list`.
- **`scrybe source list`** — new command listing all sources across all projects; supports `-P` to filter by project.

### Changed (internal / architectural)

- **Branch-state facade** (`src/branch-state.ts`) — `branches.ts` + `branch-tags.ts` + `hashes.ts` consolidated into one deep module. `withBranchSession(input, fn)` callback API ensures hash + tag updates are always atomic; `knownChunkIds` pre-fetched at session open eliminates the old `preservedFromRemovals` accumulator. Bug fixed by construction: `applyFile(outcome)` makes "save hash without tags" or "save tags without hash" unrepresentable. `closeDB()` replaces `closeBranchTagsDB` for schema migration and test isolation. `hashFile()` moved to `plugins/code.ts` (its only caller).
- **CLI/MCP shared tool layer** (`src/tools/`) — all 19 MCP tools extracted to `src/tools/{project,source,search,reindex,branch}.ts`. Each tool carries spec + handler + cliArgs + cliOpts + formatCli. `cli.ts` and `mcp-server.ts` are now thin registration layers. Every tool defined exactly once; grep for any tool name returns exactly 1 definition site. `cli.ts` 1780 → 864 LOC; `mcp-server.ts` 797 → 167 LOC.

### CLI migration guide (renamed in this release)

All old commands continue to work through v0.x as deprecated aliases. They print a one-line deprecation notice to stderr and exit 0 — existing scripts are unaffected.

| Old | New |
|---|---|
| `scrybe add-project` | `scrybe project add` |
| `scrybe update-project` | `scrybe project update` |
| `scrybe remove-project` | `scrybe project remove` |
| `scrybe list-projects` | `scrybe project list` (or bare `scrybe projects`) |
| `scrybe add-source` | `scrybe source add` |
| `scrybe update-source` | `scrybe source update` |
| `scrybe remove-source` | `scrybe source remove` |
| `scrybe search <q>` | `scrybe search code <q>` |
| `scrybe search-knowledge <q>` | `scrybe search knowledge <q>` |
| `scrybe daemon kick` | `scrybe daemon refresh` |
| `scrybe pin list` | `scrybe branch list --pinned` |
| `scrybe pin add <b>` | `scrybe branch pin <b>` |
| `scrybe pin remove <b>` | `scrybe branch unpin <b>` |
| `scrybe pin clear` | `scrybe branch unpin --all` |

---

## [0.22.0] — 2026-04-25

### Added

- **Always-on mode** — `scrybe daemon install` registers an OS-level autostart entry so the daemon survives across reboots and runs at login without an agent open. Supported on Windows (Task Scheduler, HKCU\Run fallback), macOS (LaunchAgent plist), Linux systemd user units, and Linux cron fallback. The daemon detects the always-on context via `SCRYBE_DAEMON_KEEP_ALIVE=1` set in the launcher script and disables its shutdown timers.
- **`scrybe daemon uninstall`** — removes the autostart entry. Does not stop the daemon or delete data.
- **Wizard always-on prompt** (Step 4.5) — after MCP config, before initial index. Container environments skip the prompt entirely. "No" (default) is a non-destructive decline; on-demand mode continues to work.
- **`scrybe doctor` always-on check** — surfaces install state as `ok`/`skip` (no warn-count increment when not installed).
- **`scrybe status` always-on state** — shows whether autostart is registered even when the daemon is not running.
- **`scrybe uninstall` autostart reversal** — the uninstall plan now includes the autostart entry; `--yes` removes it along with MCP entries, git hooks, and DATA_DIR.

- **On-demand daemon mode** — MCP server now automatically spawns a detached daemon process on startup (when no daemon is running). The daemon stops ~10 minutes after the last agent disconnects, so scrybe's background indexing runs exactly as long as needed without persistent OS-level services.
- **MCP client heartbeat protocol** — MCP server sends a heartbeat to the daemon every 30 s via `POST /clients/heartbeat`. On graceful shutdown (stdin close, stdout error), it sends `POST /clients/unregister` and exits. The daemon tracks live clients and shuts down automatically when all disconnect (configurable grace period).
- **`LifecycleManager`** — daemon-side state machine (`src/daemon/lifecycle.ts`) that tracks heartbeats, prunes stale clients every 30 s, fires a no-client-ever safety timer (15 min), and a grace timer (10 min) after clients drop to zero. All timer thresholds are tunable via undocumented env vars.
- **`scrybe daemon ensure-running`** — new CLI verb; idempotent, quiet by default. Starts the daemon if not running; no-op if already running. `--verbose` prints status. Intended for scripts and autotests.
- **Container detection** (`src/daemon/container-detect.ts`) — detects Docker (`/.dockerenv`, cgroup keywords), Kubernetes, and WSL2 (`WSL_DISTRO_NAME`). Auto-spawn and always-on mode are skipped in containerized environments.
- **Daemon log file** — daemon now appends startup/shutdown messages to `<DATA_DIR>/logs/daemon.log` with size-based rotation (default 10 MB × 3 backups). Path and rotation parameters tunable via undocumented env vars.
- **`SCRYBE_NO_AUTO_DAEMON`** env var (documented) — set to `1` to disable MCP-side auto-spawn. Daemon must be started manually via `scrybe daemon start`.
- **`SCRYBE_DAEMON_KEEP_ALIVE`** env var (documented) — set to `1` to disable the grace and no-client-ever shutdown timers (always-on mode). Set automatically by OS-level autostart entries (M-D11.2).
- **`scrybe status` lifecycle fields** — daemon section now shows active client count, mode (`on-demand` / `always-on`), and grace-period countdown when applicable.

---

## [0.21.0] — 2026-04-25

### Added

- **Auto-tuned embedding batch sizing** — scrybe now auto-tunes embedding batch size to your codebase and provider combination. No manual `EMBED_BATCH_SIZE` tuning required. When a provider returns HTTP 400/413 (batch too large), scrybe halves the batch, retries, and converges to the right size via bounded binary search across runs. State is persisted per `(project, source, provider, model)` in `DATA_DIR/embed-batch-state.json`. `EMBED_BATCH_SIZE` remains as an initial ceiling, defaulting to 100.
- **MCP tool annotations** — all 17 MCP tools now carry MCP 2025-03 behavioral hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Spec-compliant clients use these to decide presentation and auto-confirmation behavior.
- **`applyMcpMerge` backup safety** — `scrybe init` now creates a timestamped backup (`<file>.scrybe-backup-<epoch>`) before modifying any existing MCP config file. First-ever creation (no existing file) is unchanged.
- **`tests/helpers/backup-contract.ts`** — reusable `expectBackupCreated` / `expectNoBackupCreated` test helpers for verifying backup behavior across any install surface.

---

## [0.20.1] — 2026-04-25

### Fixed

- **`scrybe daemon status` regression** — M-D8's delegation via `statusCmd.parseAsync` caused `daemon status` to emit the human-readable `scrybe status` header (`Scrybe v0.20.0 ...`) instead of the expected plain-text / JSON output. Rewrote `daemon status` action to call daemon helpers directly: offline → prints `"Daemon is not running."`; online → prints raw `DaemonStatus` JSON. Tests on all three platforms now pass.
- **macOS CI no longer `continue-on-error`** — the three failing tests were a Windows/Linux/macOS regression (not macOS-specific). With the above fix all platforms are green; dropped the non-blocking flag so macOS failures are now build-blocking.

---

## [0.20.0] — 2026-04-25

### Added

- **`scrybe uninstall`** — single command that completely reverses everything scrybe writes to the filesystem: stops the daemon, removes MCP entries from all 5 detectable client configs (Claude Code, Cursor, Codex, Cline, Roo Code), strips scrybe blocks from all registered repo git hooks, and deletes DATA_DIR. Shows an action plan with backup paths before executing. Flags: `--dry-run` (plan only, no changes), `--yes` (skip confirmation prompt). All user-file modifications create timestamped backups (`<file>.scrybe-backup-<epoch>`).
- **`scrybe status` (unified)** — without `--project-id`, shows a combined health layout: daemon state (● running / ○ not running) + registry summary (chunk count + last indexed per source). Flags: `--json` (machine-readable, `schemaVersion: 1`), `--projects` (registry only, hide daemon), `--all` (show all projects, no truncation), `--watch` (live Ink dashboard; requires daemon). `--project-id` retains the existing single-project JSON behavior.
- **`src/util/backup.ts`** — `createBackup(path)` helper used by uninstall and hook removal.
- **`countTableRows(tableName)`** in `src/vector-store.ts` — efficient LanceDB row count for status display.

### Changed

- **`scrybe daemon status`** — deprecated alias for `scrybe status`. Prints a deprecation notice to stderr, then delegates. Will be removed in v2.0.
- **`scrybe hook uninstall`** — now creates timestamped backups of hook files before modifying them. Output includes backup paths.
- **`scrybe daemon start`** error message updated to reference `scrybe status`.

---

## [0.19.0] — 2026-04-25

### Added

- **`llms-install.md`** — non-interactive install guide for AI coding agents (Cline, Roo Code, Codex). Covers Node prerequisites, CLI-based project registration, and per-agent MCP settings file paths.
- **README "Why scrybe?" section** — concrete semantic-search-vs-Grep example using this repo's own `src/indexer.ts`.
- **`onProgress` callback on `IndexOptions`** — `ProgressReport` events (`embed_start`, `embed_batch`, `embed_done`) expose `bytesTotal`, `filesTotal`, `bytesEmbedded`, `filesEmbedded`, `chunksIndexed`, `batchBytes`, and `batchDurationMs` for progress rendering.
- **Wizard indexing progress** — `scrybe init` shows `[N/M] project — X% · ~Ys remaining` updating per embed batch. Percentage is file-count based (no overshoot from chunk overlap). Falls back to chunk count when file totals are unavailable.
- **Doctor fresh-install profile** — `scrybe doctor` reclassifies `data.schema_version`, `data.lancedb`, `data.branch_tags_db`, and per-source `last_indexed` from `warn` to `ok` immediately after `scrybe init` before any index has run.
- **Skip-root outro** — when user picks "I'll add projects manually" at the root-selection prompt, the wizard exit shows copy-paste `add-project` / `add-source` / `index` commands instead of the generic agent-first message.
- **Cross-platform CI** — test matrix now runs on Ubuntu, Windows, and macOS on every push. macOS is best-effort (watcher tests skipped in CI sandbox); Windows and Linux are fully gated.
- **GitHub issue templates** — structured bug report and feature request forms at `.github/ISSUE_TEMPLATE/`.

### Changed

- **`scrybe init` root selection** — wizard prompts "Where are your projects stored?" before discovery. Options: VS Code auto-detect, manual directory, or skip. Hardcoded `~/repos`, `~/code`, etc. removed from `defaultRoots()`.
- **`scrybe init` exit message** — agent-first CTA: "restart your editor, then ask your agent". `scrybe search` no longer mentioned.
- **Editor-restart warning** — `p.log.warn` shown immediately after MCP config is written, before the index step.
- **Wizard step labels** — removed `/N` count suffix to avoid drift when steps change.
- **`--skip-index` renamed to `--register-only`** (`scrybe init --register-only`). No deprecation alias — the flag had no published users.

---

## [0.18.0] — 2026-04-23

### Added

- **Claude Code plugin** — install via `/plugin install https://github.com/siaarzh/scrybe`. Ships `.claude-plugin/` manifest and `plugins/scrybe/skills/scrybe/SKILL.md`. The skill guides Claude to call `search_code` instead of `Grep` for conceptual questions, `search_knowledge` for ticket/issue context, and defines `/scrybe` slash command to trigger incremental reindex of the current repo.
- **Codex MCP auto-registration** — `scrybe init` now detects `~/.codex/config.toml` and writes `[mcp_servers.scrybe]` TOML block. Preserves all other TOML tables. Minimal inline TOML reader/writer — no new dependency.
- **Cline MCP auto-registration** — `scrybe init` detects VS Code's Cline extension config (`saoudrizwan.claude-dev` globalStorage) on Windows, macOS, and Linux, and writes a scrybe entry in JSON.
- **Roo Code MCP auto-registration** — `scrybe init` detects Roo Code extension config (`rooveterinaryinc.roo-cline` globalStorage) and writes a scrybe entry in JSON.
- **CI-based npm publish** — `.github/workflows/publish.yml` publishes to npm automatically on any `v*` tag push. Requires `NPM_TOKEN` secret set in GitHub repo settings (use an npm Automation token — bypasses 2FA by design).

### Changed

- `McpClientType` union expanded from `"claude-code" | "cursor"` to include `"codex" | "cline" | "roo-code"`. Fully backward-compatible — `detectMcpConfigs()` still detects claude-code and cursor first, new clients appended.
- `scrybe init` MCP registration step automatically includes Codex, Cline, and Roo Code when their config files are present — no wizard changes needed.

---

## [0.17.1] — 2026-04-23

### Fixed

- **Empty-string env vars no longer break local provider resolution.** When `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, or `OPENAI_API_KEY` was set to empty string (`""`) in a `.env` file or MCP `env` block, `config.ts` previously propagated the empty string to `@xenova/transformers`, which silently fell back to its own default model (`all-MiniLM-L6-v2` instead of the intended `multilingual-e5-small`). New `envStr()` helper in `config.ts` coerces `""` to `undefined` so fallback chains work correctly. Two regression tests added.

---

## [0.17.0] — 2026-04-23

### Added

- **Local offline embedder** — `src/local-embedder.ts` production module via `@xenova/transformers`. Pipeline-cached per model ID; exports `embedLocalBatched`, `embedLocalQuery`, `warmupLocalEmbedder`. No API key, no network call after first model download.
- **`validateLocal(modelId)`** — new function in `src/onboarding/validate-provider.ts`. Loads the local pipeline and runs a test inference; returns dimensions and cold-start time. Used by wizard and doctor.
- **Embedder benchmark harness** — `tests/embedder-bench/` (reusable script + corpus + queries). Ran 5 WASM/ONNX candidates; winner: `Xenova/multilingual-e5-small` (384d, 100% P@5, 100% cross-lingual, cold-start 7 s). Results in `tests/embedder-bench/README.md`.

### Changed

- **Default embedding provider is now local (offline)** — no API key or signup required on a fresh install. New installs that have no `EMBEDDING_*` environment variables or `OPENAI_API_KEY` automatically use `Xenova/multilingual-e5-small` (384d, ~120 MB download on first use). Existing users with `EMBEDDING_*` env vars set are **unaffected** — their provider is detected and used unchanged.
- **`scrybe init` wizard defaults to local provider** — Step 1 now asks "Use an external provider?" (default: No). Choosing No validates the local embedder and writes `SCRYBE_LOCAL_EMBEDDER` + `EMBEDDING_DIMENSIONS` to `DATA_DIR/.env`. Choosing Yes enters the existing Voyage / OpenAI / Mistral / Custom flow.
- **`scrybe doctor` handles local provider** — `provider.key_present` is `ok` (not `fail`) for local provider. `provider.auth` calls `validateLocal()` and reports cold-start time. No false positives on fresh installs.
- **Reranking only offered for Voyage AI** — `ProviderDefaults` now carries `supports_rerank?: boolean`; only Voyage AI has it set to `true`. Wizard never surfaces a rerank prompt unless the user explicitly selected Voyage in the advanced provider path.
- **`@xenova/transformers`** moved from `devDependencies` to `dependencies` (pinned `~2.17.2`). Installing `scrybe-cli` globally now includes the local embedder.
- **`resolveProvider(undefined)` returns `null`** (was: OpenAI defaults). Callers now check `SCRYBE_LOCAL_EMBEDDER` / API key presence to decide the default. Existing behaviour for all configured installs is unchanged.
- **`EmbeddingConfig`** gains optional `provider_type?: "api" | "local"`. Absent = `"api"` (fully backward-compatible with persisted configs).

---

## [0.16.0] — 2026-04-23

### Added

- **`scrybe init`** — interactive first-run wizard (`@clack/prompts`). Guides through provider selection, API key validation (live test embedding), repo discovery (walks `~/repos`, `~/code`, etc.), `.scrybeignore` generation, MCP auto-registration for Claude Code (`~/.claude.json`) and Cursor (`~/.cursor/mcp.json`), and optional initial index. Re-running on a configured machine short-circuits already-completed steps. Credentials written to `DATA_DIR/.env` (now included in config search path).
- **`scrybe doctor`** — one-shot diagnostic command. Checks DATA_DIR, Node version, provider config and auth (live test embedding), dimensions match, schema version, projects.json integrity, LanceDB directory, branch-tags.db, per-source last-indexed/chunk-count, daemon pidfile and HTTP health, git hook presence, and MCP configuration for all detected clients. Exit code 1 on failures; `--strict` also exits 1 on warnings. `--json` outputs a stable `DoctorReport` (schemaVersion: 1) for machine consumption.
- **`scrybe --auto`** — zero-config mode. Run `scrybe --auto` in an unregistered git repo to quickly add it as a project with default settings and run incremental index. Requires TTY or exits with a hint to use `scrybe init`.
- **`src/onboarding/` module layer** — reusable, UI-free modules forming the stable contract between the CLI wizard and future VS Code extension: `mcp-config.ts` (detect/diff/merge MCP config files atomically), `validate-provider.ts` (test-embed + error classification), `repo-discovery.ts` (home-dir walk with depth/time/dir caps), `scrybeignore.ts` (.gitignore merge + standard skip list generator), `language-sniff.ts` (extension-histogram language detection).
- **51 new tests** — unit tests for all onboarding modules (mcp-config: 14, validate-provider: 9, scrybeignore: 5, doctor: 16) plus E2E wizard tests (7) using mocked `@clack/prompts` verifying registry writes, `.scrybeignore` generation, and credential storage.
- **`DATA_DIR/.env` config path** — `scrybe init` writes credentials to `<DATA_DIR>/.env`. Config loader now checks this path as a fallback so credentials persist across working directories.

### Changed

- npm package renamed from `scrybe` to `scrybe-cli` (brand and binary name `scrybe` unchanged). The `scrybe` package name on npm is owned by an unrelated documentation tool; `scrybe-cli` avoids the conflict while keeping the product identity intact.
- `README.md` setup section rewritten — `npx scrybe-cli init` is now the canonical first step; manual setup preserved as secondary path.

---

## [0.15.0] — 2026-04-22

### Added

- **Daemon shell (Phase 1)** — `scrybe daemon start|stop|status|restart` CLI commands. The daemon writes a pidfile (`<DATA_DIR>/daemon.pid`) with `{pid, port, startedAt, version, dataDir, execPath}`, registers SIGTERM/SIGINT handlers for graceful shutdown, and keeps the event loop alive. `daemon start` exits 1 if a daemon is already running. `daemon stop` is Windows-safe: removes the pidfile itself if the process's signal handler didn't (Windows `TerminateProcess` skips Node.js signal handlers).
- **Pinned branches** — `scrybe pin list|add|remove|clear` CLI commands and `list_pinned_branches`, `pin_branches`, `unpin_branches` MCP tools. Per-source allowlist of branch names the daemon will index in background (Phase 2+). Code sources only; warns at >20 entries. Stored in `projects.json` as `pinned_branches` on each source.
- **Daemon HTTP API (Phase 2)** — daemon now binds an HTTP server on `127.0.0.1:58451` (ephemeral fallback if port busy). Port is written to the pidfile so clients discover it automatically. Endpoints: `GET /health`, `GET /status`, `GET /events` (SSE), `POST /kick`, `POST /pause`, `POST /resume`, `POST /shutdown`, `GET /projects`, and full `GET|POST|DELETE /projects/:id/sources/:sid/pinned-branches` CRUD. `DaemonClient` TS class (Contract 15) exported for use by VS Code extension (M-D3).
- **Daemon job queue (Phase 3)** — `POST /kick` now dispatches jobs through a concurrency-limited queue (`max(1, cpu/2)` active jobs; per-project serialization). Job lifecycle events (`job.started`, `job.completed`, `job.failed`, `job.cancelled`) are emitted to SSE clients and written to a durable JSONL log (`<DATA_DIR>/daemon-log.jsonl`) with automatic 10 MB rotation.
- **Daemon status dashboard (Phase 9)** — `scrybe daemon status --watch` launches a live Ink terminal dashboard: state badge (HOT/COLD/PAUSED), uptime, port, version, per-project table (watcher health, current branch, queue depth, last indexed), scrolling SSE events feed, and `q`/`p`/`r` keybindings (quit / pause-resume / reindex-all). `scrybe daemon status` (no flag) prints a plain JSON dump of `/status`. React and Ink are lazy-imported so startup time is unaffected on all other commands.
- **Daemon git hooks (Phase 8)** — `scrybe hook install|uninstall` CLI commands. `install` appends a marker-delimited block (`# >>> scrybe >>>` / `# <<< scrybe <<<`) to `.git/hooks/post-commit`, `post-checkout`, `post-merge`, and `post-rewrite`; creates hook files with `#!/bin/sh` shebang if they don't exist. `uninstall` strips only the scrybe block, leaving other hook content intact. Idempotent: re-installing a hook with the block already present is a no-op. New `scrybe daemon kick` CLI command reads the pidfile port and POSTs to `/kick`, enabling the git hook to trigger the daemon without depending on any shared state beyond the pidfile.
- **Daemon fetch poller + pinned-branch reindex (Phase 6)** — daemon now periodically runs `git fetch origin --prune` for each project and queues an incremental reindex whenever a pinned branch advances (SHA delta detection before/after fetch). Backfill on startup: any pinned branch not yet present in branch-tags.db is queued immediately. Concurrent-fetch cap of 2; exponential back-off on error. New env vars: `SCRYBE_DAEMON_FETCH_ACTIVE_MS` (default 5 min), `SCRYBE_DAEMON_FETCH_IDLE_MS` (default 30 min), `SCRYBE_DAEMON_NO_FETCH=1` to disable. Indexing a non-HEAD branch (remote-tracking ref) now reads file content from git objects via `scanRef` rather than the working tree.
- **Daemon git ref watcher (Phase 5)** — daemon now also subscribes on each project's `.git/` directory (resolves worktree symlinks and gitdir files). Watches `HEAD`, `refs/heads/**`, `refs/remotes/**`, `packed-refs`, `FETCH_HEAD`. On any change, debounces 300 ms then checks current branch via `resolveBranchForPath()`. Branch-switch detected → `branchChanged=true` in SSE event; new commit detected → same incremental reindex. `/status` now returns live `currentBranch`, `watcherHealthy`, and `gitWatcherHealthy` per project from cached watcher state. New env var: `SCRYBE_DAEMON_GIT_DEBOUNCE_MS`.
- **Daemon FS watcher + idle state (Phase 4)** — daemon now subscribes to each registered project's code source root via `@parcel/watcher`. File-system changes are debounced (1500 ms HOT / 7500 ms COLD) and coalesced into a single incremental reindex job per project. HOT/COLD idle state machine transitions the daemon between active and low-activity modes (60 s hot window, 5× debounce multiplier in cold state). `.gitignore` and `.scrybeignore` rules are respected via post-filter. `watcher.event` and `watcher.unhealthy` SSE events emitted on change and on subscription failure (with 10-retry exponential back-off). New env vars: `SCRYBE_DAEMON_FS_DEBOUNCE_MS`, `SCRYBE_DAEMON_HOT_MS`, `SCRYBE_DAEMON_COLD_MULTIPLIER`.
- **Daemon documentation + test helpers (Phase 10)** — new `docs/daemon.md` covering architecture, HTTP API reference (Contracts 14–19), pinned branches, git hooks, autostart on all three platforms, and troubleshooting. `tests/helpers/daemon.ts` exports `startTempDaemon` / `waitForIdle` / `waitForEvent` (Contract 17) for integration tests that need a live daemon. `docs/cli-reference.md` extended with `daemon`, `hook`, and `pin` command sections. `README.md` gains a "Running as a background service" quickstart.
- **Daemon acceptance tests (Phase 11)** — `tests/daemon-acceptance.test.ts` covers: FS watcher unhealthy detection (unit, mocked queue), git watcher skip on non-git directory, and HTTP `/status` reflecting `watcherHealthy` state (integration, real daemon child process with pre-seeded `projects.json`). 108 tests total, all passing.
- **Pinned-branch MCP tools** (`list_pinned_branches`, `pin_branches`, `unpin_branches`) documented in `docs/mcp-reference.md`.

---

## [0.14.1] — 2026-04-22

### Changed

- **`branch_tags` is now code-source-only.** Non-code sources (GitLab issues, future webpage/message sources) no longer participate in the branch-tag side-store. Fixes an architectural conflation in v0.14.0 where branch-filtering (a code-source concept) and GC tracking (a universal concept) were coupled into one table via a `"*"` sentinel. Existing v0.13.x ticket chunks remain valid with no reindex required — only code sources need the v0.14.0 migration reindex.
- **`scrybe gc` now skips non-code sources.** An "orphan" for tickets/webpages/messages is an upstream deletion that can't be detected from local state alone; that's a different operation (future `scrybe reconcile` command — tracked in backlog). Running `gc` was previously dangerous for un-migrated ticket sources because their chunks would appear as orphans and be deleted wholesale.
- **`list_branches` (MCP) and `status --project-id <id>` (CLI) now return `["*"]` explicitly for non-code sources** instead of reading from `branch_tags` (which will be empty for them after v0.14.1).

### Fixed

- Users upgrading from v0.13.x no longer have to refetch all GitLab issues just to satisfy the v0.14.0 migration. Saves ~2 hours of API calls on a multi-project install.

---

## [0.14.0] — 2026-04-22

### Added

- **Branch-aware indexing** — code sources maintain separate chunk sets per branch. `scrybe index --branch <name>` indexes a specific git ref; defaults to current HEAD. Enables side-by-side indexing of `main` + feature branches.
- **Branch-aware search** — `scrybe search --branch <name>` and `search_code(branch?)` filter results to chunks tagged for that branch. Defaults to current HEAD.
- **`scrybe gc` command** — removes orphaned LanceDB chunks (chunks no longer referenced by any branch tag). Run after deleting long-lived branches. Supports `--dry-run` and `--project-id`.
- **`list_branches` MCP tool** — returns the list of indexed branches per source for a project. Useful before calling `search_code` with an explicit `branch`.
- **`branch` param on `reindex_project` / `reindex_source` MCP tools** — optional; indexes the specified git ref instead of current HEAD.
- **`branches_indexed` in `scrybe status`** — shows which branches have been indexed per source.
- **SQLite branch-tag side-store** (`branch-tags.db`) — maps `(project, source, branch, file_path)` → `chunk_id`. Enables cross-branch chunk sharing and GC.
- **Per-branch hash files** — `hashes/<project>__<source>__<branch-slug>.json`; branches track their own incremental state independently.
- **Rename detection** — renaming a file on the same branch no longer triggers re-embedding; content-addressed IDs + preserved LanceDB rows enable the fast path.

### Changed (BREAKING)

- **Content-addressed chunk IDs** — `chunk_id` is now `sha256(projectId + NUL + sourceId + NUL + language + NUL + content)` instead of a hash of file path + line numbers. Identical content in the same project/source always produces the same ID regardless of where it lives in the file system (enables rename detection and branch dedup). **Full reindex required on upgrade** — existing chunk IDs are incompatible with the new formula.
- Scrybe now requires **Node.js ≥ 22.5.0** (up from ≥ 20) — uses the built-in `node:sqlite` module for the branch-tag side-store (no `better-sqlite3` native dependency needed).

See [docs/migration-v0.14.md](docs/migration-v0.14.md) for the upgrade guide.

---

## [0.13.1] — 2026-04-22

### Added

- **Test infrastructure** — `npm test` runs the full pipeline offline using a local WASM embedder sidecar (`@xenova/transformers`, `Xenova/all-MiniLM-L6-v2`, 384-dim). No API keys or network required. Covers: registry → chunker → embedder HTTP → LanceDB upsert → FTS → hybrid search → result shape. Includes smoke test, dimension-mismatch detection test, and retry/backoff test.
- **`SCRYBE_EMBED_RETRY_DELAY_MS` env var** — overrides the initial 5 s retry delay in the embedder. Primarily for tests; useful in production environments that want faster or slower backoff.
- **`resetEmbedderClientCache()` export** from `src/embedder.ts` — purges the internal OpenAI client cache; used by the test harness.
- **GitHub Actions CI** (`.github/workflows/test.yml`) — runs on ubuntu-latest, Node 20, caches the HuggingFace model between runs.
- **`docs/contributing.md`** — documents test setup, sidecar architecture, per-test isolation rationale, cross-stub contracts, and example test patterns.

---

## [0.13.0] — 2026-04-15

### Added

- **`source_type: "ticket_comment"`** — one knowledge chunk per GitLab issue comment with its own author, timestamp (`note.created_at`), and deep-link URL (`{issue_url}#note_{id}`). `search_knowledge` can now filter with `source_types: ["ticket_comment"]` for comments only or `["ticket"]` for issue bodies only.
- **`search-knowledge --source-types`** CLI flag — comma-separated filter by source type, e.g. `--source-types ticket_comment`. Replaces the previous singular `--source-type` flag.

### Changed

- `gitlab-issues` plugin emits separate chunks for issue body (`source_type: "ticket"`) and each non-system comment (`source_type: "ticket_comment"`). Previously all comments were concatenated into the issue's chunk and lost per-comment authorship, timestamps, and deep links. **Recommended:** full reindex of any project with a ticket source to benefit (`scrybe index --project-id <id> --source-ids gitlab-issues --full`).

---

## [0.12.1] — 2026-04-15

### Fixed

- **`scrybe --version`** was returning `0.2.0` (hardcoded). Now reads the actual version from `package.json`.
- **`gitlab_token` leak** — `update_source` MCP response was echoing the full source config including the GitLab token. Token is now redacted to `"[redacted]"` in the response.
- **`embeddingConfigError` surfaced** — unknown embedding provider / missing `EMBEDDING_MODEL` was silently ignored. Now raises a clear error at the start of any operation that needs embeddings (`search_code`, `search_knowledge`, `reindex_project`, `reindex_source`, `reindex_all` via MCP; `index`, `search`, `search-knowledge` via CLI). Non-embedding operations (`list_projects`, etc.) are unaffected.
- **SIGTERM/SIGINT graceful shutdown** — Ctrl+C or `kill` now aborts all running index jobs cleanly before exiting, preventing orphaned background tasks.
- **`error_type` on unmapped MCP errors** — the catch-all error path now sets `error_type: "file_system"` (ENOENT/EACCES/etc.), `"data_corruption"` (malformed JSON/manifest), or `"internal"` (everything else). Previously returned no `error_type`, making programmatic error routing impossible.

---

## [0.12.0] — 2026-04-14

### Added

- **Per-source job model** — reindex jobs now contain an ordered `tasks[]` array, one per source. Each task tracks `status` (`pending | running | done | failed | cancelled`), `phase`, `files_scanned`, `chunks_indexed`, `started_at`, `finished_at`, and `error` independently. `reindex_status` returns the full plan so callers know what was requested, what's in progress, and what's done.
- **`list_jobs` MCP tool** — list all background reindex jobs without a `job_id`, like `docker ps`. Accepts optional `status` filter (`running`, `done`, `failed`, `cancelled`).
- **`scrybe jobs` CLI command** — same as `list_jobs` for the terminal. `--running` flag to show only active jobs.
- **Source-level cancellation** — `cancel_reindex` now accepts an optional `source_id` to cancel a single pending/running task without aborting the whole job.
- **Concurrent reindex guard** — submitting a second reindex for the same project while one is running now returns `error_type: "already_running"` with the existing `job_id` instead of launching a competing job.
- **`--source-ids` CLI flag** — replaces `--source-id`; accepts a comma-separated list (e.g. `--source-ids primary,gitlab-issues`) to reindex multiple specific sources in one command.
- **`package.json` publish metadata** — added `author`, `license`, `repository`, `homepage`, `bugs`, `keywords`. Changed `prepare` → `prepublishOnly`.
- **`LICENSE`** — MIT license file added.

### Changed

- `reindex_project` MCP tool: added `source_ids` array parameter. Required when `mode: "full"` — passing `full` without `source_ids` now returns `error_type: "invalid_request"`. Omit for incremental reindex of all sources.
- `cancel_reindex` MCP tool: added optional `source_id` parameter.
- CLI `index` command: `--full` now requires `--source-ids` (prevents accidental destructive reindex). Default mode is now correctly `incremental` (was incorrectly defaulting to `full` when no flag was given).
- README restructured: AST chunking and knowledge sources sections moved above the fold. All `node dist/index.js` examples replaced with `scrybe` / `npx scrybe`.
- `docs/cli-reference.md`, `docs/getting-started.md` updated to use `scrybe` command.

### Fixed

- Atomic `projects.json` writes — registry now writes to `.tmp` then renames, preventing corruption on crash. Windows `EEXIST` rename handled correctly.
- Chunker infinite loop guard — `SCRYBE_CHUNK_OVERLAP >= SCRYBE_CHUNK_SIZE` now throws at startup instead of hanging.
- GitLab 404 skip-and-continue — deleted issues no longer abort the entire ticket scan; each 404 is logged and skipped.

---

## [0.11.1] — 2026-04-14

### Changed

- `docs/configuration.md` — added `SCRYBE_SCAN_CONCURRENCY` env var (missing since v0.9.0) and full `.scrybeignore` reference section
- `docs/getting-started.md` — added optional `.scrybeignore` setup step

---

## [0.11.0] — 2026-04-14

### Added

- `.scrybeignore` file support — place in repo root to exclude additional files from indexing (gitignore syntax). Negation patterns (`!path`) can override `.gitignore` exclusions and hardcoded skip lists (`SKIP_DIRS`, `SKIP_FILENAMES`, etc.) to force-include any file.

---

## [0.10.0] — 2026-04-14

### Added

- GitLab token validation on source add — `add-source` (CLI) and `add_source` (MCP) now verify the token against the GitLab API before persisting; invalid/expired tokens surface immediately instead of at reindex time
- Default skip patterns: `vendor/` directory, auto-generated C# files (`.g.cs`, `.designer.cs`, `.Designer.cs`, `.generated.cs`)

### Fixed

- Embedding API errors now include the raw error message from the provider (e.g. Voyage, OpenAI) instead of re-throwing with no body; errors also carry the original cause via `{ cause }`

---

## [0.9.0] — 2026-04-14

### Added

- `index --all` CLI flag — incrementally reindexes all registered projects in one command; continues on per-project error, reports failures at the end
- `reindex_all` MCP tool — background job equivalent of `--all`; poll with `reindex_status`, exposes `current_project` field while running
- `SCRYBE_SCAN_CONCURRENCY` env var — controls file hash concurrency in scan phase (default: 32)

### Changed

- `index --project-id` is now optional when `--all` is specified
- `reindex_status` returns aggregate `projects` array (per-source `last_indexed`) for `reindex_all` jobs

### Performance

- Code scan phase: file hashing parallelized (32 concurrent streams via `Promise.allSettled`) — ~2x speedup on large repos
- GitLab issues scan: cursor-based `updated_after` filter — only fetches issues changed since last run instead of all issues every time; **15x total reindex speedup** on warm runs (e.g. 62s → 4s for 6 projects)

### Fixed

- `reindex_all` MCP job continues processing remaining projects when one project fails (previously exited on first error)
- CLI warns when `--all` is combined with `--project-id` or `--source-id` (ignored flags)

---

## [0.8.0] — 2026-04-13

### Fixed

- GitLab issues plugin: incremental reindex no longer purges all previously-indexed issues. `scanSources` now always fetches the full issue list; the cursor-based `updated_after` filter was redundant (the hash diff already handles "what changed") and caused every incremental run to delete everything not updated since the last index.
- Indexer: per-key checkpointing — each source key (file or ticket) has its hash saved immediately after it is embedded and stored. Interrupted reindex runs now resume from the last checkpoint instead of restarting from scratch. Also adds delete-before-insert per key to prevent duplicate LanceDB rows from prior interrupted runs.

---

## [0.7.0] — 2026-04-09

### Added

- `update-source` CLI command — patch an existing source's config without remove/re-add (e.g. `--gitlab-token` to rotate a token, `--root` / `--languages` for code sources, embedding overrides)
- `update_source` MCP tool — same capability for MCP clients; returns the updated source object

---

## [0.6.3] — 2026-04-09

### Changed

- README rewritten to reflect multi-source architecture (v0.6.0+): updated How it works diagram, CLI section, Knowledge sources section, and MCP tools table
- Added `docs/` reference folder: `getting-started.md`, `cli-reference.md`, `mcp-reference.md`, `configuration.md`

---

## [0.6.2] — 2026-04-09

### Fixed

- Knowledge source indexing no longer requires `SCRYBE_TEXT_EMBEDDING_API_KEY` when `EMBEDDING_API_KEY` is already set — `api_key_env` now falls back to `EMBEDDING_API_KEY` automatically

---

## [0.6.1] — 2026-04-09

### Fixed

- Full reindex now correctly clears old vectors before re-embedding: delete functions in `vector-store.ts` were silently no-oping when the LanceDB table wasn't in the in-process cache (always the case in a fresh CLI run), causing `table.add()` to pile up duplicates instead of replacing data

---

## [0.6.0] — 2026-04-09

### Added

- **Multi-source project model**: projects are now logical containers with `sources[]`; each source gets its own isolated LanceDB table so a full reindex of one source never touches another project's data
- Per-source LanceDB table naming: `{prefix}_{sha256(project:source:model:dims).slice(0,12)}` — immutable once assigned
- Auto-migration: flat-model `projects.json` files are migrated on first load (source `id: "primary"`)
- New MCP tools: `add_source`, `remove_source`, `reindex_source`
- `search_knowledge` gains `source_id` and `source_types` filter params
- `list_projects` now shows per-source searchability and `last_indexed`

### Changed

- Hashes and cursors re-keyed to `{project_id}__{source_id}`
- `embedding-meta.ts` removed — superseded by per-source table naming (no more global mismatch detection needed)

---

## [0.5.5] — 2026-04-07

### Fixed

- Full reindex (`mode=full`) now deletes only the target project's data instead of resetting the entire table — previously wiped all other projects' indexed data
- Embedding config mismatch is now detected before a full reindex begins, surfaced as `embedding_config_mismatch` MCP error type, preventing silent data corruption
- Error messages for embedding config mismatch now include the correct recovery path (delete LanceDB folder)

---

## [0.5.4] — 2026-04-07

### Fixed

- Full reindex of ticket sources (GitLab issues) now correctly clears the cursor before scanning, so all issues are fetched instead of returning 0 results

---

## [0.5.3] — 2026-04-06

### Fixed

- Voyage AI default text embedding model corrected to `voyage-4` (was incorrectly set to `voyage-3`)

---

## [0.5.2] — 2026-04-06

### Fixed

- `search_knowledge` auth error when using a minimal config (`EMBEDDING_API_KEY` + `EMBEDDING_BASE_URL` + `SCRYBE_RERANK=true`) — text embedding config now inherits `EMBEDDING_BASE_URL` and resolves the correct provider model/dimensions instead of defaulting to OpenAI
- Added `textModel` field to provider defaults (`voyage-4` for Voyage AI) so knowledge search uses the right model automatically
- Improved rerank warning message when `SCRYBE_RERANK=true` is set but the provider doesn't support auto-configured reranking

---

## [0.5.1] — 2026-04-05

### Added

- `last_indexed` field on `Project` — stamped with an ISO timestamp after each successful index run; visible in `list-projects` CLI output and `list_projects` MCP tool
- MCP server version now read from `package.json` at runtime (was hardcoded `0.2.0`)
- `remove_project` MCP tool — unregister a project without dropping to the CLI
- `.tsx` files now parsed with the TSX tree-sitter grammar (was incorrectly using the TypeScript grammar)
- `reindex_status` response includes `last_indexed` timestamp when job status is `"done"`

---

## [0.5.0] — 2026-04-05

### Added

- **Knowledge indexing**: Scrybe can now index non-code sources (GitLab issues, and future: webpages, Telegram) alongside code
- `search_knowledge` MCP tool — semantic search over knowledge sources (issues, docs, messages); separate from `search_code`
- `search-knowledge` CLI command
- Plugin architecture: `src/plugins/` — each source type is a self-contained plugin (`SourcePlugin` interface); static registry in `src/plugins/index.ts`
- `src/plugins/gitlab-issues.ts` — indexes GitLab issues + comments; paginated, cursor-based incremental updates; rate-limit safe (50 ms between issues)
- `src/cursors.ts` — persists `updated_after` cursor per project in `DATA_DIR/cursors/`
- `add-project --type ticket` CLI — registers a GitLab issues project (`--gitlab-url`, `--gitlab-project-id`, `--gitlab-token`)
- `update-project --gitlab-token` CLI — token rotation without re-registering
- `SCRYBE_TEXT_EMBEDDING_BASE_URL / _MODEL / _API_KEY / _DIMENSIONS` env vars — separate embedding profile for knowledge sources (default falls back to code embedding config)
- Tree-sitter AST chunking for 11 languages: TypeScript, TSX, JavaScript, JSX, C#, Vue, Python, Go, Ruby, Rust, Java — chunks now align with function/class/method boundaries instead of arbitrary line windows
- `symbol_name` field in code chunks populated with actual function/class name (was always `""` before)
- Sliding-window fallback for unsupported languages and parse failures — no regression on existing indexed repos
- **Two LanceDB tables**: `code_chunks` (existing, unchanged) and `knowledge_chunks` (new) — separate schemas, no migration of existing data required
- Two named embedding profiles (`code` / `text`) with independent provider config

### Changed

- Code indexing path migrated to plugin architecture (`src/plugins/code.ts`); external behavior unchanged

---

## [0.4.0] — 2026-04-04

### Added

- Hybrid search: BM25 full-text search (LanceDB FTS) runs in parallel with vector search, merged via Reciprocal Rank Fusion (RRF) — improves recall for exact identifier and keyword queries, and prevents markdown docs from outranking code files
- `SCRYBE_HYBRID` (default `true`) — set to `false` to revert to vector-only search
- `SCRYBE_RRF_K` (default `60`) — RRF rank-sensitivity constant
- FTS index automatically rebuilt at the end of every index job (full and incremental)
- Graceful fallback to vector-only if FTS index not yet built (first run before indexing)
- `chunk_id` added to `SearchResult` — now surfaced in MCP `search_code` responses

### Changed

- `searchCode()` pipeline: vector + FTS (parallel) → RRF merge → optional rerank
- Both arms over-fetch when reranking is enabled so the reranker sees the full fused candidate pool

---

## [0.3.0] — 2026-04-04

### Added

- Reranking support via `SCRYBE_RERANK=true` — post-retrieval re-scoring improves result relevance
- `src/reranker.ts`: Voyage-compatible reranker client (`POST /rerank`, native fetch)
- `src/search.ts`: unified `searchCode()` pipeline — embed → vector search → optional rerank
- Voyage `rerank-2.5` auto-detected when `EMBEDDING_BASE_URL` points to Voyage (same API key, no extra config)
- Custom reranker support via `SCRYBE_RERANK_BASE_URL` + `SCRYBE_RERANK_MODEL`
- `SCRYBE_RERANK_FETCH_MULTIPLIER` (default 5) — controls candidate pool size before reranking
- `.env.example` documented with all reranking env vars

### Changed

- MCP `search_code` and CLI `search` both now go through `searchCode()` — reranking is transparent to callers

---

## [0.2.0] — 2026-04-03

### Added

- Voyage AI (`voyage-code-3`, 1024d) embedding support — code-optimized, now the active default
- Multi-provider config: OpenAI, Voyage, Mistral, and any OpenAI-compatible self-hosted endpoint
- `src/providers.ts`: known providers table — auto-resolves model + dimensions from `EMBEDDING_BASE_URL` hostname
- Unknown provider discovery error — points to `/models` endpoint
- Dimension mismatch detection — immediate error with fix hint after first API call
- Embedding config mismatch detection (`embedding-meta.json`) — blocks search after provider switch until full reindex
- Rate limit retry/backoff in embedder (5 attempts, exponential backoff from 5s)
- Rich MCP structured error types: `rate_limit`, `auth`, `dimensions_mismatch`, `unknown_provider`, `embedding_config_mismatch`

### Changed

- Env vars renamed from `SCRYBE_EMBEDDING_*` to `EMBEDDING_*` (brand-agnostic, OpenAI fallback supported)

---

## [0.1.0] — 2026-04-01

### Added

- Full rewrite from Python/Qdrant/FastAPI to Node.js/TypeScript/LanceDB
- LanceDB embedded vector store (no Docker required)
- MCP server with 7 tools: `search_code`, `reindex_project`, `reindex_status`, `cancel_reindex`, `list_projects`, `add_project`, `update_project`
- Two-pass incremental indexer: hash scan → embed only changed files
- Background job queue with `AbortController` cancel support
- Per-file SHA256 hash tracking for incremental reindex
- Commander CLI: `add-project`, `index`, `search`, `status`, `remove-project`
- Overlapping chunk strategy with configurable size and overlap
- `SCRYBE_CHUNK_SIZE` / `SCRYBE_CHUNK_OVERLAP` tuning vars

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/siaarzh/scrybe/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/siaarzh/scrybe/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/siaarzh/scrybe/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/siaarzh/scrybe/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/siaarzh/scrybe/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/siaarzh/scrybe/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/siaarzh/scrybe/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/siaarzh/scrybe/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/siaarzh/scrybe/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/siaarzh/scrybe/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/siaarzh/scrybe/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/siaarzh/scrybe/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/siaarzh/scrybe/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/siaarzh/scrybe/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/siaarzh/scrybe/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/siaarzh/scrybe/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/siaarzh/scrybe/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/siaarzh/scrybe/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/siaarzh/scrybe/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/siaarzh/scrybe/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/siaarzh/scrybe/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/siaarzh/scrybe/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/siaarzh/scrybe/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/siaarzh/scrybe/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/siaarzh/scrybe/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/siaarzh/scrybe/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/siaarzh/scrybe/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/siaarzh/scrybe/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/siaarzh/scrybe/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/siaarzh/scrybe/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/siaarzh/scrybe/releases/tag/v0.1.0
