# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.12.1...HEAD
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
