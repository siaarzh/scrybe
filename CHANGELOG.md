# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.47.1] — 2026-08-01

### Security

- Dependency updates carrying published security fixes: **fast-uri** (host confusion from a literal backslash in the URI authority), **tar** (uncontrolled recursion on crafted long-path archives), and **body-parser** (size limits silently ignored when given an invalid value). All three are transitive dependencies, and scrybe does not exercise the vulnerable paths. Precautionary.

### Changed

- Dependency updates: `@modelcontextprotocol/sdk` 1.30.0, `@parcel/watcher` 2.6.0, `ink` 7.1.1, `ignore` 7.0.6.

---

## [0.47.0] — 2026-07-29

### Fixed

- **Only one scrybe daemon can now run per data directory.** Several tools or editor sessions starting at the same moment could each launch their own daemon against the same index — every extra daemon held its own copy of the index in memory, and on one machine four of them together exhausted the host. Startup is now serialised, and a daemon that finds another already responsible for its data directory exits immediately instead of coming up on a second port. Genuinely separate data directories are unaffected.
- **Upgrading the store is now safe when several scrybe processes start together.** The one-time index upgrade deletes and rebuilds files, and could previously run in more than one process at once — including from an ordinary CLI command. Only one process performs it now; the others wait and then re-check.
- **Stopping the daemon no longer leaves the pidfile pointing at a live process**, so the next command can still find and talk to a daemon that is finishing its work.

### Changed

- **`scrybe daemon stop` now exits non-zero when the daemon is still running.** It previously reported success whether or not the daemon had actually stopped, so `scrybe daemon stop && …` would carry on with a live daemon behind it — in one case leaving a daemon indexing unattended until it consumed several gigabytes of memory. Exit `0` now means the daemon is confirmed gone; exit `3` means the stop was accepted but the daemon is still finishing in-flight work; exit `1` means it could not be signalled at all. The 30-minute drain and `--force` are unchanged. Scripts that chain off `daemon stop` and need the daemon gone should use `--force`, or retry on exit `3`.

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

## Older releases

For releases v0.45.0 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.47.1...HEAD
[0.47.1]: https://github.com/siaarzh/scrybe/compare/v0.47.0...v0.47.1
[0.47.0]: https://github.com/siaarzh/scrybe/compare/v0.46.3...v0.47.0
[0.46.3]: https://github.com/siaarzh/scrybe/compare/v0.46.2...v0.46.3
[0.46.2]: https://github.com/siaarzh/scrybe/compare/v0.46.1...v0.46.2
[0.46.1]: https://github.com/siaarzh/scrybe/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/siaarzh/scrybe/compare/v0.45.0...v0.46.0
