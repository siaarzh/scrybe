# MCP Reference

All tools are exposed via the `scrybe` MCP server. Call `list_projects` first to confirm what's indexed before searching.

## Setup tools

### `status`

Return a quick scrybe status snapshot: config present, daemon running, embedding provider/model, and API key presence. Lightweight, read-only — does not validate credentials. Use `doctor` for a full health check with remediation advice.

No parameters.

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Scrybe version |
| `config_present` | boolean | `true` when `config.json` exists and is well-formed |
| `daemon_running` | boolean | `true` when the daemon pidfile exists and the process is alive |
| `daemon_pid` | number \| null | Daemon PID when running |
| `daemon_port` | number \| null | Daemon HTTP port when running |
| `daemon_version` | string \| null | Daemon version reported by `/health`, or `null` when not reachable |
| `code_provider_type` | string | Embedding provider for code sources: `"local"` or `"api"` |
| `code_model` | string | Embedding model for code sources |
| `text_provider_type` | string | Embedding provider for knowledge sources: `"local"` or `"api"` |
| `text_model` | string | Embedding model for knowledge sources |
| `api_key_present` | boolean | `true` when an embedding API key is configured |
| `config_error` | boolean | `true` when the provider is misconfigured |
| `config_error_message` | string \| null | Error details when `config_error` is `true` |

---

### `doctor`

Run a full scrybe health check and return a structured report. Covers install integrity, Node version, `DATA_DIR`, embedding provider config and auth, data integrity (schema version, LanceDB tables, `branch-tags.db`), registered project freshness, daemon status, git hooks, fetch-poller sync, and MCP config. Each check includes an optional `remedy` field with actionable fix instructions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `section` | string | | Limit returned checks to a specific category. Examples: `"Daemon"`, `"Embedding Provider"`, `"Data Integrity"`. Omit to return all checks. |

**Returns:** `DoctorReport & { healthy: boolean }`

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | 1 | Report format version |
| `generatedAt` | string | ISO timestamp |
| `scrybeVersion` | string | Scrybe version |
| `platform` | string | OS and Node version string |
| `checks` | `CheckResult[]` | Ordered list of check results |
| `summary` | object | `{ ok, warn, fail, skip }` counts |
| `healthy` | boolean | `true` when there are no `fail`-status checks |

Each `CheckResult`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable check identifier |
| `section` | string | Category the check belongs to |
| `title` | string | Short check name |
| `status` | `"ok"` \| `"warn"` \| `"fail"` \| `"skip"` | Result |
| `message` | string | Human-readable detail |
| `remedy` | string \| undefined | Actionable fix instructions (present on `warn` and `fail` checks) |
| `data` | object \| undefined | Additional structured data |

---

### `init`

Configure scrybe embedding providers and enqueue an initial index of all registered projects. Writes `config.json` and `.env`, then submits a reindex job for every registered project and returns a `job_id` to poll with `reindex_status`. If scrybe is already configured, returns `status: "already_configured"` without overwriting unless `reconfigure: true` is passed.

**Validation is per provider.** API providers (`voyage`, `openai`, `custom`) are verified synchronously — a bad key returns `status: "validation_failed"` immediately. The `local` provider is **not** verified synchronously: its model download and load are deferred into the reindex job, so `init` returns promptly instead of blocking on a multi-MB download. Poll `reindex_status` — a cold local model first reports a `"downloading-model"` phase, and a load failure surfaces a friendly error on the job rather than a synchronous `validation_failed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code_provider` | `"local"` \| `"voyage"` \| `"openai"` \| `"custom"` | ✓ | Embedding provider for code sources. `"local"` uses the bundled offline model — no API key required. |
| `code_model` | string | | Model for code sources. Defaults to the provider's recommended code model when omitted. |
| `code_api_key` | string | | API key for code provider. Required for `voyage`, `openai`, and `custom`. |
| `code_base_url` | string | custom only | API base URL (required when `code_provider = "custom"`). |
| `code_dim` | number | custom only | Embedding dimensions (required when `code_provider = "custom"`). |
| `text_provider` | `"local"` \| `"voyage"` \| `"openai"` \| `"custom"` | | Provider for text/knowledge sources. Defaults to same as `code_provider`. |
| `text_model` | string | | Model for text/knowledge sources. Defaults to provider text model. |
| `text_api_key` | string | | API key for text provider. Only required when `text_provider` differs from `code_provider`. |
| `text_base_url` | string | | Base URL for custom text provider. |
| `text_dim` | number | | Dimensions for custom text provider. |
| `rerank_provider` | string | | Reranker provider. Must match one of the embedding providers above. |
| `rerank_model` | string | | Reranker model name (required when `rerank_provider` is set). |
| `reconfigure` | boolean | | When `true`, overwrite existing config even if already configured. Default: `false`. |

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | `true` on success |
| `status` | `"configured"` \| `"already_configured"` \| `"validation_failed"` | Outcome |
| `job_id` | string \| undefined | Reindex job ID when projects were enqueued. Poll with `reindex_status`. |
| `indexed_projects` | string[] \| undefined | Project IDs enqueued for initial indexing |
| `validation` | object \| undefined | Validation details when `status = "validation_failed"` (fields: `errorType`, `message`) |
| `message` | string \| undefined | Human-readable description |

