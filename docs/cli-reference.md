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
| `--gitlab-token <token>` | ✓ | GitLab personal access token |

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

### `remove-source`

Remove a source from a project and drop its vector table.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project identifier |
| `--source-id <id>` | ✓ | Source identifier |

---

## Index commands

### `index`

Index or reindex a project (all sources) or a single source.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to index |
| `--source-id <id>` | | Index only this source; omit to index all sources |
| `--full` | | Full reindex — clears existing data and rebuilds from scratch (default) |
| `--incremental` | | Only process changed files / updated issues since last run |

```bash
# Full reindex of all sources
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
