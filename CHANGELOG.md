# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.46.3] — 2026-07-22

### Fixed

- MCP tool calls with invalid, missing, or misspelled arguments now return a specific error naming the offending field — e.g. an unknown `project_ids` suggests `project_id` — instead of a generic `internal error`. Genuine internal faults stay masked.
- `search_code` / `search_knowledge` now surface "project/source not found" and "no matching sources" messages to the caller instead of masking them as `internal error`.

---

## [0.46.2] — 2026-07-19

### Security

- Updated bundled transitive dependencies to their patched releases — **protobufjs** (7.6.x), **ws** (8.21.1) and **fast-uri** (3.1.3) — clearing several known denial-of-service and request-handling advisories. None of these code paths are reachable with untrusted input in scrybe, so the update is precautionary.

### Fixed

- Hardened the background daemon's health check: a malformed port value in the daemon pidfile can no longer shape the internal health-probe request.

---

## [0.46.1] — 2026-07-17

### Fixed

- **Installing or building scrybe from a source checkout no longer stops or replaces your running daemon.** The install hooks previously could not tell a global install from a working copy, so `npm install` in a clone, worktree or CI checkout would shut down whichever daemon you had running and start a replacement from that checkout — against your real index. They now act only on a genuine install; `npm i -g scrybe-cli` and `npx scrybe-cli` are unaffected.
- **A daemon whose own installation was removed underneath it is now detected and replaced automatically.** Previously it stayed up serving `internal error` on every search, status, doctor call and reindex job — while still reporting itself healthy — until someone noticed and restarted it by hand. This could happen when scrybe was installed or reinstalled from a directory that was later deleted (a temporary checkout, a cleared package cache). The daemon now notices its own files are gone and steps aside so the next call starts a working one.

---

## [0.46.0] — 2026-07-16

### Added

- **Temporarily index an unmerged remote branch for review, without pinning it or checking it out.** New `index_ephemeral` MCP tool (and `scrybe index-ephemeral`) fetches an open branch's content into a throwaway index under an `_ephemeral/…` label, so an agent can search a branch's own new code before it merges; `drop_ephemeral` (and `scrybe drop-ephemeral`) then tears it down and reclaims its chunks. The ephemeral index never joins the pinned-branch set and is never refreshed in the background.
- `scrybe index --content-ref <ref>`: index content read from one git ref while storing it under a different branch label.
- The background daemon sweeps leaked `_ephemeral/…` indexes on startup, so a review that ends abnormally can't leave a throwaway index behind.

### Fixed

- Source-scoped garbage collection now works through the background daemon (previously only the in-process path honored a specific source).

---

## [0.45.0] — 2026-07-04

### Added

- Faster vector search on large indexes via a native quantized ANN index, built and maintained automatically in the background (no re-embedding, no manual step), with recall kept on par with exact search. Kicks in above 10,000 rows per source; set `SCRYBE_VECTOR_INDEX=false` to force exact search everywhere instead.

---

## [0.44.1] — 2026-07-04

### Changed

- On Linux, the background daemon now caps glibc malloc arenas, cutting retained memory substantially after sustained search activity. No effect on Windows or musl-based systems; a pre-set `MALLOC_ARENA_MAX` in your environment is always respected.

---

## Older releases

For releases v0.44.0 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.46.3...HEAD
[0.46.3]: https://github.com/siaarzh/scrybe/compare/v0.46.2...v0.46.3
[0.46.2]: https://github.com/siaarzh/scrybe/compare/v0.46.1...v0.46.2
[0.46.1]: https://github.com/siaarzh/scrybe/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/siaarzh/scrybe/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/siaarzh/scrybe/compare/v0.44.1...v0.45.0
[0.44.1]: https://github.com/siaarzh/scrybe/compare/v0.44.0...v0.44.1
