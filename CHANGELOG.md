# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **MCP shim mode:** `scrybe mcp` now connects to the daemon via HTTP instead of loading heavy modules in-process. Cold-boot < 500 ms (vs ~8.5 s previously). The daemon must be installed (`scrybe daemon install`) and running.
- **`daemon.installed` doctor row** — checks whether daemon autostart is configured for the current platform. Green if installed, yellow with `run scrybe daemon install` hint if not.
- **`daemon.running` doctor row** — checks pidfile presence and `/health` 200 response. Green if running, yellow/red with `run scrybe daemon start` or `run scrybe daemon restart` hint otherwise.

### Deprecated

- **In-process MCP mode (`scrybe mcp --legacy-in-process`)** is deprecated. Will be removed in v0.34.0. See `scrybe daemon install`.

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

## [0.32.2] — 2026-05-09

### Fixed

- **Migration no longer assigns the code preset to the text slot when only `SCRYBE_CODE_EMBEDDING_*` env vars are set.** When the migration ran on installs that only had code-embedding env vars configured (no `SCRYBE_KNOWLEDGE_EMBEDDING_*`), the synthesized config wrote `text_preset = "migrated-code"`. That's a profile mismatch: code-profile models like `voyage-code-3` are rejected when assigned to a text slot, so any subsequent `scrybe index` against ticket / knowledge sources failed with `preset uses model X with profile "code", but it is assigned to slot "text_preset" which requires profile "text"`. The asymmetric branch now falls back to a `local-default-text` preset (in-process embedder, no network), matching the no-env case. Existing installs hit by this in v0.32.1 can fix manually with `scrybe model preset add` + `scrybe model assign --text <new-preset>`, or delete `config.json` and re-run `scrybe init`.
- **`scrybe doctor`'s `config.well_formed` no longer false-positives on a correctly-configured rerank slot.** The check looked up every assignment slot in `embedding_presets`, including `rerank_preset` — but rerank presets live in `reranker_presets`. A valid migrated config with `rerank_preset = "migrated-rerank"` produced `Unresolved preset references: rerank_preset: "migrated-rerank"` even though the preset existed. The check now routes `rerank_preset` to `reranker_presets` and only the embedding slots to `embedding_presets`.

---

## [0.32.1] — 2026-05-09

### Fixed

- **`assign_preset` MCP tool now correctly reports `requires_reindex: true` when the new preset's `(model, dim, provider)` differs from the previously assigned preset, even when no sources are indexed yet.** The triple-comparison check was nested inside a per-source loop; with no projects registered the loop body never executed and the flag stayed `false`. The preset-level triple comparison now runs unconditionally, with the per-source sidecar scan only kicking in to detect drift between the saved config and indexed table stamps. (v0.32.0 was tagged but not published due to this CI test failure.)

---

## [0.32.0] — 2026-05-09

### Added

- **Catalog-driven embedding presets.** Scrybe now ships a built-in catalog of providers (Voyage AI, OpenAI, Local, Custom) with known models, dimensions, and base URLs. Presets are named configurations stored in `<DATA_DIR>/config.json`. Two global slots — `code` and `text` — replace per-source embedding overrides. An optional `rerank` slot enables result reranking. `${ENV_VAR}` interpolation in credential fields is resolved at read time; a `credentials_from` field lets rerank presets share a key with the embedding preset.
- **`scrybe model` CLI subcommand tree.** New commands for managing embedding configuration: `scrybe model list` (show catalog), `scrybe model show` (current assignments + resolved config with masked credentials), `scrybe model preset add <name>` / `scrybe model preset rm <name>` (create/remove named presets), `scrybe model assign --code|--text|--rerank <preset>` (set slot assignments with profile-compatibility validation), and `scrybe model switch --source-type <code|text>` (drop and fully reindex all matching sources using the current preset, with cost estimate for remote providers).
- **`add_embedding_preset` and `assign_preset` MCP tools.** Agent-facing tools for managing presets without a terminal. `add_embedding_preset` writes a named preset to `config.json`. `assign_preset` updates slot assignments and returns `requires_reindex: true` when the new preset's `(model, dim, provider)` triple differs from the previously stamped triple on any indexed source.
- **Catalog-driven `scrybe init` wizard.** The first-run wizard now prompts for provider (Voyage AI, OpenAI, Local, Custom), derives model and dimension options from the catalog, and supports a Custom-provider branch (base URL → API key → optional `/models` probe → model name → dimensions). Writes `config.json` and provider-keyed env vars (`SCRYBE_VOYAGE_API_KEY`, `SCRYBE_OPENAI_API_KEY`, etc.) to `<DATA_DIR>/.env`.
- **Four new `scrybe doctor` checks.** `config.well_formed` verifies `config.json` parses and all preset references are valid. `config.refs_resolve` verifies every `${VAR}` credential reference resolves against the environment. `config.assignments_complete` verifies both the `code` and `text` slots are assigned. `tables.consistent` verifies each source's indexed `(model, dim, provider)` triple matches the currently assigned preset, flagging sources that need reindexing.
- **`model_mismatch` source-health flag.** When a source's indexed triple differs from the current preset assignment, `scrybe status --json` includes `flags: ["model_mismatch"]` on that source's row. Remediation: `scrybe model switch --source-type <code|text>`.

