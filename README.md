<p align="center">
  <img src="assets/banner-1536x512.png" alt="scrybe — code memory for AI agents" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scrybe-cli"><img src="https://img.shields.io/npm/v/scrybe-cli" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://snyk.io/test/github/siaarzh/scrybe"><img src="https://snyk.io/test/github/siaarzh/scrybe/badge.svg" alt="Known Vulnerabilities"></a>
</p>

**Self-hosted code memory with semantic search — no API key required, works fully offline.**

Index your repos and knowledge sources into a local vector database and search them by natural language —
from the CLI or directly inside Claude Code via MCP. A local WASM/ONNX embedder
(`Xenova/multilingual-e5-small`, ~120 MB on first run) is the default; run `scrybe init` to use Voyage AI,
OpenAI, or a custom endpoint instead. No Docker — LanceDB runs in-process.

## Why scrybe?

Ask your agent a natural-language question. scrybe returns the right chunks; Grep can't.

> **"How does incremental reindex decide which files changed?"**
>
> scrybe returns `src/indexer.ts:100-159` at score 0.81 — the exact function that computes `toRemove` and
> `toReindex` from the cursor + `oldHashes` diff. `grep "files changed"` returns 0 hits — the phrase isn't
> in the code, only the *concept* is. Semantic search bridges that gap.

## Quick start

```bash
npx scrybe-cli@latest init
```

The wizard picks an embedding provider, validates any API key, discovers repos, generates `.scrybeignore`
files, and auto-registers the MCP server in `~/.claude.json` / `~/.cursor/mcp.json`.

**Requirements:** Node.js 22.13+. Windows, Linux, and macOS are all tested in CI on every commit.

## Claude Code / MCP integration

Recommended (global install — fastest cold boot):

```bash
npm install -g scrybe-cli
scrybe daemon install     # optional: keep the daemon running at login (no admin needed)
```

```json
"scrybe": {
  "type": "stdio",
  "command": "scrybe",
  "args": ["mcp"]
}
```

Prefer no global install? Use `"command": "npx", "args": ["-y", "scrybe-cli@latest", "mcp"]` (first run
takes ~10s to install). Credentials go in `<DATA_DIR>/.env` (shown by `scrybe doctor`).

### MCP tools

| Tool | Description |
| --- | --- |
| `search_code` | Semantic search over indexed code |
| `search_knowledge` | Semantic search over indexed knowledge (issues, docs) |
| `lookup_symbol` | Exact-symbol lookup by name — deterministic, no embedding cost |
| `list_projects` · `add_project` · `update_project` · `remove_project` | Manage project containers |
| `add_source` · `update_source` · `remove_source` | Manage indexable sources (code repo, issues) |
| `reindex_all` · `reindex_project` · `reindex_source` · `reindex_status` · `cancel_reindex` | Background reindexing |
| `list_jobs` · `queue_status` · `gc` | Job & maintenance ops |
| `list_branches` · `list_pinned_branches` · `pin_branches` · `unpin_branches` | Branch indexing |
| `set_private_ignore` · `get_private_ignore` · `list_private_ignores` | Per-source ignore rules |

Full parameter docs: [docs/mcp-reference.md](docs/mcp-reference.md).

## How it works

```
Claude Code (any project)
    ↕ MCP stdio
scrybe daemon  ──►  LanceDB (embedded, in-process)
                     ├── code_{hash}       ← search_code
                     └── knowledge_{hash}  ← search_knowledge
```