**Errors:**

| `error_type` / field | When |
|---|---|
| `status: "validation_failed"` with `validation.errorType: "auth"` | API key rejected by the provider (API providers only) |
| `status: "validation_failed"` with `validation.errorType: "network"` / `"dns"` / `"bad_url"` | Provider endpoint not reachable (API providers only) |
| `ok: false` with `error` string | Unexpected error (e.g. missing required field) |
| Local model failed to download/load | Not a synchronous `init` error — surfaces on the reindex job: poll `reindex_status` for a `"failed"` status with a friendly message in `error` |

---

## Deployment modes

Scrybe supports two MCP deployment modes:

### Shim mode (recommended)

Command: `scrybe mcp`

The MCP entrypoint is a thin stdio↔HTTP shim that communicates with the daemon via HTTP. Heavy modules (embedder, LanceDB, tree-sitter, sharp, watcher) run in the daemon process, not in-process. Cold-boot time is sub-second.

**Requires:** `scrybe daemon install` to set up autostart. The daemon must be running before MCP probes.

**Setup:**

```bash
# One-time setup
npm install -g scrybe-cli
scrybe daemon install

# MCP config (Claude Code, Cursor, Cline, etc.)
"command": "scrybe",
"args": ["mcp"]
```

### In-process mode (deprecated)

Command: `scrybe mcp --legacy-in-process`

Loads all modules (embedder, LanceDB, etc.) in the MCP process itself. No background daemon. Boot time is ~8–10 seconds (will be slower on slow networks or systems). **Deprecated as of v0.33.0 — will be removed in v0.34.0.**

Only use this if you do not want a background daemon (e.g., CI scripts, sandboxed environments).

---

## Project tools

### `list_projects`

List all registered projects and their sources, including indexing status and searchability.

No parameters.

---

### `add_project`

Register a new project container.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Unique project identifier |
| `description` | string | | Human-readable description |

---

### `update_project`

Update a project's description.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `description` | string | | New description |

---

### `remove_project`

Unregister a project and drop all its source tables (vector data deleted).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |

---

## Model tools

Embedding configuration is managed globally via presets stored in `<DATA_DIR>/config.json`. Use these tools to add presets and assign them to slots, then call `reindex_source` (or `reindex_project`) to apply the new model to existing sources.

### `add_embedding_preset`

Add a new named embedding preset. Catalog providers (`voyage`, `openai`, `local`) derive `base_url` and dimensions from the built-in catalog — only `provider`, `model`, and optional `credentials` are needed. The `custom` provider requires explicit `base_url` and `dim`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✓ | Unique preset name |
| `provider` | string | ✓ | Provider key: `voyage`, `openai`, `local`, or `custom` |
| `model` | string | ✓ | Model name from the provider catalog, or a free-text model name for `custom` |
| `credentials` | string | | Literal credential value or `${ENV_VAR}` reference |
| `credentials_from` | string | | Reuse credentials from another named preset (useful for rerank presets that share an embedding key) |
| `base_url` | string | custom only | API base URL |
| `dim` | number | custom only | Embedding dimensions |
| `prompt_template` | object | | Asymmetric `{ query, passage }` prefixes prepended before embedding (e.g. `{ "query": "query: ", "passage": "passage: " }` for e5-family models) |
| `max_input_tokens` | number | | Cap input to the model's context window (e.g. `512` for `multilingual-e5-small`); the chunker fits chunks to this budget so content is not truncated at the model boundary |

