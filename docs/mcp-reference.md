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
| `gitlab_token` | string | ✓ | GitLab personal access token |

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

**Returns:** array of `{ file_path, start_line, end_line, language, symbol_name, content, score }`

---

### `search_knowledge`

Semantic search over indexed knowledge sources (GitLab issues, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to search |
| `query` | string | ✓ | Natural language search query |
| `top_k` | number | | Number of results (default: 10) |
| `source_id` | string | | Limit to a specific source |
| `source_types` | string[] | | Filter by source type, e.g. `["ticket"]` |

**Returns:** array of `{ source_url, source_path, source_type, author, timestamp, content, score }`

---

## Reindex tools

### `reindex_project`

Trigger background reindexing of all sources in a project. Returns a `job_id` to poll.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project to reindex |
| `mode` | string | | `"full"` or `"incremental"` (default: `"incremental"`) |

---

### `reindex_source`

Trigger background reindexing of a single source. Returns a `job_id` to poll.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | string | ✓ | Project identifier |
| `source_id` | string | ✓ | Source to reindex |
| `mode` | string | | `"full"` or `"incremental"` (default: `"incremental"`) |

---

### `reindex_status`

Get the status of a background reindex job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | ✓ | Job ID returned by `reindex_project` or `reindex_source` |

**Returns:** `{ job_id, status, phase, files_scanned, chunks_indexed, error?, error_type? }`

`status` values: `"running"`, `"done"`, `"error"`, `"cancelled"`

---

### `cancel_reindex`

Cancel a running reindex job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | ✓ | Job ID to cancel |

---

## Error types

When a tool call fails, the response includes an `error_type` field for programmatic handling:

| `error_type` | Cause |
|-------------|-------|
| `rate_limit` | Embedding API rate limit exceeded |
| `auth` | Embedding API key missing or invalid |
| `dimensions_mismatch` | Indexed data uses different embedding dimensions — run a full reindex |
| `unknown_provider` | `EMBEDDING_BASE_URL` not recognised and `EMBEDDING_MODEL` not set |
| `no_code_sources` | Project has no indexed code sources |
| `no_knowledge_sources` | Project has no indexed knowledge sources |