### Removed

- **Per-source `--embedding-base-url`, `--embedding-model`, `--embedding-dimensions`, `--embedding-api-key-env` flags** on `scrybe source add` and `scrybe source update` are removed. Embedding model selection is now global, managed via `scrybe model` presets. Use `scrybe model preset add` + `scrybe model assign` to configure providers, then `scrybe model switch --source-type <type>` to reindex with a new model.

### Migration

- On first startup after upgrade, scrybe synthesizes a starter `config.json` from existing `SCRYBE_CODE_EMBEDDING_*` / `SCRYBE_KNOWLEDGE_EMBEDDING_*` env vars (creating `migrated-code` and `migrated-text` presets referencing those vars by their existing names). If neither is set, local-embedder presets are created. Any per-source `embedding` overrides in `projects.json` are dropped with a logged warning per source; the resolved global preset takes effect instead. Existing table sidecars are backfilled with model-provenance fields. No chunk IDs are changed and no reindex is forced — run `scrybe doctor` to check if any source shows `model_mismatch`, and use `scrybe model switch` if needed.

---

## [0.31.6] — 2026-05-09

### Added

- **New MCP tool `lookup_symbol`.** Deterministic exact-symbol lookup by name — no embedding, no reranking, no `score` field. Returns all code chunks whose `symbol_name` matches the supplied value, sorted by `(language, item_path, start_line)`. Two match modes: `suffix` (default) matches both bare names and dotted qualified forms (`getName` → `User.getName`); `exact` requires the full stored name. Optional `case_sensitive` override (default `true`). Branch filtering accepts short names or `origin/`-qualified refs interchangeably. Empty-name chunks (sliding-window fallback files, non-first sub-chunks of large declarations) are always excluded. MCP-only — no CLI command.

### Fixed

- **`search_code` and `scrybe search` now accept short branch names for pinned branches.** Passing `branch="dev"` to a project where `dev` was indexed via the pinned-branch path (stored as `origin/dev`) previously returned silently empty results. The server now resolves the supplied name to whichever form is actually indexed — trying the supplied value first, then flipping the `origin/` prefix on or off. Short names (`dev`) and qualified refs (`origin/dev`) are both accepted. If neither form is indexed, the source returns an empty result set (same silent-empty contract as before). Set `SCRYBE_DEBUG_SEARCH=1` to log unresolved branch values.

---


## Older releases

For releases v0.31.5 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.32.4...HEAD
[0.32.4]: https://github.com/siaarzh/scrybe/compare/v0.32.3...v0.32.4
[0.32.3]: https://github.com/siaarzh/scrybe/compare/v0.32.2...v0.32.3
[0.32.2]: https://github.com/siaarzh/scrybe/compare/v0.32.1...v0.32.2
[0.32.1]: https://github.com/siaarzh/scrybe/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/siaarzh/scrybe/compare/v0.31.6...v0.32.0
[0.31.6]: https://github.com/siaarzh/scrybe/compare/v0.31.5...v0.31.6
