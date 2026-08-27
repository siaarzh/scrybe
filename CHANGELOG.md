# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- On Windows, if the daemon's usual port had been reserved by another component (Hyper-V, WSL), it could fail to start with a bare, unhelpful error. It now starts on another port instead, and `doctor` reports when that has happened.

---

## [0.51.0] — 2026-08-13

### Added

- Two settings tune the background watch that upgrades a cold session's tool list: `SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS` (default 2000) and `SCRYBE_MCP_LISTCHANGED_POLL_CEILING_MS` (default 300000).

### Fixed

- **A session no longer loses the scrybe tools when the daemon is cold.** The MCP server used to wait for the daemon before answering the connection handshake. On a cold start that wait could exceed the client's connect timeout, and the session ended up with no scrybe tools and no error saying why. The handshake is now answered immediately, and the daemon is resolved when the tool list is first requested.
- **The tool surface upgrades itself once the daemon is ready.** If the daemon is still starting when a session connects, scrybe serves its offline tools (`status`, `doctor`, `init`) and swaps in the full list as soon as the daemon answers. No reconnect needed. The background watch runs for up to five minutes; a session left idle past that stops being watched, but its next tool call still picks up the change.
- A session talking to a daemon too old for it now notices when that daemon is restarted on a compatible version, instead of staying stuck for the rest of the session.
- Closed a local symlink-based file-write hazard in the Claude Code plugin's search-guard hook: it wrote a marker file to a predictable path in the shared OS temp directory, which could be made to follow a pre-planted symlink onto an arbitrary file.

---

## [0.50.0] — 2026-08-09

### Added

- **The Claude Code plugin now ships a search guard.** When an agent runs a keyword search over issues — `gh search issues`, `gh issue list --search`, `glab issue list -S`, or the GitLab MCP tools that search — the hook refuses it and points at `search_knowledge` instead. Keyword search misses the ticket that words the same problem differently, and an empty result reads exactly like "nothing exists". The miss is silent. That is why this is a hook and not a line in a config file an agent can reason its way past.

  **Listing issues is never refused, with or without a filter.** Listing and semantic search answer different questions, and only one of them has a semantic equivalent. A query made of search qualifiers rather than keywords runs too, as does `--help`.

  It refuses only where Scrybe can actually answer. A repo whose issues are not indexed, and an index older than a day, both run untouched, because refusing them would offer a replacement that cannot help. The refusal keeps no state, so there is no wait to sit out and nothing that expires into an allowance.

  Two softer modes are available per command: a timed wait, or a one-line note attached to the result while the command runs normally. Everything is configurable in `toll.json` in the data directory, including turning it off and adding your own commands. It fails open on any error and costs nothing in model context. See [docs/search-toll.md](docs/search-toll.md).

### Fixed

- **The plugin now actually ships its two skills.** They lived in a directory Claude Code never scanned, so installing the plugin added nothing to a session. The manifest now points at them explicitly.

---

## [0.49.0] — 2026-08-05

### Security

- When a hosted embedding provider returns an error, its response body is logged to help diagnose the failure. If the provider echoed the API key back in that body, the key was written to the log in clear text. The key is now redacted before anything is logged.

### Added

- **Indexing jobs now record their memory use phase by phase.** A new `phase-log.jsonl` in the data directory records, for each stage of an indexing job (scan, diff, chunk/embed/upsert, compaction, and so on), the memory in use when it started, its peak while it ran, the memory left when it finished, how long it took, and how much work it did. Each record is written the moment its stage ends, so a daemon that runs out of memory partway through still leaves behind a trail showing exactly where it was — the previous per-job record was written only on completion, so the jobs that mattered most left nothing at all. The log rotates at 16 MB and keeps 3 backups; set `SCRYBE_PHASE_TELEMETRY=0` to turn it off.

### Fixed

- **Indexing with the built-in offline embedding model no longer spikes to several gigabytes.** The model processes a batch of texts as one rectangle, sized by the longest text in it, so a single long chunk made the whole batch expensive — and the cost of a batch grows with the square of its length. A full reindex of a mid-sized repository peaked around 6,900 MB. Batches are now assembled from texts of similar length and held to a fixed size budget, which caps the peak regardless of what lands in a batch: the same reindex now peaks around 1,250 MB. Long inputs are also cut down before the model sees them, using a limit derived from the model's own; because the model already ignored anything past that limit, the resulting search vectors are unchanged. Set `SCRYBE_LOCAL_EMBED_TOKEN_BUDGET` to trade memory for throughput (default 4096).

  Vectors produced for a batch containing texts of very different lengths shift slightly, because the padding used to square off the old batches perturbed them; the new vectors are measurably closer to what the model produces for each text on its own. Existing indexes stay searchable and need no reindex.

---

## [0.48.0] — 2026-08-05

### Added

- **The daemon now starts under a kernel-enforced memory ceiling on Linux.** A runaway daemon is stopped by the kernel at the moment it asks for the memory, not noticed up to a minute later, and it can no longer take the host down with it. The limit defaults to 4096 MB and is set with `SCRYBE_DAEMON_CGROUP_MAX_MB` (`0` disables it). It applies where a systemd user session is available; on other platforms, in headless containers, and on hosts without systemd the daemon starts exactly as before, uncapped. An always-on service installed by an earlier version keeps its existing unit and stays uncapped until reinstalled with `scrybe daemon install --force`.
- **`scrybe doctor` reports whether the daemon is memory-capped.** For a running daemon it reads the limit actually in force, distinguishing a cap set by scrybe's own unit from one imposed by an ancestor cgroup. With no daemon running it predicts what the next one would get, and explains in plain language why a cap would be missing and what to do about it.

### Fixed

- **A daemon that failed to restart after exceeding its memory ceiling is now forced to exit instead of lingering.** The self-restart could hang partway through, leaving a process that was over budget, no longer watching its own memory, and holding on to the lock the next daemon needs. Such a restart is now given a bounded window and then terminated, so a fresh daemon can take over. Tune the window with `SCRYBE_DAEMON_RSS_GUARD_WATCHDOG_MS` (default 120 s, minimum 90 s) and its per-failure backoff ceiling `SCRYBE_DAEMON_RSS_GUARD_WATCHDOG_MAX_MS` (default 30 min); a healthy restart always completes well within the window.

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

## Older releases

For releases v0.46.3 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.51.0...HEAD
[0.51.0]: https://github.com/siaarzh/scrybe/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/siaarzh/scrybe/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/siaarzh/scrybe/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/siaarzh/scrybe/compare/v0.47.1...v0.48.0
[0.47.1]: https://github.com/siaarzh/scrybe/compare/v0.47.0...v0.47.1
[0.47.0]: https://github.com/siaarzh/scrybe/compare/v0.46.3...v0.47.0
