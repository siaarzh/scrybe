# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.36.2] — 2026-05-20

### Fixed

- **MCP shim no longer serves only 1 tool after a cold boot.** When Claude Code (or another MCP client) launched the shim before the daemon was reachable, the shim latched onto the `scrybe_daemon_unavailable` placeholder and never re-checked — leaving the client stuck with one tool until manual reconnect. The shim now polls for daemon readiness for up to 15 seconds at startup (configurable via `SCRYBE_MCP_COLD_START_WAIT_MS`) before falling back, so the full tool manifest is served as soon as the daemon comes up.
- **Console windows no longer flash on Windows during normal use.** Daemon `git fetch` / `git rev-parse` invocations from the per-project fetch poller were spawned without `windowsHide: true`, causing a brief CMD window flash on every poll cycle (every few seconds per project). All git invocations now spawn hidden. Install-time `spawnSync` / `spawn` calls got the same treatment for consistency.

---

## [0.36.1] — 2026-05-14

### Fixed

- **CI publish workflow gate.** A test in `tests/cli-shorthand-flags.test.ts` runs the `scrybe` CLI twice serially to compare `scrybe ps` and `scrybe status` output. On cold CI runners each invocation can take 10-15s, pushing the test past vitest's 30s default timeout. Bumped that test's timeout to 60s. v0.35.0 and v0.36.0 were tagged but never reached npm due to this same failure; v0.36.1 is the first npm-published release since v0.34.0 — it bundles everything from v0.35.0 and v0.36.0.

---

## [0.36.0] — 2026-05-14

### Added

- **Voyage AI model catalog expanded.** `voyage-3.5`, `voyage-3.5-lite`, `voyage-4`, `voyage-4-lite`, and `voyage-4-large` are now first-class entries in the provider catalog — visible in `scrybe model list`, accepted by `scrybe model preset add`, and validated on assignment. All five support flexible output dimensions (256 / 512 / 1024 / 2048). Previously `voyage-4` was referenced internally as a default but absent from the validated catalog, so attempting to assign it explicitly would fail validation.

### Changed

- **Default text embedding model for new Voyage AI setups is now `voyage-4`.** When Scrybe synthesizes a starter config from a Voyage API key (first-run wizard or `scrybe init`), the text/knowledge preset now defaults to `voyage-4` instead of `voyage-3`.
- **Auto-upgrade migration for existing Voyage AI installs.** On first startup after this update, if your text embedding preset was auto-defaulted to `voyage-3`, Scrybe upgrades it to `voyage-4` automatically. A stderr message confirms the change and prompts you to run `scrybe model switch --source-type text` to reindex knowledge sources. Presets set explicitly — including an explicit `voyage-3` choice — are left untouched.

---

## [0.35.0] — 2026-05-12

### Changed

- **`add_source` now auto-enqueues a reindex and returns a `job_id`.** Previously, calling `add_source` registered the source but left it unindexed — agents had to separately call `reindex_source` to start indexing. Now `add_source` fires the reindex automatically and returns `{ job_id, status, queue_position? }` in the same shape as `reindex_source`. Poll with `reindex_status` or `queue_status`. If the daemon is unavailable (spawn-failed / health-timeout), the call fails with `error_type: "daemon_unavailable"` and the source is **not** registered (clean failure, no orphaned entries). In opted-out or container environments, an in-process fallback job is used and the source is registered normally.

### Security

- **MCP daemon RPC log injection hardened.** `clientId` and `method` strings (read from request headers / body) are now stripped of CR/LF/control characters before being written to `console.log`, so a malicious MCP client cannot forge fake log lines when logs are pasted in support tickets or issues.
- **MCP daemon RPC error responses no longer echo internal `err.message` by default.** Tool-handler exceptions return a generic `"internal error"` to the client; full message is exposed only when `NODE_ENV=development`. Daemon logs continue to record the full (sanitized) message for local debugging.

---

## [0.34.0] — 2026-05-11

### Added

