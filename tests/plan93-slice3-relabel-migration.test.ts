/**
 * Plan 93 Slice 3 — D3/R1/R4a/R4b: one-shot origin/<branch> → <branch> relabel migration.
 *
 * Tests:
 *   A. Happy path: origin/dev rows → dev; SHA carried; hashes file renamed.
 *      Post-migration state is parity-equal to a fresh origin/<b> reindex.
 *   B. Upstream wins on conflict: stale local snapshot for "dev" is evicted;
 *      upstream (origin/dev) chunk set and SHA win.
 *   C. Idempotency: second run returns "skipped" — no origin/ rows remain.
 *   D. Ticket sources are skipped (only code sources carry branch_tags).
 *   E. No-op on empty DB (no origin/ rows at all).
 *   F. First post-migration poll is a no-op — lastIndexedSha under logical name
 *      equals what origin/<b> previously recorded (R4b).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DatabaseSync } from "node:sqlite";
import { relabelOriginBranchesForPlan93 } from "../src/migrations.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "scrybe-p93-s3-"));
}

/** Create a minimal in-memory-ish SQLite DB with the branch-state schema. */
function makeTestDB(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_tags (
      project_id  TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      branch      TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      chunk_id    TEXT NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      PRIMARY KEY (project_id, source_id, branch, file_path, chunk_id)
    );
    CREATE TABLE IF NOT EXISTS branch_state (
      project_id        TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      branch            TEXT NOT NULL,
      last_indexed_sha  TEXT NOT NULL,
      last_indexed_at   INTEGER,
      PRIMARY KEY (project_id, source_id, branch)
    );
  `);
  return db;
}

function insertTag(
  db: DatabaseSync,
  projectId: string, sourceId: string, branch: string,
  filePath: string, chunkId: string,
  startLine = 1, endLine = 5
): void {
  db.prepare(
    `INSERT OR IGNORE INTO branch_tags
       (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
     VALUES (?,?,?,?,?,?,?)`
  ).run(projectId, sourceId, branch, filePath, chunkId, startLine, endLine);
}

function insertBranchState(
  db: DatabaseSync,
  projectId: string, sourceId: string, branch: string, sha: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO branch_state
       (project_id, source_id, branch, last_indexed_sha, last_indexed_at)
     VALUES (?,?,?,?,?)`
  ).run(projectId, sourceId, branch, sha, Date.now());
}

function getBranchTags(
  db: DatabaseSync,
  projectId: string, sourceId: string, branch: string
): Array<{ file_path: string; chunk_id: string }> {
  return db.prepare(
    `SELECT file_path, chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?`
  ).all(projectId, sourceId, branch) as Array<{ file_path: string; chunk_id: string }>;
}

function getLastSha(
  db: DatabaseSync,
  projectId: string, sourceId: string, branch: string
): string | null {
  const row = db.prepare(
    `SELECT last_indexed_sha FROM branch_state WHERE project_id=? AND source_id=? AND branch=?`
  ).get(projectId, sourceId, branch) as { last_indexed_sha: string } | undefined;
  return row?.last_indexed_sha ?? null;
}

