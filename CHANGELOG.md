# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.37.0] — 2026-05-24

### Added

- **Local cross-encoder reranker.** Set `SCRYBE_RERANK=true` with `SCRYBE_RERANK_PROVIDER=local` to rerank results in-process via `Xenova/ms-marco-MiniLM-L-6-v2` (~22 MB, no API key, no sidecar). Previously reranking auto-configured only for Voyage AI; non-Voyage setups now have a free local option. Position-aware blending weights the first-stage rank against the reranker score by position, tunable via `SCRYBE_RERANK_BLEND_TOP3` / `SCRYBE_RERANK_BLEND_TAIL`.
- **Per-preset `prompt_template`.** Embedding presets can specify asymmetric `query` / `passage` prefixes. The default local presets now apply the `query: ` / `passage: ` prefixes that the bundled e5 model (`multilingual-e5-small`) is trained for.
- **Per-preset `max_input_tokens`.** Embedding presets can cap input size to the model's context window (default 512 for the local e5 presets). The chunker fits chunks to that budget, so content is no longer silently truncated at the model boundary during embedding.

### Changed

- **Local-embedder users: a one-time reindex is required on upgrade** to apply the new query/passage prefixes and token budget. The daemon auto-enqueues it on next start for sources under 50k chunks; larger sources pause for confirmation (visible via the `queue_status` MCP tool) so you control when the re-embed runs.

---

## [0.36.3] — 2026-05-21

### Fixed

- **MCP shim now auto-starts the daemon on a true cold boot.** v0.36.2 added a 15-second wait at shim startup, but if the daemon wasn't already starting (no autostart installed, no manual `scrybe daemon up`), the shim just waited until the deadline expired and then served the 1-tool placeholder. The shim now uses the same daemon-spawn path as the CLI — it spawns the daemon via a hidden Windows launcher and polls `/health` until ready, then fetches the real manifest. MCP clients get the full tool set on first connect after reboot, with no console flash. Falls back to the placeholder server only when the spawn itself fails (e.g. `SCRYBE_NO_AUTO_DAEMON=1`, containers, missing binary).

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

## Older releases

For releases v0.34.0 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.37.0...HEAD
[0.37.0]: https://github.com/siaarzh/scrybe/compare/v0.36.3...v0.37.0
[0.36.3]: https://github.com/siaarzh/scrybe/compare/v0.36.2...v0.36.3
[0.36.2]: https://github.com/siaarzh/scrybe/compare/v0.36.1...v0.36.2
[0.36.1]: https://github.com/siaarzh/scrybe/compare/v0.36.0...v0.36.1
[0.36.0]: https://github.com/siaarzh/scrybe/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/siaarzh/scrybe/compare/v0.34.0...v0.35.0
