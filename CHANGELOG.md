# Changelog

All notable changes to this project will be documented in this file.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Security

- The image library pulled in by the local embedding stack (`sharp`) is now forced to 0.35.5, which bundles a patched librsvg (CVE-2026-96889). scrybe never decodes images, so the vulnerable code wasn't reachable, but installs no longer ship it. The older copy also downloaded native binaries during `npm install`; the new one doesn't, so about 45 helper packages drop out of the install.

---

## [0.53.2] — 2026-10-18

### Changed

- Calling `search_code` on a project that only has knowledge sources now fails with a message that names `search_knowledge`, and `search_knowledge` on a code-only project names `search_code`. Before, the error only said what was missing. The `error_type` is unchanged.

---

## [0.53.1] — 2026-09-30

### Security

- Updated `hono`, `@hono/node-server`, `qs`, `fast-uri` and `ip-address` to pick up upstream security fixes. Upgrading is recommended.

### Changed

- Updated `@lancedb/lancedb` to 0.37.1. Existing indexes open, search and accept new chunks without a reindex.
- Updated the `openai` client to 7.x. It now keeps full dimensions when an OpenAI-compatible server answers a default request with a plain number array, so those servers no longer need `encoding_format: "float"` to avoid truncated vectors. The setting still works.

---

## [0.53.0] — 2026-09-30

### Added

- Custom embedding presets accept `encoding_format: "float"`, for OpenAI-compatible servers that return plain number arrays instead of base64. It's `--encoding-format float` when creating a preset from the CLI, and an encoding field on the MCP setup tools. Custom setup now probes the dimensions and float output itself, so you don't have to guess them.

### Fixed

- A search across several sources that share an embedding setup now embeds the query once, not once per source.
- `status` and `doctor` report the embedding preset each project is actually assigned. A missing credential variable no longer hides the model details, and it's reported separately from a malformed configuration.
- Provider validation requests the same encoding the runtime uses. A bad float reply now reports an encoding error instead of suggesting the wrong dimensions. Migrating a legacy custom endpoint selects float output.
- Adding a preset under a name that already exists is rejected, instead of silently dropping that preset's hand-written settings.

---

## [0.52.0] — 2026-09-24

### Added

- **MCP over HTTP.** The daemon can serve the standard MCP Streamable HTTP transport at `/mcp`, so a client in a container or on another machine can connect without spawning the stdio server. It is off by default: set `SCRYBE_DAEMON_MCP_HTTP=1` (or `true`). Requests are stateless. Every tool available over stdio is exposed and there is no authentication, so put an authenticating reverse proxy in front of anything beyond the local machine. See [mcp-reference.md](docs/mcp-reference.md#mcp-over-http).
- `SCRYBE_DAEMON_ALLOWED_HOSTS` lets a reverse proxy that forwards its own hostname reach the daemon.

### Security

- The daemon now refuses requests addressed to unexpected host names, any non-GET request from a web page, and any request whose answer a web page could read. Allowed host names are `localhost`, `127.0.0.1` and anything in `SCRYBE_DAEMON_ALLOWED_HOSTS`. Everything else gets `403`. Upgrading is recommended.

---

## [0.51.1] — 2026-08-27

### Fixed

- On Windows, Hyper-V and WSL reserve blocks of TCP ports at boot, and the daemon's usual port can land inside one. It used to refuse to start, with a bare `listen EACCES` and nothing to explain it. It now binds another port and records why it moved, and `doctor` warns when a port it wants has been reserved. Setting `SCRYBE_DAEMON_PORT` still pins the port exactly, so a reserved value there fails rather than falling back, but the message now names the cause.

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

## Older releases

For releases v0.50.0 and earlier, see [GitHub Releases](https://github.com/siaarzh/scrybe/releases) (auto-generated from git tags).

---

[Unreleased]: https://github.com/siaarzh/scrybe/compare/v0.53.2...HEAD
[0.53.2]: https://github.com/siaarzh/scrybe/compare/v0.53.1...v0.53.2
[0.53.1]: https://github.com/siaarzh/scrybe/compare/v0.53.0...v0.53.1
[0.53.0]: https://github.com/siaarzh/scrybe/compare/v0.52.0...v0.53.0
[0.52.0]: https://github.com/siaarzh/scrybe/compare/v0.51.1...v0.52.0
[0.51.1]: https://github.com/siaarzh/scrybe/compare/v0.51.0...v0.51.1
[0.51.0]: https://github.com/siaarzh/scrybe/compare/v0.50.0...v0.51.0