- **AST-aware chunking** — Tree-sitter aligns chunk boundaries to real functions/classes/methods
  (TypeScript, TSX, JS, JSX, C#, Vue, Python, Go, Ruby, Rust, Java). Each chunk carries its enclosing
  `symbol_name`. Unsupported languages fall back to sliding-window chunking.
- **Hybrid search** — BM25 full-text runs alongside vector search, fused with Reciprocal Rank Fusion
  (on by default). On large indexes the vector side is served by a native quantized ANN index, built and
  maintained automatically in the background — fast, with recall on par with an exact scan.
- **Optional reranking** — post-retrieval re-scoring via a reranking provider (e.g. Voyage `rerank-2.5`);
  set `SCRYBE_RERANK=true`.

Data lives in the OS user data dir (`~/.local/share/scrybe/`, `%LOCALAPPDATA%\scrybe\` on Windows,
`~/Library/Application Support/scrybe/` on macOS). Tuning knobs: [docs/configuration.md](docs/configuration.md).

## Knowledge sources

Index non-code sources (GitLab / GitHub issues) into `search_knowledge`, incrementally and cursor-based:

```bash
# GitLab
scrybe source add -P myrepo -S gitlab-issues --type ticket --provider gitlab \
  --url https://gitlab.example.com --project 42 --token '${SCRYBE_GITLAB_TOKEN}'

# GitHub (fine-grained PAT: Issues + Metadata read-only)
scrybe source add -P myrepo -S github-issues --type ticket --provider github \
  --project owner/repo --token '${SCRYBE_GITHUB_TOKEN}'

scrybe index -P myrepo -S github-issues --full
```

Tokens are referenced via `${VAR}` and resolved at fetch time. Knowledge sources can use a separate
embedding model (`SCRYBE_KNOWLEDGE_EMBEDDING_*`). Details: [docs/configuration.md](docs/configuration.md).

## Embedding providers

Scrybe uses an OpenAI-compatible embeddings API. The default is the local offline embedder; point
`SCRYBE_CODE_EMBEDDING_BASE_URL` at a provider to switch. Model/dimensions are auto-detected for known
providers (OpenAI, Voyage AI, Mistral).

```env
# Example — Voyage AI (voyage-code-3, code-optimized, free first 200M tokens)
SCRYBE_CODE_EMBEDDING_API_KEY=pa-...
SCRYBE_CODE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1
```

Changing model/dimensions makes existing indexes incompatible — scrybe detects this and returns repair
instructions (`scrybe doctor --repair`, or `scrybe index -P <id> -S <id> --full`). All embedding vars:
[docs/configuration.md](docs/configuration.md).

## CLI

Projects are containers; sources are the indexable units (a code repo, an issues feed).

```bash
scrybe project add --id myrepo --desc "My project"
scrybe source add -P myrepo -S primary --type code --root /path/to/repo --languages ts,vue
scrybe index -P myrepo -I                                  # incremental index
scrybe search code -P myrepo "authentication login flow"   # search
scrybe status                                              # project/index status
scrybe doctor [--repair]                                   # health check + repair
```

Full command reference: [docs/cli-reference.md](docs/cli-reference.md).

## Background service

The daemon **starts on demand** when Claude Code calls any scrybe MCP tool and shuts down when idle — no
setup needed for basic use. To keep it running between sessions (auto-indexing new commits in the
background):

```bash
scrybe daemon install                     # per-user autostart (no admin)
scrybe hook install -P myrepo             # opt-in: git commit/checkout/merge → instant reindex
scrybe branch pin -P myrepo main dev      # index branches beyond current HEAD
```

Architecture, autostart, and pinned branches: [docs/daemon.md](docs/daemon.md).

## Upgrading & uninstalling

- **Global install:** `scrybe daemon stop && npm install -g scrybe-cli` (exit Claude Code first).
- **npx users:** upgrades are automatic on each new session.
- **Uninstall:** `scrybe uninstall` reverses everything scrybe writes outside the binary (daemon, MCP
  entries, git-hook blocks, DATA_DIR — with timestamped backups), then `npm uninstall -g scrybe-cli`.

## Documentation

| Doc | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Full setup walkthrough, first project, MCP config |
| [CLI reference](docs/cli-reference.md) | All commands and flags |
| [MCP reference](docs/mcp-reference.md) | All tools, parameters, return values, error types |
| [Configuration](docs/configuration.md) | All env vars by category |
| [Daemon](docs/daemon.md) | Background daemon, HTTP API, pinned branches, autostart |
| [Troubleshooting](docs/troubleshooting.md) | Windows AV exclusions, Linux npm prefix, MCP repair |

## Known limitations

- **HTML / CSS / SCSS** and **Kotlin / PHP / Swift** fall back to sliding-window chunking — Tree-sitter
  grammars exist but these have no function/class boundaries wired up, so chunks are positional rather
  than semantic.

## Contributing

See [docs/contributing.md](docs/contributing.md) for running tests locally and adding new ones.

## License

MIT — see [LICENSE](LICENSE).
