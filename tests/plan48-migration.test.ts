/**
 * Plan 48 — chunk-id-rehash migration: path-rewrite + dedup tests.
 * Tests A, B, C, D.
 *
 * These tests build old-schema knowledge/code tables in a temp DATA_DIR,
 * run migrateTable, and assert that path-rewrite, dedup, and sidecar
 * fields are all correct — then verify idempotency on second run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { normalizeContent } from "../src/normalize.js";
import {
  migrateTable,
  makeOldChunkIdV1,
  makeNewChunkIdV2,
} from "../src/migrations/chunk-id-rehash.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const FAKE_DIMS = 4;
const PROJECT_ID = "test-project-48";
const SOURCE_ID = "test-source-48";

// ─── Old-schema Arrow schemas ─────────────────────────────────────────────────

function makeOldKnowledgeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("source_path", new Utf8(), false),   // old name → item_path
    new Field("source_url", new Utf8(), false),    // old name → item_url
    new Field("source_type", new Utf8(), false),   // old name → item_type
    new Field("author", new Utf8(), false),
    new Field("timestamp", new Utf8(), false),
    new Field("content", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dims, new Field("item", new Float32(), false)),
      false
    ),
  ]);
}

function makeOldCodeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("file_path", new Utf8(), false),     // old name → item_path
    new Field("content", new Utf8(), false),
    new Field("start_line", new Int32(), false),
    new Field("end_line", new Int32(), false),
    new Field("language", new Utf8(), false),
    new Field("symbol_name", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dims, new Field("item", new Float32(), false)),
      false
    ),
  ]);
}

// ─── Sidecar helpers ──────────────────────────────────────────────────────────

function readTestSidecar(dbPath: string, tableName: string): Record<string, unknown> | null {
  const p = join(dbPath, `${tableName}-meta.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// ─── Per-test setup: isolated DB dir ─────────────────────────────────────────

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-plan48-migration-"));
  dbPath = join(dataDir, "lancedb");
  mkdirSync(dbPath, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ─── Test A — knowledge table: stale paths + distinct dupes (ticket_comment) ──
//
// 5 ticket_comment rows with stale tickets/51 path but distinct item_urls →
// distinct chunk_ids after path-rewrite → all 5 survive dedup.
// 2 ticket rows with stale tickets/100 path.
// Total 7 rows → 7 rows post-migration (no dedup collapse needed here).

describe("Plan48-A — knowledge table with stale paths (no collapse needed)", () => {
  it("rewrites tickets/ paths, recomputes chunk_ids, emits sidecar flags — all 7 rows survive", async () => {
    const tableName = "p48a-knowledge-stale-paths";

    // Build 5 ticket_comment rows with stale paths and distinct note IDs
    const commentRows: Array<Record<string, unknown>> = [
      181450, 181460, 181470, 181480, 181490,
    ].map((noteId, idx) => {
      const content = `migrated tests ${noteId}`;
      const sourcePath = "tickets/51";
      const sourceUrl = `https://gitlab.example.com/issues/51#note_${noteId}`;
      const sourceType = "ticket_comment";
      const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", content);
      return {
        chunk_id: chunkId,
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_path: sourcePath,
        source_url: sourceUrl,
        source_type: sourceType,
        author: `author-${idx}`,
        timestamp: "2024-01-01T00:00:00Z",
        content,
        vector: new Float32Array(FAKE_DIMS).fill(0.1 * (idx + 1)),
      };
    });

    // Build 2 ticket (body) rows
    const ticketRows: Array<Record<string, unknown>> = [0, 1].map((idx) => {
      const content = `distinct issue body content ${idx}`;
      const sourcePath = "tickets/100";
      const sourceUrl = `https://gitlab.example.com/issues/100`;
      const sourceType = "ticket";
      const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", content);
      return {
        chunk_id: chunkId,
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_path: sourcePath,
        source_url: sourceUrl,
        source_type: sourceType,
        author: `author-t${idx}`,
        timestamp: "2024-01-01T00:00:00Z",
        content,
        vector: new Float32Array(FAKE_DIMS).fill(0.5 * (idx + 1)),
      };
    });

    const allRows = [...commentRows, ...ticketRows];

    const db = await lancedb.connect(dbPath);
    await db.createTable(tableName, allRows as any, { schema: makeOldKnowledgeSchema(FAKE_DIMS) });

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 20,
      _dbPath: dbPath,
    });

    expect(result.status).toBe("ok");

    // All 7 rows should survive (distinct chunk_ids after path-rewrite)
    const db2 = await lancedb.connect(dbPath);
    const table = await db2.openTable(tableName);
    const migratedRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
    expect(migratedRows.length).toBe(7);

    // Verify no tickets/ paths survive
    for (const row of migratedRows) {
      const itemPath = String(row["item_path"] ?? "");
      expect(itemPath).not.toMatch(/^tickets\//);
      expect(itemPath).toMatch(/^issues\//);
    }

    // Verify ticket_comment rows have correct issues/N#note_M paths
    const commentMigrated = migratedRows.filter((r) => String(r["item_type"] ?? "") === "ticket_comment");
    expect(commentMigrated.length).toBe(5);
    for (const row of commentMigrated) {
      expect(String(row["item_path"])).toMatch(/^issues\/51#note_\d+$/);
    }

    // Verify ticket body rows have correct issues/N paths
    const ticketMigrated = migratedRows.filter((r) => String(r["item_type"] ?? "") === "ticket");
    expect(ticketMigrated.length).toBe(2);
    for (const row of ticketMigrated) {
      expect(String(row["item_path"])).toBe("issues/100");
    }

    // Verify chunk_ids are correctly computed with new paths
    for (const row of migratedRows) {
      const content = String(row["content"] ?? "");
      const itemPath = String(row["item_path"] ?? "");
      const itemUrl = String(row["item_url"] ?? "");
      const itemType = String(row["item_type"] ?? "");
      const expectedId = makeNewChunkIdV2(
        PROJECT_ID, SOURCE_ID, itemPath, itemUrl, itemType, normalizeContent(content)
      );
      expect(row["chunk_id"]).toBe(expectedId);
    }

    // Sidecar must have all three fields
    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
    expect(meta?.["dedup_done"]).toBe(true);
    expect(meta?.["item_path_rewrite_done"]).toBe(true);
  });
});

// ─── Test B — TRUE dupes: 5 rows with identical inputs collapse to 1 ──────────

describe("Plan48-B — knowledge table with TRUE dupes that collapse to 1", () => {
  it("collapses 5 identical rows to 1 via dedup pass; sidecar flags written", async () => {
    const tableName = "p48b-knowledge-true-dupes";

    // 5 rows with identical (project_id, source_id, source_path, source_url, source_type, content).
    // Under scheme-1 hash: all share the same chunk_id.
    // After path-rewrite (tickets/51 → issues/51) + scheme-2 rehash, all produce the same newChunkId.
    // Dedup collapse: 5 → 1.
    const sharedContent = "migrated tests";
    const sharedSourcePath = "tickets/51";
    const sharedSourceUrl = "https://gitlab.example.com/issues/51";
    const sharedSourceType = "ticket";
    const sharedChunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", sharedContent);

    const rows: Array<Record<string, unknown>> = Array.from({ length: 5 }, (_, i) => ({
      chunk_id: sharedChunkId,
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      source_path: sharedSourcePath,
      source_url: sharedSourceUrl,
      source_type: sharedSourceType,
      author: `author-${i}`,
      timestamp: "2024-01-01T00:00:00Z",
      content: sharedContent,
      vector: new Float32Array(FAKE_DIMS).fill(0.3),
    }));

    const db = await lancedb.connect(dbPath);
    await db.createTable(tableName, rows as any, { schema: makeOldKnowledgeSchema(FAKE_DIMS) });

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });

    expect(result.status).toBe("ok");

    // 5 dupes → 1 row after dedup
    const db2 = await lancedb.connect(dbPath);
    const table = await db2.openTable(tableName);
    const migratedRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
    expect(migratedRows.length).toBe(1);

    // The surviving row must have the rewritten path
    expect(String(migratedRows[0]!["item_path"])).toBe("issues/51");

    // Chunk_id must match scheme-2 hash with rewritten path
    const expectedId = makeNewChunkIdV2(
      PROJECT_ID, SOURCE_ID,
      "issues/51",
      sharedSourceUrl,
      sharedSourceType,
      normalizeContent(sharedContent)
    );
    expect(migratedRows[0]!["chunk_id"]).toBe(expectedId);

    // Sidecar must have all three fields
    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
    expect(meta?.["dedup_done"]).toBe(true);
    expect(meta?.["item_path_rewrite_done"]).toBe(true);
  });
});

// ─── Test C — code table: path-rewrite is a no-op ────────────────────────────

describe("Plan48-C — code table: path-rewrite no-op, chunk_id recomputed correctly", () => {
  it("code row with src/ path is untouched by path-rewrite; chunk_id recomputed under scheme-2", async () => {
    const tableName = "p48c-code-noop";

    const content = "export function foo() {}";
    const filePath = "src/foo.ts";
    const language = "typescript";
    const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, language, content);

    const rows: Array<Record<string, unknown>> = [
      {
        chunk_id: chunkId,
        project_id: PROJECT_ID,
        file_path: filePath,
        content,
        start_line: 1,
        end_line: 3,
        language,
        symbol_name: "foo",
        vector: new Float32Array(FAKE_DIMS).fill(0.7),
      },
    ];

    const db = await lancedb.connect(dbPath);
    await db.createTable(tableName, rows as any, { schema: makeOldCodeSchema(FAKE_DIMS) });

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });

    expect(result.status).toBe("ok");
    expect(result.rows_rehashed).toBe(1);

    const db2 = await lancedb.connect(dbPath);
    const table = await db2.openTable(tableName);
    const migratedRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
    expect(migratedRows.length).toBe(1);

    // item_path must be unchanged (no tickets/ prefix to rewrite)
    expect(String(migratedRows[0]!["item_path"])).toBe("src/foo.ts");

    // chunk_id must be the correct scheme-2 hash for code
    const expectedId = makeNewChunkIdV2(
      PROJECT_ID, SOURCE_ID,
      "src/foo.ts",
      "",           // itemUrl = "" for code
      "code",       // itemType = "code" for code
      normalizeContent(content)
    );
    expect(migratedRows[0]!["chunk_id"]).toBe(expectedId);

    // Sidecar must have all three fields
    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
    expect(meta?.["dedup_done"]).toBe(true);
    expect(meta?.["item_path_rewrite_done"]).toBe(true);
  });
});

// ─── Test D — idempotency: second run is a no-op ─────────────────────────────

describe("Plan48-D — idempotency: second migrate call returns skipped", () => {
  it("running migrate twice: second run returns status=skipped, row count unchanged", async () => {
    const tableName = "p48d-idempotency";

    // Use the same setup as Test A (7 rows with stale paths)
    const commentRows: Array<Record<string, unknown>> = [181450, 181460].map((noteId, idx) => {
      const content = `idempotency test content ${noteId}`;
      const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", content);
      return {
        chunk_id: chunkId,
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_path: "tickets/51",
        source_url: `https://gitlab.example.com/issues/51#note_${noteId}`,
        source_type: "ticket_comment",
        author: `author-${idx}`,
        timestamp: "2024-01-01T00:00:00Z",
        content,
        vector: new Float32Array(FAKE_DIMS).fill(0.1 * (idx + 1)),
      };
    });

    const db = await lancedb.connect(dbPath);
    await db.createTable(tableName, commentRows as any, { schema: makeOldKnowledgeSchema(FAKE_DIMS) });

    // First run — migrates
    const first = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });
    expect(first.status).toBe("ok");

    // Row count after first run
    const db2 = await lancedb.connect(dbPath);
    const table2 = await db2.openTable(tableName);
    const countAfterFirst = await table2.countRows();
    expect(countAfterFirst).toBe(2); // both rows have distinct chunk_ids

    // Second run — must be a no-op
    const second = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });
    expect(second.status).toBe("skipped");

    // Row count must be unchanged
    const db3 = await lancedb.connect(dbPath);
    const table3 = await db3.openTable(tableName);
    const countAfterSecond = await table3.countRows();
    expect(countAfterSecond).toBe(countAfterFirst);

    // Sidecar fields must still be present and unchanged
    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
    expect(meta?.["dedup_done"]).toBe(true);
    expect(meta?.["item_path_rewrite_done"]).toBe(true);
  });
});