- **`@lancedb/lancedb` upgraded 0.14 → 0.27.** Apache Arrow stays pinned at ^17. Existing data is read transparently; no migration required. Because the running daemon holds the old lancedb native binding open, upgrading requires a daemon restart (and on Windows, closing IDE / Claude Code sessions first to release the file lock). See README's "Upgrading from v0.33.x to v0.34.0" block for the required sequence.
- **`daemon-version-mismatch` MCP variant.** New variant of the existing `scrybe_daemon_unavailable` tool fires when the shim is v0.34.0+ but the running daemon is still on a pre-0.34.0 version. Tool description front-loads `scrybe daemon stop && scrybe daemon start`, so the recovery dance shows up in Claude Code's MCP UI instead of an opaque "daemon broken" state.

### Changed

- **MCP cold-boot measurement clarified.** Shim mode via `npx -y scrybe-cli@latest mcp` is ~900 ms (mostly npx cache-revalidation overhead). The recommended `"command": "scrybe"` config with a global install measures closer to <500 ms. v0.33.0's CHANGELOG quoted the global-install number without noting the npx caveat.

### Deprecated

- **In-process MCP mode (`scrybe mcp --legacy-in-process`)** remains deprecated. Removal target was previously v0.34.0; pushed to a future minor pending wider shim-mode validation on Linux. Continues to print a stderr warning at boot.

---

## [0.33.0] — 2026-05-10

### Added

- **MCP shim mode.** `scrybe mcp` now connects to the long-running daemon over HTTP instead of loading the embedder, lancedb, tree-sitter, and sharp in-process on every probe. Cold MCP boot drops from ~8.5 s to <500 ms — install latency is permanently off the Claude Code MCP probe path. Daemon owns all heavy modules; the shim's runtime dependency surface is just the MCP SDK plus a small HTTP client. The daemon must be installed (`scrybe daemon install`) and running for the shim to work; if the daemon is unavailable, the shim returns a structured-error tool whose description front-loads the recovery command (`scrybe daemon install`, `scrybe daemon start`, or `scrybe daemon restart` depending on the variant — no pidfile, daemon process dead, or mid-restart).
- **Daemon HTTP surface for MCP traffic.** New `GET /mcp/manifest` returns `{daemon_version, tools}` derived from the existing tool registry. New `POST /mcp/rpc` dispatches tool calls with body `{id, method, params}` and JSON-RPC-style error codes (`-32600` invalid request, `-32601` method not found, `-32603` internal error). An optional `X-Scrybe-Client-Id` header is propagated from the shim heartbeat for per-client logging.
- **Version handshake at MCP `initialize`.** Shim and daemon versions are SemVer-compared. MAJOR mismatch refuses with a single `scrybe_daemon_unavailable` tool whose description points at `scrybe daemon restart`. MINOR / PATCH mismatch logs a stderr warning and exposes the intersection of tools the shim was built knowing about with what the daemon's manifest reports — so a stale daemon doesn't surface tools the shim can't reach, and a newer daemon doesn't surface tools the shim wasn't tested against.
- **`daemon.installed` and `daemon.running` doctor rows.** `daemon.installed` checks whether autostart is configured for the current platform (yellow with a `run scrybe daemon install` hint if not). `daemon.running` checks pidfile presence and `/health` 200 (green when running, yellow / red with a `run scrybe daemon start` or `run scrybe daemon restart` hint when something's off).

### Changed

- **README MCP setup pivot.** The recommended path is now `npm install -g scrybe-cli` → `scrybe daemon install` → MCP config with `"command": "scrybe", "args": ["mcp"]`. The `npx -y scrybe-cli@latest mcp` form still works (and continues to benefit from v0.32.4's install-doctor self-heal) but is documented as a secondary quick-start.

### Deprecated

- **In-process MCP mode (`scrybe mcp --legacy-in-process`)** prints a stderr warning at boot and is scheduled for removal in v0.34.0. Existing setups that relied on the in-process path continue to work for one minor cycle while users migrate to `scrybe daemon install`.

---

## Older releases

For releases v0.32.4 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.36.2...HEAD
[0.36.2]: https://github.com/siaarzh/scrybe/compare/v0.36.1...v0.36.2
[0.36.1]: https://github.com/siaarzh/scrybe/compare/v0.36.0...v0.36.1
[0.36.0]: https://github.com/siaarzh/scrybe/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/siaarzh/scrybe/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/siaarzh/scrybe/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/siaarzh/scrybe/compare/v0.32.4...v0.33.0
