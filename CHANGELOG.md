# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.42.0] — 2026-06-18

### Added

- **GitHub issues knowledge source.** Index issues and comments from GitHub repositories alongside GitLab. Register with `scrybe source add --type ticket --provider github --project owner/repo --token '${SCRYBE_GITHUB_TOKEN}'`. Same metadata passthrough as GitLab (state, labels, assignees, milestone). Auto-refreshes while the daemon runs. Requires a fine-grained PAT with Issues: Read-only + Metadata: Read-only scope (classic `repo`/`public_repo` also works).
- **Generic provider fields for ticket sources.** New `--provider`, `--url`, `--project`, `--token` flags replace the GitLab-specific `--gitlab-url`, `--gitlab-project-id`, `--gitlab-token`. Old flags still work and warn deprecated. Enables support for multiple providers with a single schema.
- **Environment-variable token references.** Tokens can now be passed as `${VAR}` (e.g. `${SCRYBE_GITHUB_TOKEN}`) and are resolved at fetch/validate time, not at configuration time. Unset variables fail fast with actionable errors. Recommended env var names: `SCRYBE_GITLAB_TOKEN`, `SCRYBE_GITHUB_TOKEN`.
- **Per-ticket-source health checks in `doctor`.** Both CLI and MCP `doctor` tools now report token resolution and authenticated probe status per ticket source, with actionable remediation hints.

### Fixed

- **The background daemon no longer grows unbounded into host swap.** Over a long, session-heavy day the daemon's memory could climb until it pushed the host into swap thrash. It now samples its own memory and, when it crosses a configurable threshold while idle, gracefully self-restarts instead of climbing (`SCRYBE_DAEMON_MAX_RSS_MB`, default 1536; hard ceiling `SCRYBE_DAEMON_MAX_RSS_HARD_MB`, default 3072). Adds a job-queue depth cap with backpressure (`SCRYBE_DAEMON_MAX_QUEUE_DEPTH`, default 1000), richer daemon-log telemetry (periodic memory + per-operation activity samples), and hardened test-sidecar teardown so a crashed test/release run can no longer orphan embedder processes.
- **Ticket sources added while the daemon runs are now picked up by the auto-refresh poller without a restart.** Previously, only sources registered at daemon boot were polled; any source added via `add_source` while the daemon was running was silently ignored until the next restart. Sources removed at runtime now also stop being polled immediately.
- **Removing a source now clears all of its derived state.** The fetch cursor and embedding batch-tuning entries were previously left behind; re-adding a source under the same name could inherit a stale cursor and index nothing (a silent empty source). Removal now wipes the cursor and batch state alongside the existing branch-tag and hash cleanup.

### Changed

- **Deprecated aliases (GitLab fields) still work but warn.** When `--gitlab-url`, `--gitlab-project-id`, or `--gitlab-token` flags are used, a deprecation warning is printed once at daemon start. Migrate to generic fields (`--provider gitlab --url ... --project ... --token`) at your convenience; no breaking change. Literal (non-`${VAR}`) tokens also warn once at daemon start to encourage migration to env-var references.

---

## [0.41.1] — 2026-06-10

### Fixed

- **MCP clients now survive daemon restarts and port changes.** The MCP shim re-resolves the daemon address from the pidfile and safely retries when the connection is refused, instead of failing every call until the client reconnects. The daemon also keeps its previous port across restarts where possible, so running clients rarely notice a restart at all.

---

## [0.41.0] — 2026-06-01

### Added

- **Search results for issues and tickets now include metadata.** Each result row now includes the issue's state (`open` / `closed`), labels, assigned users, milestone, and confidentiality flag — no extra API calls needed. Comments inherit metadata from their parent issue. The metadata arrives as structured fields, so callers can filter, deduplicate, or collapse results programmatically. Existing ticket indexes are backfilled automatically on upgrade.

---

## [0.40.0] — 2026-05-31

### Added

