/**
 * Plan 95 Phase 4 — rebuild cadence wired into the indexer.
 *
 * Verifies the two pieces that live in src/vector-store.ts / the real LanceDB
 * layer (the cadence *scheduling* logic itself — accumulation, threshold,
 * idle-gated dispatch — is unit-tested against mocks in
 * tests/vector-index-backfill.test.ts):
 *
 *   1. createVectorIndex(tableName, { force: true }) rebuilds the vector index
 *      in place (drop + recreate via `replace: true`) even when one is already
 *      present, and stays idempotent — repeated force rebuilds never leave more
 *      than one live vector-index entry on the table.
 *   2. REGRESSION LOCK: rows added to a table *after* its vector index was
 *      built are still searchable (LanceDB flat-merges the unindexed fragment)
 *      *before* any rebuild runs — and remain searchable *after* a force
 *      rebuild folds them into the index. This is the freshness guarantee the
 *      whole idle-gated (rather than synchronous) rebuild design leans on; a
 *      future change that broke it would silently hide newly-indexed code
 *      until the next idle rebuild happened to fire.
 *
 * Follows the fixture pattern of tests/plan95-vector-index.test.ts: a temp
 * SCRYBE_DATA_DIR + direct upsert()/search()/createVectorIndex() calls, no
 * CLI/daemon dependency, no mocking of vector-store or lancedb itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";

const DIMS = 3;
const PROJECT_ID = "p95-rebuild-cadence-test";

const QUERY = [1, 0, 0];
const V_ORTHOGONAL_A = [0, 1, 0];
const V_ORTHOGONAL_B = [0, 0, 1];
const V_ORTHOGONAL_C = [0, 0.6, 0.8];
// Added post-build — exactly matches QUERY so it must rank first if (and only
// if) it's actually being considered by search(), proving the unindexed
// fragment is flat-merged rather than silently skipped.
const V_NEW_IDENTICAL = [1, 0, 0];

let testDir = "";
let savedDataDir: string | undefined;
let savedMinRows: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "scrybe-p95-rebuild-"));
  mkdirSync(join(testDir, "lancedb"), { recursive: true });
  savedDataDir = process.env["SCRYBE_DATA_DIR"];
  savedMinRows = process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"];
  process.env["SCRYBE_DATA_DIR"] = testDir;
  process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "3"; // small fixture, well under the real default (10,000)
  vi.resetModules();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100));
  for (const [key, saved] of [
    ["SCRYBE_DATA_DIR", savedDataDir],
    ["SCRYBE_VECTOR_INDEX_MIN_ROWS", savedMinRows],
  ] as const) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  if (testDir) {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    testDir = "";
  }
});

async function seedInitialTable(tableName: string) {
  const { upsert } = await import("../src/vector-store.js");
  const chunks = [
    { chunk_id: "chunk-ortho-a", project_id: PROJECT_ID, item_path: "a.ts", content: "ortho a", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
    { chunk_id: "chunk-ortho-b", project_id: PROJECT_ID, item_path: "b.ts", content: "ortho b", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
    { chunk_id: "chunk-ortho-c", project_id: PROJECT_ID, item_path: "c.ts", content: "ortho c", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
  ];
  await upsert(chunks, [V_ORTHOGONAL_A, V_ORTHOGONAL_B, V_ORTHOGONAL_C], tableName, DIMS);
}

async function countVectorIndices(tableName: string): Promise<number> {
  const db = await lancedb.connect(join(testDir, "lancedb"));
  const table = await db.openTable(tableName);
  const indices = await table.listIndices();
  return indices.filter((idx) => idx.columns.includes("vector")).length;
}

describe("Plan 95 Phase 4 — createVectorIndex force rebuild", () => {
  it("force:true rebuilds an already-indexed table in place, staying idempotent (never more than one vector index)", async () => {
    const TABLE_NAME = `p95-force-${Date.now()}`;
    await seedInitialTable(TABLE_NAME);

    const { createVectorIndex } = await import("../src/vector-store.js");
    await createVectorIndex(TABLE_NAME); // initial (plain) build
    expect(await countVectorIndices(TABLE_NAME)).toBe(1);

    // Plain call again is a no-op (already indexed) — sanity check before force.
    await createVectorIndex(TABLE_NAME);
    expect(await countVectorIndices(TABLE_NAME)).toBe(1);

    // Force rebuild must not throw, and must not accumulate a second index entry.
    await expect(createVectorIndex(TABLE_NAME, { force: true })).resolves.not.toThrow();
    expect(await countVectorIndices(TABLE_NAME)).toBe(1);

    // A second force rebuild is equally safe.
    await expect(createVectorIndex(TABLE_NAME, { force: true })).resolves.not.toThrow();
    expect(await countVectorIndices(TABLE_NAME)).toBe(1);
  });

  it("force:true still respects the row-count floor (does nothing on a below-threshold table)", async () => {
    process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "10000"; // restore the real default — fixture has 3 rows
    vi.resetModules();

    const TABLE_NAME = `p95-force-below-${Date.now()}`;
    await seedInitialTable(TABLE_NAME);

    const { createVectorIndex } = await import("../src/vector-store.js");
    await createVectorIndex(TABLE_NAME, { force: true });
    expect(await countVectorIndices(TABLE_NAME)).toBe(0);
  });
});

describe("Plan 95 Phase 4 — REGRESSION LOCK: freshness across the rebuild boundary", () => {
  it("rows added after the index was built are searchable BEFORE a rebuild (flat-merge), and remain searchable AFTER one", async () => {
    const TABLE_NAME = `p95-freshness-${Date.now()}`;
    await seedInitialTable(TABLE_NAME);

    const { createVectorIndex, upsert, search } = await import("../src/vector-store.js");

    // Build the index on the initial 3 orthogonal rows — none of them match QUERY.
    await createVectorIndex(TABLE_NAME);
    expect(await countVectorIndices(TABLE_NAME)).toBe(1);

    // Simulate an incremental upsert landing AFTER the index build — this row is
    // NOT part of the built index, only in a fresh unindexed Lance fragment.
    await upsert(
      [{ chunk_id: "chunk-new-identical", project_id: PROJECT_ID, item_path: "new.ts", content: "new identical", start_line: 1, end_line: 2, language: "ts", symbol_name: "" }],
      [V_NEW_IDENTICAL],
      TABLE_NAME,
      DIMS,
    );

    // BEFORE any rebuild: the new row must still be found and ranked top —
    // this is the flat-merge guarantee the idle-gated (non-blocking) rebuild
    // design depends on. If this ever regresses, freshly indexed code would
    // be invisible to search until the next idle rebuild happens to fire.
    {
      const results = await search(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.chunk_id).toBe("chunk-new-identical");
    }

    // Now force-rebuild (what the idle-gated cadence eventually does) and
    // confirm the row is still correctly ranked AFTER the rebuild folds it
    // into the index, with no duplicate index entries left behind.
    await createVectorIndex(TABLE_NAME, { force: true });
    expect(await countVectorIndices(TABLE_NAME)).toBe(1);
    {
      const results = await search(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.chunk_id).toBe("chunk-new-identical");
    }
  });
});
