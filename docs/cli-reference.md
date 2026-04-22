# CLI Reference

All commands run via `scrybe <command> [options]`.

---

## Project commands

### `add-project`

Register a new project container. Sources are added separately with `add-source`.

| Flag | Required | Description |
|------|----------|-------------|
| `--id <id>` | ✓ | Unique project identifier |
| `--desc <text>` | | Human-readable description |

```bash
scrybe add-project --id myrepo --desc "My frontend"
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

Print full project JSON (sources, table names, last indexed timestamps, `branches_indexed` per source) and the data directory path.

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
scrybe add-source --project-id myrepo --source-id code \
  --type code --root /path/to/repo --languages ts,vue

# GitLab issues source
scrybe add-source --project-id myrepo --source-id gitlab-issues \
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
scrybe update-source --project-id myrepo --source-id gitlab-issues \
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

Index or reindex a project (all sources), specific sources, or all registered projects.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Project to index (required unless `--all`) |
| `--source-ids <ids>` | | Comma-separated source IDs to index, e.g. `primary,gitlab-issues`. Required when using `--full` |
| `--all` | | Incrementally reindex all registered projects |
| `--full` | | Full reindex — clears and rebuilds from scratch. Requires `--source-ids` |
| `--incremental` | | Only process changed files / updated issues since last run (default) |
| `--branch <name>` | | Branch to index for code sources (default: current HEAD). Ignored for ticket sources |

```bash
# Incremental reindex of all registered projects
scrybe index --all

# Incremental reindex of all sources in a project (default mode)
scrybe index --project-id myrepo

# Full reindex of specific sources
scrybe index --project-id myrepo --source-ids primary --full
scrybe index --project-id myrepo --source-ids primary,gitlab-issues --full

# Incremental reindex of one source
scrybe index --project-id myrepo --source-ids gitlab-issues

# Index a specific git branch
scrybe index --project-id myrepo --source-ids primary --branch feat/my-feature
```

---

### `jobs`

List background reindex jobs from the current process.

| Flag        | Required | Description                       |
|-------------|----------|-----------------------------------|
| `--running` |          | Show only currently running jobs  |

```bash
scrybe jobs
scrybe jobs --running
```

---

### `gc`

Remove orphaned chunks from the vector store. Orphans accumulate when branches are deleted or full reindexes are skipped — they waste disk space and slightly skew search scores.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | | Limit GC to a specific project (default: all projects) |
| `--dry-run` | | Report orphans without deleting |

A chunk is orphaned when no `branch_tags` row references it (it was never re-tagged after its branch was dropped).

```bash
# Dry run — see what would be deleted
scrybe gc --dry-run

# Remove orphans in a single project
scrybe gc --project-id myrepo

# Remove orphans across all projects
scrybe gc
```

Run after deleting a long-lived branch or after migrating from v0.13.x.

---

## Search commands

### `search`

Semantic search over indexed code sources.

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--top-k <n>` | | Number of results (default: 10) |
| `--branch <name>` | | Branch to search (default: current HEAD for code sources) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
scrybe search --project-id myrepo "authentication login flow"
scrybe search --project-id myrepo --branch feat/my-feature "new feature implementation"
```

---

### `search-knowledge`

Semantic search over indexed knowledge sources (GitLab issues, etc.).

| Flag | Required | Description |
|------|----------|-------------|
| `--project-id <id>` | ✓ | Project to search |
| `--source-id <id>` | | Limit to a specific source |
| `--source-types <types>` | | Comma-separated source type filter. Known values: `ticket` (issue bodies), `ticket_comment` (individual comments) |
| `--top-k <n>` | | Number of results (default: 10) |
| `<query>` | ✓ | Natural language search query (positional) |

```bash
scrybe search-knowledge --project-id myrepo "password reset broken"
scrybe search-knowledge --project-id myrepo --source-types ticket "login error"
scrybe search-knowledge --project-id myrepo --source-types ticket_comment "architectural decision"
```