- **Ticket/issue sources now refresh automatically while the daemon is running.** The daemon polls each ticket source on a configurable cadence (15 min HOT / 60 min COLD by default) so issue data stays fresh without manual `scrybe index` commands. A catch-up poll fires immediately when a client reconnects after an idle period. Disable with `SCRYBE_DAEMON_NO_TICKET_FETCH=1`; adjust cadence via `SCRYBE_DAEMON_TICKET_ACTIVE_MS` / `SCRYBE_DAEMON_TICKET_IDLE_MS`.

---

## [0.39.0] — 2026-05-27

### Added

- **Guided setup over MCP — new `init`, `doctor`, and `status` tools.** Configure scrybe's embedding provider, run a full health check, and inspect status entirely from your MCP client — no terminal required. `init` writes config and enqueues an initial index; `doctor` returns structured checks with remediation hints; `status` is a lightweight snapshot. When the daemon is unavailable, the MCP shim now serves these three troubleshooting tools (instead of a single placeholder), so an MCP-only user can diagnose and recover a stuck setup.
- **Visible model-download progress.** The first-run local model download now surfaces as a `downloading-model` job phase with a 0–100 `percent`, pollable via `reindex_status` — instead of a silent call that looked hung. The daemon no longer downloads the model eagerly on startup.

### Fixed

- **`init` no longer blocks on the local model download.** API providers are verified synchronously (fast key + dimension check); the local model download is deferred into the reindex job, so `init` returns promptly and progress shows up via `reindex_status`. A failed local model load surfaces a friendly, classified error on the job instead of a raw stack trace.
- **A cold search no longer silently downloads the model.** Searching before any model is present now fails fast with guidance to run an index (or `init`) first, rather than hanging on a background download.

---

## [0.38.0] — 2026-05-25

### Fixed

- **Long reindexes are no longer killed mid-job.** A daemon started by a CLI command (with no editor/MCP client attached) used to self-terminate on its idle timeout even while a reindex was running, and a graceful shutdown would force-exit after 30s — corrupting a long index. The daemon now keeps running while a reindex is active, and a graceful shutdown waits for it to finish (up to `SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS`, default 30min).
- **Stuck jobs are cleaned up on restart.** A reindex interrupted by a crash or hard kill no longer stays `running`/`queued` forever (which blocked future reindexes). On the next daemon start such jobs are marked `interrupted`, and the next incremental reindex self-heals the data.
- **Vector-search similarity scores now reflect true cosine similarity (previously inflated).** Vector queries use cosine distance; displayed score = `1 - cosine_distance` for all embedding providers, and ranking is now correct even for unnormalized custom-provider vectors. Note: in the default hybrid (vector + keyword) path the displayed score is the rank-based fusion score and is unchanged; the corrected cosine score surfaces in vector-only search and when keyword search returns no matches.

---

## [0.37.1] — 2026-05-25

### Added

- **Model weights now survive reinstalls and npx cache wipes.** Local model weights (embedder + reranker) are stored in `${DATA_DIR}/models/` instead of inside the `@xenova/transformers` package tree. Existing caches are migrated automatically on first daemon start after upgrade — no action needed. Set `SCRYBE_MODEL_CACHE_DIR` to store weights elsewhere (e.g. a shared cache).

### Fixed

- **Reranker no longer silently returns unranked results when its model is unavailable.** When the local cross-encoder model cannot be loaded, scrybe now logs a warning (`[scrybe] reranker model unavailable …; returning non-reranked order`) instead of failing silently.

---

## Older releases

For releases v0.37.0 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.42.0...HEAD
[0.42.0]: https://github.com/siaarzh/scrybe/compare/v0.41.1...v0.42.0
[0.41.1]: https://github.com/siaarzh/scrybe/compare/v0.41.0...v0.41.1
[0.41.0]: https://github.com/siaarzh/scrybe/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/siaarzh/scrybe/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/siaarzh/scrybe/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/siaarzh/scrybe/compare/v0.37.1...v0.38.0
[0.37.1]: https://github.com/siaarzh/scrybe/compare/v0.37.0...v0.37.1