function writeHashFile(hashesDir: string, projectId: string, sourceId: string, branch: string, data: Record<string, string>): void {
  mkdirSync(hashesDir, { recursive: true });
  // slug: "/" → "__"
  const slug = branch === "*" ? "_all_" : branch.replace(/\//g, "__");
  writeFileSync(
    join(hashesDir, `${projectId}__${sourceId}__${slug}.json`),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function hashFileExists(hashesDir: string, projectId: string, sourceId: string, branch: string): boolean {
  const slug = branch === "*" ? "_all_" : branch.replace(/\//g, "__");
  return existsSync(join(hashesDir, `${projectId}__${sourceId}__${slug}.json`));
}

function readHashFile(hashesDir: string, projectId: string, sourceId: string, branch: string): Record<string, string> {
  const slug = branch === "*" ? "_all_" : branch.replace(/\//g, "__");
  const p = join(hashesDir, `${projectId}__${sourceId}__${slug}.json`);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
}

// ─── Test A — happy path: origin/dev relabeled to dev ────────────────────────

describe("Plan93-A — origin/dev rows relabeled to dev (happy path)", () => {
  it("relabels branch_tags, branch_state SHA, and hashes file; parity-equal to fresh reindex", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "branch-tags.db");
    const hashesDir = join(dir, "hashes");

    try {
      const db = makeTestDB(dbPath);
      const projectId = "p93a-proj";
      const sourceId = "code";
      const qualBranch = "origin/dev";
      const logicalBranch = "dev";
      const sha = "abc123def456";

      // Seed: chunks under origin/dev + SHA row + hashes file
      insertTag(db, projectId, sourceId, qualBranch, "src/main.ts", "chunk-001");
      insertTag(db, projectId, sourceId, qualBranch, "src/util.ts", "chunk-002");
      insertBranchState(db, projectId, sourceId, qualBranch, sha);
      writeHashFile(hashesDir, projectId, sourceId, qualBranch, {
        "src/main.ts": "hash-a",
        "src/util.ts": "hash-b",
      });

      const results = await relabelOriginBranchesForPlan93({
        _projects: [{ id: projectId, sources: [{ source_id: sourceId, source_config: { type: "code" } }] }],
        _getDB: () => db,
        _hashesDir: hashesDir,
      });

      // Migration result
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe("ok");
      expect(results[0]!.qualifiedBranches).toContain(qualBranch);

      // R4a: post-migration branch_tags under logical name parity-equals origin/dev set
      const logicalTags = getBranchTags(db, projectId, sourceId, logicalBranch);
      expect(logicalTags).toHaveLength(2);
      const logicalChunkIds = new Set(logicalTags.map((t) => t.chunk_id));
      expect(logicalChunkIds.has("chunk-001")).toBe(true);
      expect(logicalChunkIds.has("chunk-002")).toBe(true);

      // origin/dev rows gone
      const qualTags = getBranchTags(db, projectId, sourceId, qualBranch);
      expect(qualTags).toHaveLength(0);

      // R4a: SHA row under logical name equals what origin/dev had
      const logicalSha = getLastSha(db, projectId, sourceId, logicalBranch);
      expect(logicalSha).toBe(sha);

      // SHA row under origin/dev gone
      const qualSha = getLastSha(db, projectId, sourceId, qualBranch);
      expect(qualSha).toBeNull();

      // R4a: hashes file renamed — logical exists, qualified gone
      expect(hashFileExists(hashesDir, projectId, sourceId, logicalBranch)).toBe(true);
      expect(hashFileExists(hashesDir, projectId, sourceId, qualBranch)).toBe(false);

      // Hashes content preserved
      const logicalHashes = readHashFile(hashesDir, projectId, sourceId, logicalBranch);
      expect(logicalHashes["src/main.ts"]).toBe("hash-a");
      expect(logicalHashes["src/util.ts"]).toBe("hash-b");

      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Test B — upstream wins on conflict ──────────────────────────────────────

describe("Plan93-B — upstream wins: stale local snapshot evicted", () => {
  it("origin/dev wins over a pre-existing dev snapshot (different chunk sets)", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "branch-tags.db");
    const hashesDir = join(dir, "hashes");

    try {
      const db = makeTestDB(dbPath);
      const projectId = "p93b-proj";
      const sourceId = "code";
      const qualBranch = "origin/dev";
      const logicalBranch = "dev";
      const upstreamSha = "upstream-sha-999";
      const staleSha = "stale-sha-001";

      // Seed: stale local "dev" snapshot (old chunk, old SHA)
      insertTag(db, projectId, sourceId, logicalBranch, "src/old.ts", "stale-chunk");
      insertBranchState(db, projectId, sourceId, logicalBranch, staleSha);
      writeHashFile(hashesDir, projectId, sourceId, logicalBranch, { "src/old.ts": "stale-hash" });

      // Seed: upstream "origin/dev" (fresher chunk set, newer SHA)
      insertTag(db, projectId, sourceId, qualBranch, "src/new.ts", "fresh-chunk");
      insertBranchState(db, projectId, sourceId, qualBranch, upstreamSha);
      writeHashFile(hashesDir, projectId, sourceId, qualBranch, { "src/new.ts": "fresh-hash" });

      const results = await relabelOriginBranchesForPlan93({
        _projects: [{ id: projectId, sources: [{ source_id: sourceId, source_config: { type: "code" } }] }],
        _getDB: () => db,
        _hashesDir: hashesDir,
      });

      expect(results[0]!.status).toBe("ok");

      // Upstream wins: logical branch should have only the fresh chunk
      const logicalTags = getBranchTags(db, projectId, sourceId, logicalBranch);
      expect(logicalTags).toHaveLength(1);
      expect(logicalTags[0]!.chunk_id).toBe("fresh-chunk");
      expect(logicalTags.some((t) => t.chunk_id === "stale-chunk")).toBe(false);

      // SHA: upstream wins
      expect(getLastSha(db, projectId, sourceId, logicalBranch)).toBe(upstreamSha);
      expect(getLastSha(db, projectId, sourceId, qualBranch)).toBeNull();

      // Hashes file: upstream wins
      const hashes = readHashFile(hashesDir, projectId, sourceId, logicalBranch);
      expect(hashes["src/new.ts"]).toBe("fresh-hash");
      expect(hashes["src/old.ts"]).toBeUndefined();

      // Old qualified file gone
      expect(hashFileExists(hashesDir, projectId, sourceId, qualBranch)).toBe(false);

      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Test C — idempotency ─────────────────────────────────────────────────────

describe("Plan93-C — idempotency: second run is a no-op", () => {
  it("running migration twice: second call returns skipped (no origin/ rows left)", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "branch-tags.db");
    const hashesDir = join(dir, "hashes");

    try {
      const db = makeTestDB(dbPath);
      const projectId = "p93c-proj";
      const sourceId = "code";

      insertTag(db, projectId, sourceId, "origin/main", "src/app.ts", "chunk-c1");
      insertBranchState(db, projectId, sourceId, "origin/main", "sha-c");
      writeHashFile(hashesDir, projectId, sourceId, "origin/main", { "src/app.ts": "h1" });

      const projectsList = [{ id: projectId, sources: [{ source_id: sourceId, source_config: { type: "code" as const } }] }];

      // First run
      const first = await relabelOriginBranchesForPlan93({
        _projects: projectsList,
        _getDB: () => db,
        _hashesDir: hashesDir,
      });
      expect(first[0]!.status).toBe("ok");

      // Second run — no origin/ rows remain
      const second = await relabelOriginBranchesForPlan93({
        _projects: projectsList,
        _getDB: () => db,
        _hashesDir: hashesDir,
      });
      expect(second[0]!.status).toBe("skipped");
      expect(second[0]!.reason).toMatch(/no origin\/ labels found/);

      // No double-mutation: logical tags still correct
      const logicalTags = getBranchTags(db, projectId, sourceId, "main");
      expect(logicalTags).toHaveLength(1);
      expect(logicalTags[0]!.chunk_id).toBe("chunk-c1");

      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Test D — ticket sources are skipped ─────────────────────────────────────

describe("Plan93-D — ticket sources skipped", () => {
  it("ticket sources are skipped; code sources processed", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "branch-tags.db");
    const hashesDir = join(dir, "hashes");

    try {
      const db = makeTestDB(dbPath);
      const projectId = "p93d-proj";

      insertTag(db, projectId, "code-src", "origin/dev", "src/x.ts", "chunk-d1");
      insertBranchState(db, projectId, "code-src", "origin/dev", "sha-d");

      const results = await relabelOriginBranchesForPlan93({
        _projects: [{
          id: projectId,
          sources: [
            { source_id: "code-src", source_config: { type: "code" } },
            { source_id: "ticket-src", source_config: { type: "ticket" } },
          ],
        }],
        _getDB: () => db,
        _hashesDir: hashesDir,
      });

      // Ticket source does NOT appear in results
      const ticketResult = results.find((r) => r.sourceId === "ticket-src");
      expect(ticketResult).toBeUndefined();

      // Code source processed
      const codeResult = results.find((r) => r.sourceId === "code-src");
      expect(codeResult?.status).toBe("ok");

      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Test E — no-op when no origin/ rows exist ───────────────────────────────

describe("Plan93-E — no-op when no origin/ rows exist", () => {
  it("skipped for a source with only logical-branch labels (already migrated or fresh)", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "branch-tags.db");
    const hashesDir = join(dir, "hashes");

    try {
      const db = makeTestDB(dbPath);
      const projectId = "p93e-proj";
      const sourceId = "code";

      // Only logical-label rows
      insertTag(db, projectId, sourceId, "dev", "src/main.ts", "chunk-e1");
      insertBranchState(db, projectId, sourceId, "dev", "sha-e");

      const results = await relabelOriginBranchesForPlan93({
        _projects: [{ id: projectId, sources: [{ source_id: sourceId, source_config: { type: "code" } }] }],
        _getDB: () => db,
        _hashesDir: hashesDir,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe("skipped");

      // Existing logical rows untouched
      const tags = getBranchTags(db, projectId, sourceId, "dev");
      expect(tags).toHaveLength(1);

      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Test F — first post-migration poll is a no-op (R4b) ─────────────────────

describe("Plan93-F — first post-migration poll is a no-op (R4b)", () => {
  it("lastIndexedSha under logical name equals the sha origin/<b> had — poller sees no delta", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "branch-tags.db");
    const hashesDir = join(dir, "hashes");

    try {
      const db = makeTestDB(dbPath);
      const projectId = "p93f-proj";
      const sourceId = "code";
      const qualBranch = "origin/beta";
      const logicalBranch = "beta";
      // This SHA is what origin/beta was at when last indexed.
      const lastUpstreamSha = "deadbeef1234567890";

      insertTag(db, projectId, sourceId, qualBranch, "src/beta.ts", "chunk-f1");
      insertBranchState(db, projectId, sourceId, qualBranch, lastUpstreamSha);
      writeHashFile(hashesDir, projectId, sourceId, qualBranch, { "src/beta.ts": "h-f" });

      await relabelOriginBranchesForPlan93({
        _projects: [{ id: projectId, sources: [{ source_id: sourceId, source_config: { type: "code" } }] }],
        _getDB: () => db,
        _hashesDir: hashesDir,
      });

      // R4b: SHA under logical name == what origin/<b> had before migration.
      // The fetch-poller compares getLastIndexedSha(proj, src, logicalBranch) against
      // the current git rev-parse of origin/<b>. If they match, no re-embed is triggered.
      const shaAfter = getLastSha(db, projectId, sourceId, logicalBranch);
      expect(shaAfter).toBe(lastUpstreamSha);

      // No SHA row under qualified name any more
      expect(getLastSha(db, projectId, sourceId, qualBranch)).toBeNull();

      db.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
