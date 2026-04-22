# Migrating to v0.14 — Branch-Aware Indexing

v0.14 introduces content-addressed chunk IDs and a branch-tag side-store. This is a **breaking change** to the internal index format — every project needs a one-time full reindex.

---

## What changed

| Area | v0.13 | v0.14 |
|------|-------|-------|
| Chunk identity | `sha256(filePath + content)` | `sha256(projectId + sourceId + language + content)` |
| Branch awareness | None — HEAD-only index | Per-branch tag table; multiple branches share vectors |
| Side-store | None | `branch-tags.db` (SQLite, `node:sqlite`) |
| Hash files | `<project>__<source>.json` | `<project>__<source>__<branchSlug>.json` per branch |
| Node.js requirement | ≥ 20 | ≥ 22.5.0 (required for `node:sqlite`) |

---

## Migration is automatic

The first time you run `scrybe index` (or any MCP reindex tool) after upgrading, scrybe detects the old schema and prints:

```
scrybe: Upgrading index to branch-aware format (v2).
This is a one-time full reindex — all projects will be re-embedded on next index run.
To skip and run read-only: set SCRYBE_SKIP_MIGRATION=1.
```

It then:

1. Deletes all existing hash files (`DATA_DIR/hashes/`)
2. Deletes `branch-tags.db` if present
3. Writes `DATA_DIR/schema.json` with `{ "version": 2 }`
4. Marks all sources for full reindex on the next `index` call

The actual re-embedding happens on the next `index` run — migration only resets the metadata.

---

## Step-by-step upgrade

```bash
# 1. Update Node.js to 22.5+ if needed
node --version   # must be >= 22.5.0

# 2. Pull latest scrybe
cd /path/to/scrybe
git pull
npm install
npm run build

# 3. Reindex code sources (triggers migration automatically)
# Only the `code` sources need reindexing — tickets and other non-code
# sources are branch-agnostic and their existing chunks remain valid.
scrybe index --project-id myrepo --source-ids primary --full
# ...repeat per project for their code sources.
```

**Non-code sources (GitLab issues, webpages, etc.) do NOT need reindexing.** From v0.14.1 onward they don't participate in `branch_tags` at all — they're branch-agnostic and their existing chunks continue to work as-is.

After reindexing, run GC to remove any orphans left over from the old path-addressed format:

```bash
scrybe gc --dry-run   # see what would be deleted (code sources only)
scrybe gc             # delete orphans
```

`scrybe gc` only operates on code sources. Non-code sources are skipped because their notion of "orphan" (an upstream resource was deleted) can't be detected from local state alone. A future `scrybe reconcile` command will cover that case.

---

## Escape hatch — read-only mode

If you need to keep using v0.13 search results without reindexing, set:

```
SCRYBE_SKIP_MIGRATION=1
```

In this mode:
- Search works on existing chunks (no branch filter applied)
- All write operations (`index`, `reindex_source`, etc.) return an error:
  > "run full reindex to enable branch features"

This is intended as a short-term bridge only. Branch features are disabled until you run the full reindex.

---

## New features after migration

### Branch-aware indexing

```bash
# Index a specific branch (default: current HEAD)
scrybe index --project-id myrepo --source-ids primary --branch feat/my-feature

# Search on a specific branch
scrybe search --project-id myrepo --branch feat/my-feature "auth flow"
```

Multiple branches share vector storage for identical content — no N× blowup.

### Garbage collection

```bash
scrybe gc --dry-run        # report orphan count per source
scrybe gc                  # delete orphans
scrybe gc --project-id X   # limit to one project
```

Run `gc` after deleting a long-lived branch or after the initial v0.14 migration.

### Branch listing

```bash
scrybe status --project-id myrepo   # shows branches_indexed per source
```

MCP: `list_branches(project_id, source_id?)` returns `[{ source_id, branches }]`.

---

## Runtime data after migration

`DATA_DIR` = `%LOCALAPPDATA%\scrybe\scrybe\` (Windows) or `~/.local/share/scrybe/scrybe/` (Linux/macOS)

```
DATA_DIR/
├── schema.json             ← { "version": 2 } — new in v0.14
├── projects.json
├── embedding-meta.json
├── branch-tags.db          ← SQLite branch-tag side-store — new in v0.14
├── lancedb/
└── hashes/
    └── <project>__<source>__<branchSlug>.json   ← per-branch, replaces flat files
```

Old flat hash files (`<project>__<source>.json`) are deleted automatically during migration.