**Returns:** `{ ok: boolean, preset_name: string, error?: string }`

---

### `assign_preset`

Assign a named preset to a slot (`code`, `text`, or `rerank`). Returns `requires_reindex: true` when the new preset's `(model, dim, provider)` triple differs from the previously stamped triple on any affected source, meaning existing vectors are no longer compatible and a full reindex is needed. Returns `false` for simple preset renames that keep the same triple.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slot` | string | ✓ | `"code"`, `"text"`, or `"rerank"` |
| `preset_name` | string | ✓ | Preset name to assign. For `slot: "rerank"`, pass `"none"` to clear the rerank assignment. |

**Returns:** `{ ok: boolean, requires_reindex: boolean, error?: string }`

---

## Source tools

### `add_source`

Add an indexable source to a project and automatically enqueue an initial reindex. Returns a `job_id` you can poll with `reindex_status` or `queue_status` — no separate `reindex_source` call is needed. Embedding configuration is set globally via `add_embedding_preset` / `assign_preset` — see [Model tools](#model-tools).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to add the source to |
| `source_id` | string | ✓ | Label for this source, e.g. `"code"`, `"gitlab-issues"` |
| `source_type` | string | ✓ | `"code"` or `"ticket"` |

**For `source_type: "code"`:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `root_path` | string | ✓ | Absolute path to repo root |
| `languages` | string[] | | Language hints, e.g. `["ts", "vue"]` |

**For `source_type: "ticket"`:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `gitlab_url` | string | ✓ | GitLab instance base URL |
| `gitlab_project_id` | string | ✓ | GitLab project ID or path |
| `gitlab_token` | string | ✓ | GitLab personal access token (validated against the API before saving) |

**Returns:** `{ ok: true, project_id, source_id, job_id, status: "queued"|"running"|"started", queue_position?, duplicate_of_pending? }`

The returned `job_id` appears in `queue_status` and `reindex_status` immediately. Poll `reindex_status` with this ID to track indexing progress.

**Errors:**

| `error_type` | When |
|---|---|
| `daemon_unavailable` | The scrybe daemon failed to start or timed out during health check. Run `scrybe doctor` to diagnose, then retry. |
| *(plain error)* | Embedding not configured (`scrybe init` required), or GitLab token validation failed. |

---

### `update_source`

Update an existing source's config. Only the fields you provide are changed — everything else stays as-is.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source identifier |

**For `source_type: "ticket"` sources:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `gitlab_token` | string | Rotate the GitLab personal access token |
| `gitlab_url` | string | Change the GitLab instance base URL |
| `gitlab_project_id` | string | Change the GitLab project ID or path |

**For `source_type: "code"` sources:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `root_path` | string | Change the absolute path to repo root |
| `languages` | string[] | Change language hints |

---

### `remove_source`

Remove a source from a project and drop its vector table.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source identifier |

---

## Search tools

### How search works & what `score` means

By default scrybe runs **hybrid search**: for each query it fetches candidates from two retrievers in parallel — a **vector** (semantic) retriever and a **keyword** (BM25) retriever — then fuses them with Reciprocal Rank Fusion (RRF) and returns the top `top_k`.

**Candidate flow** (per source, `top_k = 10` example):

| Stage | Count |
|-------|-------|
| Each retriever fetches | `top_k` (10) — or `top_k × SCRYBE_RERANK_FETCH_MULTIPLIER` when reranking is on |
| Fused candidate pool | up to `2 × fetched` (minus chunks found by both retrievers) |
| Returned to you | `top_k` |

**What the `score` field means depends on the active mode:**

- **Hybrid (default):** `score` is the **RRF fusion score** — a small, rank-based number (e.g. `~0.03`). It reflects *agreement and rank position* across the two retrievers, not a raw similarity. Compare scores **within one result set** (higher = better); do not read them as a similarity percentage.
- **Reranking on** (`SCRYBE_RERANK=true`): `score` is a position-aware blend of the retrieval rank and the reranker's relevance score.
- **Vector-only** (`SCRYBE_HYBRID=false`): `score` is **true cosine similarity** (`1 − cosine_distance`), typically `~0.7–0.9` for good matches, comparable across queries.

Tuning knobs (`SCRYBE_HYBRID`, `SCRYBE_RRF_K`, `SCRYBE_RERANK*`) are documented in [configuration.md](configuration.md). For exact-name lookup without ranking, use [`lookup_symbol`](#lookup_symbol).

---

### `search_code`

Semantic search over indexed code sources in a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to search |
| `query` | string | ✓ | Natural language search query |
| `top_k` | number | | Number of results (default: 10) |
| `branch` | string | | Branch to search (default: current HEAD of the source repo). Use `list_branches` to see indexed branches. |

**Branch name resolution.** Scrybe accepts either short names (`dev`, `feat/example`) or qualified remote-tracking refs (`origin/dev`, `origin/feat/example`). The server resolves whichever form is actually stored — HEAD branches are indexed as short names, pinned branches as qualified refs — so callers do not need to know the stored form. If both a short name and its qualified ref have been indexed on the same source (unusual), pass the exact form you want. If neither form is indexed for a source, that source returns an empty result set. Set `SCRYBE_DEBUG_SEARCH=1` on the MCP server process to emit a debug line when a branch value cannot be resolved.

**Returns:** array of `{ chunk_id, score, project_id, source_id, item_path, start_line, end_line, language, symbol_name, content, branches: string[] }`

- `source_id` — the source the chunk came from (e.g. `"primary"`).
- `item_path` — relative file path within the source root, forward slashes (e.g. `"src/auth/login.ts"`).
- `branches` — all branch names the chunk is tagged on for this (project, source), sorted master/main first then alphabetical. Returns `[]` in compat mode (`SCRYBE_SKIP_MIGRATION=1`).

---

### `search_knowledge`

Semantic search over indexed knowledge sources (GitLab issues, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to search |
| `query` | string | ✓ | Natural language search query |
| `top_k` | number | | Number of results (default: 10) |
| `source_id` | string | | Limit to a specific source |
| `item_types` | string[] | | Filter by item type. Known values: `"ticket"` (GitLab issue body), `"ticket_comment"` (individual issue comment). Example: `["ticket"]` returns only issue bodies; `["ticket_comment"]` returns only comments; omit to return both. |

**Returns:** array of `{ project_id, source_id, item_path, item_url, item_type, author, timestamp, content, score, state, labels, assignees, milestone, confidential }`

- `item_path` — provider slug identifying the chunk, e.g. `"issues/123"` (issue body) or `"issues/123#note_456"` (comment).
- `item_url` — deep link back to the original in the provider (ref-less).
- `item_type` — `"ticket"` (issue body) or `"ticket_comment"` (individual comment).

For `item_type: "ticket_comment"`, `author` is the commenter's username, `timestamp` is the comment's `created_at`, and `item_url` includes a `#note_{id}` anchor linking to the specific comment.

**Ticket metadata fields** (present on every result; populated for GitLab issue and comment chunks; empty/null for other item types):

| Field | Type | Description |
|-------|------|-------------|
| `state` | `string \| null` | Issue state: `"open"` or `"closed"`. `null` for non-ticket sources. |
| `labels` | `string[]` | Issue labels (e.g. `["bug", "frontend"]`). Empty array when none. |
| `assignees` | `string[]` | Assignee usernames (e.g. `["alice"]`). Empty array when none. |
| `milestone` | `{ title: string; due_date: string \| null } \| null` | Milestone title and due date, or `null` when unset. |
| `confidential` | `boolean` | `true` when the issue was marked confidential in GitLab. Note: confidential issue text flows into the local index by design — this flag lets the caller decide how to handle it. |

Comment chunks (`item_type: "ticket_comment"`) inherit the parent issue's metadata but keep their own `author` (the commenter).

**No new input arguments.** The metadata is returned passthrough for every result — there are no filter parameters for these fields. The caller reasons from the returned values directly.

**Structured errors:** When a source needs migration, search returns `{ error_type: "needs_migration", error: "...", details: { migrate_command: "scrybe migrate ..." } }` instead of results. Run the indicated command to upgrade the source.

---

### `lookup_symbol`

Deterministic exact-symbol lookup in a project's code index. Returns all chunks whose `symbol_name` matches the supplied name, without paying embedding or reranking cost. Use when you know a symbol name and need its file location, line range, and source content.

**No `score` field** — results are sorted by `(language ASC, item_path ASC, start_line ASC)`, not by relevance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to search |
| `symbol_name` | string | ✓ | Symbol name to look up. Must be non-empty after trimming. |
| `match` | string | | `"suffix"` (default) or `"exact"`. See match modes below. |
| `branch` | string | | Branch to scope results to. Accepts short names or `origin/` qualified refs — same resolution as `search_code`. If omitted, all indexed branches are searched. |
| `source_id` | string | | Restrict to a specific source. Omit to search all code sources. |
| `case_sensitive` | boolean | | Case-sensitive match (default `true`). Pass `false` to match case-insensitively. |
| `limit` | number | | Max results (default 50, max 200). |

**Match modes:**

| `match` | `case_sensitive` | Behaviour |
|---------|-----------------|-----------|
| `suffix` | `true` (default) | Matches `symbol_name = 'X'` OR `symbol_name LIKE '%.X'` — finds both top-level `X` and dotted forms like `User.X`. |
| `suffix` | `false` | Same as above but case-insensitive. |
| `exact` | `true` | `symbol_name = 'X'` only. `getName` does **not** match `User.getName`. |
| `exact` | `false` | `LOWER(symbol_name) = LOWER('X')` only. |

**Dotted naming.** Class methods are stored as `ClassName.methodName` (e.g. `BetaEngine.transform`). In `suffix` mode, passing `transform` returns `BetaEngine.transform` and any other dotted form. In `exact` mode, you must pass the full qualified name.

**Empty-name chunks excluded.** The `symbol_name != ''` filter always applies, which means:
- Sliding-window fallback chunks (files in unsupported languages or with parse failures) are never returned.
- Non-first sub-chunks of large declarations (those that exceeded `chunkSize`) are never returned — only the first sub-chunk, which carries the symbol name and declaration head.

**Multi-chunk declarations.** For very large declarations, `lookup_symbol` returns only the first sub-chunk. Its `start_line` / `end_line` cover the head. To read the full body, use those line numbers to read the file directly.

**Returns:** array of `{ chunk_id, project_id, source_id, item_path, start_line, end_line, language, symbol_name, content, branches: string[] }`

- No `score` field (contrast with `search_code`).
- `branches` — branch annotation, same sort order as `search_code` (master/main first).
- Returns `[]` when nothing matches — no error thrown.

**Branch name resolution.** Uses the same resolver as `search_code`. `branch="dev"` and `branch="origin/dev"` are both accepted; the server resolves whichever form is indexed for the source.

**Examples:**

```json
// Find all definitions of "alphaGreeting" (exact, any source)
{ "project_id": "myrepo", "symbol_name": "alphaGreeting", "match": "exact" }

// Find "transform" anywhere it appears (top-level or as Foo.transform)
{ "project_id": "myrepo", "symbol_name": "transform" }

// Find User.getName specifically
{ "project_id": "myrepo", "symbol_name": "User.getName", "match": "exact" }

// Case-insensitive lookup for C#-style naming
{ "project_id": "myrepo", "symbol_name": "USERSERVICE", "match": "exact", "case_sensitive": false }

// Branch-scoped lookup
{ "project_id": "myrepo", "symbol_name": "alphaFarewell", "branch": "feat/example" }
```

---

## Reindex tools

### `reindex_all`

Incrementally reindex all registered projects in the background. Returns a `job_id` to poll with `reindex_status`. Check `current_project` in the status to see which project is currently being indexed.

No parameters.

**Returns:** `{ job_id, status: "started", project_count, mode: "incremental" }`

---

### `reindex_project`

Trigger background reindexing of sources in a project. Routes through the daemon queue when the daemon is running (prevents cross-process LanceDB write conflicts). Returns a `job_id` to poll with `reindex_status`.

> **Tip:** Before triggering a reindex, call `queue_status(project_id)` to check if the daemon already has a pending or in-flight job. Polling `reindex_status` on the existing job is cheaper than submitting a duplicate.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to reindex |
| `source_ids` | string[] | | Sources to reindex. Required when `mode` is `"full"`. Omit to reindex all sources (incremental only) |
| `mode` | string | | `"full"` or `"incremental"` (default: `"incremental"`) |
| `branch` | string | | Branch to index for code sources (default: current HEAD). Ignored for ticket sources. |

**Returns:** `{ job_id, status, project_id, mode, queue_position?, duplicate_of_pending? }`

---

### `reindex_source`

Trigger background reindexing of a single source. Routes through the daemon queue when available. Returns a `job_id` to poll.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source to reindex |
| `mode` | string | | `"full"` or `"incremental"` (default: `"incremental"`) |
| `branch` | string | | Branch to index for code sources (default: current HEAD). Ignored for ticket sources. |

---

### `reindex_status`

Get the status of a background reindex job. Checks the in-process job map first, then falls back to the durable SQLite job store (cross-process, survives daemon restart).

| Parameter   | Type   | Required | Description                          |
|-------------|--------|----------|--------------------------------------|
| `job_id`    | string | ✓        | Job ID returned by a reindex tool    |

**Returns:** `{ job_id, status, tasks[], current_project?, error? }`

Each entry in `tasks` has: `{ source_id, mode, status, phase, percent, files_scanned, chunks_prepared, started_at, finished_at, error }`

`status` values: `"queued"`, `"running"`, `"done"`, `"failed"`, `"cancelled"`, `"interrupted"` (job was running when the daemon stopped/crashed; reconciled to this terminal state on the next start — rerun to recover)

Task `status` values: `"pending"`, `"running"`, `"done"`, `"failed"`, `"cancelled"`

**Task `phase` values** (progresses in order for local-model indexing):

| `phase` | Meaning |
|---------|---------|
| `"downloading-model"` | Local embedding model weights are being downloaded (~130 MB, one-time). `percent` is set to a 0–100 download progress value. |
| `"scanning"` | Enumerating and hashing files to find changes. |
| `"embedding"` | Generating vectors and writing chunks to the index. |
| `"done"` | Source fully indexed. |

`percent` is only populated during the `"downloading-model"` phase; it is `null` or absent in other phases. API-provider sources skip the `"downloading-model"` phase entirely.

---

### `queue_status`

Check what is currently running or queued in the reindex queue. Use this before calling `reindex_project` to avoid submitting a duplicate job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | | Filter to a specific project (omit for all projects) |

**Returns:** `{ running: [...], queued: [...], awaiting_migration: [...] }` — each `running`/`queued` entry has `job_id`, `project_id`, `source_id`, `mode`, `started_at`/`queued_at`. `awaiting_migration` lists large local-embedder sources that need a manual full reindex after an embedding-config upgrade (small sources are auto-enqueued instead).

---

### `list_jobs`

List background reindex jobs from the durable SQLite store. Cross-process: shows jobs submitted by the daemon, MCP, or CLI. Does not require a `job_id`.

| Parameter | Type   | Required | Description                     |
|-----------|--------|----------|---------------------------------|
| `status`  | string |          | Filter by job status (optional) |

Accepted `status` values: `"queued"`, `"running"`, `"done"`, `"failed"`, `"cancelled"`, `"interrupted"`. Omit to return all jobs.

**Returns:** `{ jobs[], count }`

---

### `cancel_reindex`

Cancel a running reindex job, optionally targeting a single source task.

| Parameter   | Type   | Required | Description                      |
|-------------|--------|----------|----------------------------------|
| `job_id`    | string | ✓        | Job ID to cancel                 |
| `source_id` | string |          | Source task to cancel (optional) |

If `source_id` is omitted, all remaining tasks in the job are cancelled.

---

### `gc`

Run garbage collection: remove orphan chunks and compact LanceDB tables. Routes through the daemon queue when available (prevents write races with active reindex jobs). Cancels any pending auto-gc jobs in the same scope and resets idle timers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | | Limit gc to a specific project (omit for all projects) |
| `source_id` | string | | Limit gc to a specific source within the project |

**Returns:**

```json
{
  "jobs": [
    { "job_id": "a4b8c2d1", "project_id": "scrybe", "status": "queued" }
  ],
  "message": "1 gc job(s) queued. Poll with reindex_status or run 'scrybe job list'."
}
```

When the daemon is down, runs synchronously and returns:
```json
{
  "message": "GC complete. 12 orphan(s) deleted, 3.2 MB reclaimed across 1 project(s)."
}
```

---

### `list_branches`

List branches that have been indexed for a project's sources. Useful before calling `search_code` or `reindex_source` with an explicit `branch` parameter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | | Limit to a specific source (omit for all sources) |

**Returns:** array of `{ source_id, branches: string[] }`

Non-code sources (tickets) always show `["*"]` — they are branch-agnostic.

---

### `list_pinned_branches`

List the pinned branches for a project's code sources.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | | Limit to a specific source (omit for all sources) |

**Returns:** array of `{ source_id, pinned_branches: string[] }`

---

### `pin_branches`

Add one or more branch names to a code source's pinned list. Deduped; warns when total exceeds 20. If the daemon is running, newly-pinned branches are backfilled immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Code source to pin branches on |
| `branches` | string[] | ✓ | Branch names to add |

---

### `unpin_branches`

Remove one or more branch names from a code source's pinned list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Code source to unpin branches from |
| `branches` | string[] | ✓ | Branch names to remove |

---

## Private ignore tools

Per-source ignore rules stored in `DATA_DIR/ignores/<project_id>/<source_id>.gitignore`. Never committed. Applied additively on top of `.gitignore` and `.scrybeignore`.

**Important:** all three tools only work on code sources. Knowledge sources have a different ignore model (on the roadmap).

### `set_private_ignore`

Set or clear private ignore rules for a code source. Replaces the entire file content.

> To add a single pattern to existing rules: call `get_private_ignore` first, append your pattern, then call `set_private_ignore` with the concatenated content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source identifier (must be a code source) |
| `content` | string | ✓ | Full new content (gitignore syntax). Empty string = delete the file. |

Returns `{ ok, path, action, hint }`:
- `action`: `"written"` / `"deleted"` / `"unchanged"`
- `hint`: exact reindex command to apply changes, e.g. `scrybe index -P myrepo -S primary --incremental`

**Example — add a pattern:**
```json
// 1. Get current rules
{ "tool": "get_private_ignore", "args": { "project_id": "myrepo", "source_id": "primary" } }
// Response: { "content": "vendor/\n", ... }

// 2. Append new pattern and save
{ "tool": "set_private_ignore", "args": { "project_id": "myrepo", "source_id": "primary", "content": "vendor/\n*.generated.ts\n" } }
// Response: { "ok": true, "action": "written", "hint": "scrybe index -P myrepo -S primary --incremental", ... }

// 3. Delete all private rules
{ "tool": "set_private_ignore", "args": { "project_id": "myrepo", "source_id": "primary", "content": "" } }
// Response: { "ok": true, "action": "deleted", ... }
```

---

### `get_private_ignore`

Read the current private ignore content for a code source.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source identifier |

Returns `{ project_id, source_id, content, path, rule_count }`. `content` is `null` if no file exists.

---

### `list_private_ignores`

Enumerate all private ignore files across all registered projects. Returns metadata only — for full content, use `get_private_ignore`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | | Limit to a specific project (omit for all) |

Returns an array of `{ project_id, source_id, path, rule_count, mtime }`. Sources with no effective rules (missing, empty, comment-only) are excluded.

---

## Error types

When a tool call fails, the response includes an `error_type` field for programmatic handling:

| `error_type` | Cause |
|-------------|-------|
| `rate_limit` | Embedding API rate limit exceeded |
| `auth` | Embedding API key missing or invalid. Check `SCRYBE_CODE_EMBEDDING_API_KEY` |
| `dimensions_mismatch` | Indexed data uses different embedding dimensions than the current embedder (embedding-time error) — run a full reindex |
| `table_corrupt` | The index for one or more sources is corrupt (manifest missing data files, dimensions mismatch after the fact, or unreadable schema). The `details` field includes `project_id`, `source_id`, `reasons[]`, and optional `expected_dimensions`/`actual_dimensions`. Run: `scrybe index -P <id> -S <id> --full` or `scrybe doctor --repair`. |
| `unknown_provider` | `SCRYBE_CODE_EMBEDDING_BASE_URL` not recognised and `SCRYBE_CODE_EMBEDDING_MODEL` not set |
| `no_code_sources` | Project has no indexed code sources |
| `no_knowledge_sources` | Project has no indexed knowledge sources |
