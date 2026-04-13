# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.7.0...HEAD
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
