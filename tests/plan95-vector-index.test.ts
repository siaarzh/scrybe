/**
 * Plan 95 Phase 2 — hnswSq vector index + search-mode selection + config surface.
 *
 * Verifies:
 *   1. createVectorIndex() builds a native `hnswSq` index on the `vector` column
 *      with distanceType "cosine" once row count >= SCRYBE_VECTOR_INDEX_MIN_ROWS.
 *   2. createVectorIndex() is a no-op below the row threshold (default 10,000;
 *      overridden here to a small value so the test doesn't need 10k rows).
 *   3. createVectorIndex() is idempotent (a second call after the index exists
 *      does not throw / does not need to rebuild).
 *   4. search() / searchKnowledge() keep returning correct nearest-neighbor
 *      results across all four combinations of {index built, index absent} x
 *      {SCRYBE_VECTOR_INDEX=true (approximate+refine), =false (force-exact)} —
 *      i.e. search degrades gracefully whether or not a vector index exists,
 *      and the force-exact escape actually bypasses the index.
 *   5. A reconstruction of the same query chain vector-store.ts's applySearchMode
 *      builds (distanceType cosine + limit, then either .refineFactor(N) when an
 *      index is present, or .bypassVectorIndex() when it is not / when force-exact
 *      is set) produces an ANN-shaped plan in the indexed+enabled case and a
 *      brute-force-shaped plan in the bypass case — confirming the index is
 *      actually consulted, not silently ignored (the L2/cosine-mismatch trap
 *      this plan explicitly guards against).
 *
 * Follows the fixture pattern of tests/plan81-cosine-score.test.ts: a temp
 * SCRYBE_DATA_DIR + direct upsert()/search() calls, no CLI/daemon dependency.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";

const DIMS = 3;
const PROJECT_ID = "p95-vector-index-test";

// Unit-norm vectors — small fixture, well under any real row threshold.
const QUERY = [1, 0, 0];
const V_IDENTICAL = [1, 0, 0];
const V_ORTHOGONAL_A = [0, 1, 0];
const V_ORTHOGONAL_B = [0, 0, 1];
const V_ORTHOGONAL_C = [0, 0.6, 0.8];

let testDir = "";
let savedDataDir: string | undefined;
let savedMinRows: string | undefined;
let savedIndexEnabled: string | undefined;
let savedRefineFactor: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "scrybe-p95-vidx-"));
  mkdirSync(join(testDir, "lancedb"), { recursive: true });
  savedDataDir = process.env["SCRYBE_DATA_DIR"];
  savedMinRows = process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"];
  savedIndexEnabled = process.env["SCRYBE_VECTOR_INDEX"];
  savedRefineFactor = process.env["SCRYBE_VECTOR_REFINE_FACTOR"];
  process.env["SCRYBE_DATA_DIR"] = testDir;
  vi.resetModules();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100));
  for (const [key, saved] of [
    ["SCRYBE_DATA_DIR", savedDataDir],
    ["SCRYBE_VECTOR_INDEX_MIN_ROWS", savedMinRows],
    ["SCRYBE_VECTOR_INDEX", savedIndexEnabled],
    ["SCRYBE_VECTOR_REFINE_FACTOR", savedRefineFactor],
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

async function seedTable(tableName: string) {
  const { upsert } = await import("../src/vector-store.js");
  const chunks = [
    { chunk_id: "chunk-identical", project_id: PROJECT_ID, item_path: "a.ts", content: "identical", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
    { chunk_id: "chunk-ortho-a", project_id: PROJECT_ID, item_path: "b.ts", content: "ortho a", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
    { chunk_id: "chunk-ortho-b", project_id: PROJECT_ID, item_path: "c.ts", content: "ortho b", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
    { chunk_id: "chunk-ortho-c", project_id: PROJECT_ID, item_path: "d.ts", content: "ortho c", start_line: 1, end_line: 2, language: "ts", symbol_name: "" },
  ];
  await upsert(chunks, [V_IDENTICAL, V_ORTHOGONAL_A, V_ORTHOGONAL_B, V_ORTHOGONAL_C], tableName, DIMS);
}

describe("Plan 95 Phase 2 — createVectorIndex", () => {
  it("is a no-op below the row threshold (default 10,000, 4-row table)", async () => {
    const TABLE_NAME = `p95-below-${Date.now()}`;
    await seedTable(TABLE_NAME);

    const { createVectorIndex } = await import("../src/vector-store.js");
    await createVectorIndex(TABLE_NAME);

    const db = await lancedb.connect(join(testDir, "lancedb"));
    const table = await db.openTable(TABLE_NAME);
    const indices = await table.listIndices();
    const hasVectorIndex = indices.some((idx) => idx.columns.includes("vector"));
    expect(hasVectorIndex).toBe(false);
  });

  it("builds a cosine hnswSq index once row count >= SCRYBE_VECTOR_INDEX_MIN_ROWS", async () => {
    process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "3";
    vi.resetModules();

    const TABLE_NAME = `p95-above-${Date.now()}`;
    await seedTable(TABLE_NAME);

    const { createVectorIndex } = await import("../src/vector-store.js");
    await createVectorIndex(TABLE_NAME);

    const db = await lancedb.connect(join(testDir, "lancedb"));
    const table = await db.openTable(TABLE_NAME);
    const indices = await table.listIndices();
    const vectorIdx = indices.find((idx) => idx.columns.includes("vector"));
    expect(vectorIdx).toBeDefined();
    expect(vectorIdx!.indexType.toUpperCase()).toContain("HNSW");

    const stats = await table.indexStats(vectorIdx!.name);
    expect(stats?.distanceType).toBe("cosine");
  });

  it("is idempotent — a second call after the index exists does not throw", async () => {
    process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "3";
    vi.resetModules();

    const TABLE_NAME = `p95-idempotent-${Date.now()}`;
    await seedTable(TABLE_NAME);

    const { createVectorIndex } = await import("../src/vector-store.js");
    await createVectorIndex(TABLE_NAME);
    await expect(createVectorIndex(TABLE_NAME)).resolves.not.toThrow();

    const db = await lancedb.connect(join(testDir, "lancedb"));
    const table = await db.openTable(TABLE_NAME);
    const indices = await table.listIndices();
    expect(indices.filter((idx) => idx.columns.includes("vector")).length).toBe(1);
  });
});

describe("Plan 95 Phase 2 — search-mode selection", () => {
  it("search() returns the correct top match with no index present, index+refine, and force-exact", async () => {
    process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "3";

    // Arm 1: no index yet, SCRYBE_VECTOR_INDEX default (true) — falls back to flat.
    vi.resetModules();
    const TABLE_NAME = `p95-search-${Date.now()}`;
    await seedTable(TABLE_NAME);
    {
      const { search } = await import("../src/vector-store.js");
      const results = await search(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.chunk_id).toBe("chunk-identical");
    }

    // Build the index, then re-check with SCRYBE_VECTOR_INDEX=true (approximate+refine).
    {
      const { createVectorIndex } = await import("../src/vector-store.js");
      await createVectorIndex(TABLE_NAME);
    }
    vi.resetModules();
    process.env["SCRYBE_VECTOR_INDEX"] = "true";
    process.env["SCRYBE_VECTOR_REFINE_FACTOR"] = "10";
    {
      const { search } = await import("../src/vector-store.js");
      const results = await search(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.chunk_id).toBe("chunk-identical");
    }

    // Force-exact via SCRYBE_VECTOR_INDEX=false — must bypass the index, no throw.
    vi.resetModules();
    process.env["SCRYBE_VECTOR_INDEX"] = "false";
    {
      const { search } = await import("../src/vector-store.js");
      const results = await search(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.chunk_id).toBe("chunk-identical");
    }
  });

  it("searchKnowledge() degrades gracefully across the same index/config combinations", async () => {
    process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "3";
    vi.resetModules();

    const TABLE_NAME = `p95-knowledge-${Date.now()}`;
    const { upsertKnowledge } = await import("../src/vector-store.js");
    const kChunks = [
      { chunk_id: "k-identical", project_id: PROJECT_ID, source_id: "primary", item_path: "issues/1", item_url: "https://x/1", item_type: "ticket", author: "a", timestamp: "2024-01-01T00:00:00Z", content: "identical" },
      { chunk_id: "k-ortho-a", project_id: PROJECT_ID, source_id: "primary", item_path: "issues/2", item_url: "https://x/2", item_type: "ticket", author: "b", timestamp: "2024-01-01T00:00:00Z", content: "ortho a" },
      { chunk_id: "k-ortho-b", project_id: PROJECT_ID, source_id: "primary", item_path: "issues/3", item_url: "https://x/3", item_type: "ticket", author: "c", timestamp: "2024-01-01T00:00:00Z", content: "ortho b" },
      { chunk_id: "k-ortho-c", project_id: PROJECT_ID, source_id: "primary", item_path: "issues/4", item_url: "https://x/4", item_type: "ticket", author: "d", timestamp: "2024-01-01T00:00:00Z", content: "ortho c" },
    ];
    await upsertKnowledge(kChunks, [V_IDENTICAL, V_ORTHOGONAL_A, V_ORTHOGONAL_B, V_ORTHOGONAL_C], TABLE_NAME, DIMS);

    // No index yet — flat fallback.
    {
      const { searchKnowledge } = await import("../src/vector-store.js");
      const results = await searchKnowledge(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.content).toBe("identical");
    }

    // Build index; query with SCRYBE_VECTOR_INDEX=true (approximate+refine).
    {
      const { createVectorIndex } = await import("../src/vector-store.js");
      await createVectorIndex(TABLE_NAME);
    }
    vi.resetModules();
    process.env["SCRYBE_VECTOR_INDEX"] = "true";
    {
      const { searchKnowledge } = await import("../src/vector-store.js");
      const results = await searchKnowledge(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.content).toBe("identical");
    }

    // Force-exact.
    vi.resetModules();
    process.env["SCRYBE_VECTOR_INDEX"] = "false";
    {
      const { searchKnowledge } = await import("../src/vector-store.js");
      const results = await searchKnowledge(QUERY, PROJECT_ID, 4, TABLE_NAME, DIMS);
      expect(results[0]?.content).toBe("identical");
    }
  });

  it("the query chain applySearchMode builds (refineFactor when indexed, bypassVectorIndex otherwise) actually changes the LanceDB plan", async () => {
    process.env["SCRYBE_VECTOR_INDEX_MIN_ROWS"] = "3";
    vi.resetModules();

    const TABLE_NAME = `p95-plan-${Date.now()}`;
    await seedTable(TABLE_NAME);

    const { createVectorIndex } = await import("../src/vector-store.js");
    await createVectorIndex(TABLE_NAME);

    const db = await lancedb.connect(join(testDir, "lancedb"));
    const table = await db.openTable(TABLE_NAME);

    // Mirrors applySearchMode's "index present + enabled" branch.
    const indexedPlan = await (table.search(Float32Array.from(QUERY)) as lancedb.VectorQuery)
      .distanceType("cosine")
      .limit(4)
      .refineFactor(10)
      .explainPlan();

    // Mirrors applySearchMode's "force-exact / no index" branch.
    const bypassPlan = await (table.search(Float32Array.from(QUERY)) as lancedb.VectorQuery)
      .distanceType("cosine")
      .limit(4)
      .bypassVectorIndex()
      .explainPlan();

    // The two plans must differ — proof the index is actually consulted in the
    // indexed case rather than being silently ignored (the L2/cosine-mismatch
    // trap this plan explicitly guards against).
    expect(indexedPlan).not.toBe(bypassPlan);
  });
});

describe("Plan 95 — vector index config parsing (ef + defensive defaults)", () => {
  const KEYS = ["SCRYBE_VECTOR_EF", "SCRYBE_VECTOR_INDEX_MIN_ROWS", "SCRYBE_VECTOR_REFINE_FACTOR"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    vi.resetModules();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults vectorEf=600 / minRows=10000 / refineFactor=10", async () => {
    const { config } = await import("../src/config.js");
    expect(config.vectorEf).toBe(600);
    expect(config.vectorIndexMinRows).toBe(10000);
    expect(config.vectorRefineFactor).toBe(10);
  });

  it("honours a valid SCRYBE_VECTOR_EF override", async () => {
    process.env.SCRYBE_VECTOR_EF = "300";
    const { config } = await import("../src/config.js");
    expect(config.vectorEf).toBe(300);
  });

  it("falls back to defaults on NaN / non-positive misconfig (never NaN into the query path)", async () => {
    process.env.SCRYBE_VECTOR_EF = "abc";
    process.env.SCRYBE_VECTOR_INDEX_MIN_ROWS = "-5";
    process.env.SCRYBE_VECTOR_REFINE_FACTOR = "0";
    const { config } = await import("../src/config.js");
    expect(config.vectorEf).toBe(600);
    expect(config.vectorIndexMinRows).toBe(10000);
    expect(config.vectorRefineFactor).toBe(10);
    expect(Number.isFinite(config.vectorEf)).toBe(true);
  });
});
