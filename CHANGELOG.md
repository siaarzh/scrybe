# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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

## [0.44.0] — 2026-07-03

### Changed

- Dependency updates. Refreshed the vector-store engine (LanceDB), the daemon HTTP layer (Hono), the terminal UI stack (Ink, Clack prompts), build/test tooling, and CI actions. The LanceDB update stays backward-compatible with existing on-disk indexes — no reindex required.
- Updated the CLI argument parser (Commander). No change to any command, flag, or output.

### Fixed

- **Corrected the minimum Node.js version to 22.13.0** (previously documented as 22.5.0). scrybe relies on the built-in `node:sqlite` module, which is only available without an experimental flag from Node 22.13.0 onward — so scrybe could not actually run on Node 22.5–22.12. Update Node to 22.13 or newer.

---

## [0.43.1] — 2026-07-01

### Fixed

- **The background daemon now restarts cleanly after crossing its memory ceiling.** Previously the automatic restart couldn't take over from the old process — leaving search unavailable for minutes, or the daemon stuck until manually killed. A restarting daemon now health-checks the previous one, replaces it promptly if it's unresponsive, and exits without blocking on a long shutdown drain.

---

## [0.43.0] — 2026-06-26

### Changed
- Pinned branches are now indexed under their plain name (e.g. `dev`) rather than a qualified `origin/dev` label. The remote-tracking ref is still the content source — it is just no longer used as the stored label — so a pinned branch stays fresh under one consistent name. A one-time migration rewrites any existing qualified labels on startup.

### Fixed
- Code deleted upstream on a pinned branch no longer lingers in search results: an incremental reindex now removes chunks for files deleted on the remote, so searches can't surface code that no longer exists.

---

## Older releases

For releases v0.42.0 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.46.0...HEAD
[0.46.0]: https://github.com/siaarzh/scrybe/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/siaarzh/scrybe/compare/v0.44.1...v0.45.0
[0.44.1]: https://github.com/siaarzh/scrybe/compare/v0.44.0...v0.44.1
[0.44.0]: https://github.com/siaarzh/scrybe/compare/v0.43.1...v0.44.0
[0.43.1]: https://github.com/siaarzh/scrybe/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/siaarzh/scrybe/compare/v0.42.0...v0.43.0
