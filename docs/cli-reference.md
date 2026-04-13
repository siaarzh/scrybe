# CLI Reference

All commands run via `node dist/index.js <command> [options]`.

---

## Project commands

### `add-project`

Register a new project container. Sources are added separately with `add-source`.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Unique project identifier |
| `--desc <text>` | | Human-readable description |

```bash
node dist/index.js add-project --id myrepo --desc "My frontend"
```

---

### `update-project`

Update a project's description.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Project identifier |
| `--desc <text>` | | New description |

---

### `remove-project`

Unregister a project and drop all its source tables (vector data deleted).

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Project identifier |

---

### `list-projects`

List all registered projects and their sources, including indexing status and searchability.

No flags.

---

### `status`

Print full project JSON (sources, table names, last indexed timestamps) and the data directory path.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |

---

## Source commands

### `add-source`

Add an indexable source to a project.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to add the source to |
| `--source-id <id>` | ✓ | Label for this source, e.g. `code`, `gitlab-issues` |
| `--type <type>` | ✓ | `code` or `ticket` |

**For `--type code`:**

| Flag | Required | Description |
|------|----------|-------------|
| `--root <path>` | ✓ | Absolute path to repo root |
| `--languages <langs>` | | Comma-separated language hints, e.g. `ts,vue` |

**For `--type ticket`:**

| Flag | Required | Description |
|------|----------|-------------|
| `--gitlab-url <url>` | ✓ | GitLab instance base URL |
| `--gitlab-project-id <id>` | ✓ | GitLab project ID or path |
| `--gitlab-token <token>` | ✓ | GitLab personal access token (validated against the API before saving) |

**Embedding overrides (optional, any type):**

| Flag | Description |
|------|-------------|
| `--embedding-base-url <url>` | Override embedding API base URL for this source |
| `--embedding-model <model>` | Override embedding model |
| `--embedding-dimensions <n>` | Override embedding dimensions |
| `--embedding-api-key-env <var>` | Name of the env var holding the API key (not the key itself) |

```bash
# Code source
node dist/index.js add-source --project-id myrepo --source-id code \
  --type code --root /path/to/repo --languages ts,vue

# GitLab issues source
node dist/index.js add-source --project-id myrepo --source-id gitlab-issues \
  --type ticket \
  --gitlab-url https://gitlab.example.com \
  --gitlab-project-id 42 \
  --gitlab-token glpat-...
```

---

### `update-source`

Update an existing source's config. Only the flags you provide are changed — everything else stays as-is.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | ✓ | Source identifier |

**For `--type ticket` sources:**

| Flag | Description |
|------|-------------|
| `--gitlab-token <token>` | Rotate the GitLab personal access token |
| `--gitlab-url <url>` | Change the GitLab instance base URL |
| `--gitlab-project-id <id>` | Change the GitLab project ID or path |

**For `--type code` sources:**

| Flag | Description |
|------|-------------|
| `--root <path>` | Change the absolute path to repo root |
| `--languages <langs>` | Change comma-separated language hints |

**Embedding overrides (optional, any type):**

| Flag | Description |
|------|-------------|
| `--embedding-base-url <url>` | Override embedding API base URL for this source |
| `--embedding-model <model>` | Override embedding model |
| `--embedding-dimensions <n>` | Override embedding dimensions |
| `--embedding-api-key-env <var>` | Name of the env var holding the API key (not the key itself) |

```bash
# Rotate a GitLab token
node dist/index.js update-source --project-id myrepo --source-id gitlab-issues \
  --gitlab-token glpat-newtoken
```

---

### `remove-source`

Remove a source from a project and drop its vector table.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | ✓ | Source identifier |

---

## Index commands

### `index`

Index or reindex a project (all sources), a single source, or all registered projects.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Project to index (required unless `--all`) |
| `--source-id <id>` | | Index only this source; omit to index all sources |
| `--all` | | Incrementally reindex all registered projects |
| `--full` | | Full reindex — clears existing data and rebuilds from scratch (default) |
| `--incremental` | | Only process changed files / updated issues since last run |

```bash
# Incremental reindex of all registered projects
node dist/index.js index --all

# Full reindex of all sources in a project
node dist/index.js index --project-id myrepo --full

# Incremental reindex of one source
node dist/index.js index --project-id myrepo --source-id gitlab-issues --incremental
```

---

## Search commands

### `search`

Semantic search over indexed code sources.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--top-k <n>` | | Number of results (default: 10) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
node dist/index.js search --project-id myrepo "authentication login flow"
```

---

### `search-knowledge`

Semantic search over indexed knowledge sources (GitLab issues, etc.).

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--source-id <id>` | | Limit to a specific source |
| `--source-type <type>` | | Filter by source type, e.g. `ticket` |
| `--top-k <n>` | | Number of results (default: 10) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
node dist/index.js search-knowledge --project-id myrepo "password reset broken"
node dist/index.js search-knowledge --project-id myrepo --source-type ticket "login error"
```
