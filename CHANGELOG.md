# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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

## [0.32.4] — 2026-05-10

### Added

- **Self-healing for half-extracted `npx -y scrybe-cli` installs.** When Claude Code's MCP probe times out during a cold `npx` install, npm aborts mid-extract and leaves a `~/.npm/_npx/<hash>` tree with empty package directories. Subsequent invocations silently fail with `Failed to connect` because Node can't resolve required dependencies. The MCP entrypoint now detects this state via a `createRequire` landmark check across heavy deps (`@xenova/transformers`, `sharp`, `@lancedb/lancedb`, `apache-arrow`, `@modelcontextprotocol/sdk`, `@parcel/watcher`, `tree-sitter`) and, on a broken install, completes the MCP `initialize` handshake and registers a structured `scrybe_install_incomplete` tool whose description starts with the recovery command. Claude Code's MCP UI then shows the actionable command in the tool list preview instead of an opaque connection failure.
- **`scrybe doctor --repair`** — runs `npm install` inside the half-extracted npx workspace, then re-execs the original command so the user's invocation completes against the now-clean install. Sentinel file + env-var guard against recursion if repair itself fails. Restricted to npx caches (path-walks for an `_npx` ancestor); a no-op on global installs.
- **`env.install_integrity` doctor row** — checks the same landmarks as the MCP entrypoint, surfaced as the first Environment-section check. Warns when one or more landmarks are missing, with a remedy pointing at `scrybe doctor --repair`.

### Changed

- **MCP setup README pivot.** The bare `"command": "npx", "args": ["-y", "scrybe-cli@latest", "mcp"]` snippet has been demoted from the primary example to a "no-config alternative" with a cold-install caveat. `"command": "scrybe"` (assuming a global install via `npm install -g scrybe-cli`) is now the recommended path; the `npx scrybe-cli@latest init` wizard remains the canonical first-step setup. Existing configs continue to work — but on first install, if interrupted, they will now show the `scrybe (install incomplete)` MCP server with a clear recovery command instead of failing silently.
- **`src/index.ts` rewritten to lazy-import the heavy modules (`./mcp-server`, `./cli`, `./jobs`).** Only `node:*` builtins and the new `./install-doctor.js` module are static-imported at process entry, so the install-integrity check can run before any potentially-missing dependency is touched. Without this change, a half-extracted tree would crash Node at module-resolution time before any pre-flight check could fire.

---

## [0.32.3] — 2026-05-10

### Added

- **`env.npm_prefix_writable` doctor check.** Warns when npm's global install dir (`<npm config get prefix>/lib/node_modules`) isn't writable by the current user, with the canonical `~/.npm-global` prefix workaround in the remedy. Skips on Windows (ACL semantics differ in ways `accessSync` can't detect cleanly) and when `npm` isn't on PATH. Catches the case where `npm install -g scrybe-cli` fails with EACCES on Linux installs that use the system-managed Node from apt/yum (root-owned `/usr/lib/`).
- **README "Manual setup" Linux first-install caveat.** Surfaces the same `~/.npm-global` workaround before the `npm install -g` line, so users hit the guidance pre-fail rather than only post-fail via doctor.

---

## Older releases

For releases v0.32.2 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.36.0...HEAD
[0.36.0]: https://github.com/siaarzh/scrybe/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/siaarzh/scrybe/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/siaarzh/scrybe/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/siaarzh/scrybe/compare/v0.32.4...v0.33.0
[0.32.4]: https://github.com/siaarzh/scrybe/compare/v0.32.3...v0.32.4
[0.32.3]: https://github.com/siaarzh/scrybe/compare/v0.32.2...v0.32.3
