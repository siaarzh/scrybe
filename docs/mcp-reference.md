# MCP Reference

All tools are exposed via the `scrybe` MCP server. Call `list_projects` first to confirm what's indexed before searching.

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

## Source tools

### `add_source`

Add an indexable source to a project. Call `reindex_source` after to index it.

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

**Embedding overrides (optional, any type):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `embedding_base_url` | string | Override embedding API base URL |
| `embedding_model` | string | Override embedding model |
| `embedding_dimensions` | number | Override embedding dimensions |
| `embedding_api_key_env` | string | Name of env var holding the API key (never the key itself) |

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

**Embedding overrides (optional, any type):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `embedding_base_url` | string | Override embedding API base URL |
| `embedding_model` | string | Override embedding model |
| `embedding_dimensions` | number | Override embedding dimensions |
| `embedding_api_key_env` | string | Name of env var holding the API key (never the key itself) |

---

### `remove_source`

Remove a source from a project and drop its vector table.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source identifier |

---

## Search tools

### `search_code`

Semantic search over indexed code sources in a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to search |
| `query` | string | ✓ | Natural language search query |
| `top_k` | number | | Number of results (default: 10) |
| `branch` | string | | Branch to search (default: current HEAD of the source repo). Use `list_branches` to see indexed branches. |

**Returns:** array of `{ chunk_id, score, project_id, source_id, file_path, start_line, end_line, language, symbol_name, content, branches: string[] }`

- `source_id` — the source the chunk came from (e.g. `"primary"`).
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
| `source_types` | string[] | | Filter by source type. Known values: `"ticket"` (GitLab issue body), `"ticket_comment"` (individual issue comment). Example: `["ticket"]` returns only issue bodies; `["ticket_comment"]` returns only comments; omit to return both. |

**Returns:** array of `{ project_id, source_id, source_path, source_url, source_type, author, timestamp, content, score }`

For `source_type: "ticket_comment"`, `author` is the commenter's username, `timestamp` is the comment's `created_at`, and `source_url` includes a `#note_{id}` anchor linking to the specific comment.

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

Each entry in `tasks` has: `{ source_id, mode, status, phase, files_scanned, chunks_prepared, started_at, finished_at, error }`

`status` values: `"queued"`, `"running"`, `"done"`, `"failed"`, `"cancelled"`

Task `status` values: `"pending"`, `"running"`, `"done"`, `"failed"`, `"cancelled"`

---

### `queue_status`

Check what is currently running or queued in the reindex queue. Use this before calling `reindex_project` to avoid submitting a duplicate job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | | Filter to a specific project (omit for all projects) |

**Returns:** `{ running: [...], queued: [...] }` — each entry has `job_id`, `project_id`, `source_id`, `mode`, `started_at`/`queued_at`.

---

### `list_jobs`

List background reindex jobs from the durable SQLite store. Cross-process: shows jobs submitted by the daemon, MCP, or CLI. Does not require a `job_id`.

| Parameter | Type   | Required | Description                     |
|-----------|--------|----------|---------------------------------|
| `status`  | string |          | Filter by job status (optional) |

Accepted `status` values: `"queued"`, `"running"`, `"done"`, `"failed"`, `"cancelled"`. Omit to return all jobs.

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
