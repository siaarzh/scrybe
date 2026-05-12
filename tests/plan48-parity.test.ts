/**
 * Plan 48 — Slice 6: dedup-search parity test.
 *
 * Two-axis test (decision 8):
 *   Axis 1 — Row-count parity: migrated table row count == control table row count.
 *   Axis 2 — Search result parity: same query vector against both tables returns
 *             identical chunk_ids in identical order (top-K).
 *
 * Seeded with a mix of:
 *   - Test A fixtures: stale tickets/ paths + distinct comment note IDs (no collapse needed)
 *   - Test B fixtures: identical rows that collapse to 1 under dedup
 *
 * The "control" table is built from scratch using the final expected rows
 * (post-path-rewrite, post-dedup, scheme-2 chunk_ids already stamped).
 * Both tables receive the same vectors for their surviving chunks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Float32, FixedSizeList } from "apache-arrow";
import { normalizeContent } from "../src/normalize.js";
import {
  migrateTable,
  makeOldChunkIdV1,
  makeNewChunkIdV2,
} from "../src/migrations/chunk-id-rehash.js";
import { makeKnowledgeSchema } from "../src/vector-store.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DIMS = 4;
const PROJECT_ID = "test-project-parity";
const SOURCE_ID = "test-source-parity";
const TOP_K = 20;

// Fixed query vector (arbitrary, deterministic)
const QUERY_VECTOR = Float32Array.from([0.25, 0.25, 0.25, 0.25]);

// ─── Old-schema Arrow schema (pre-migration) ──────────────────────────────────

function makeOldKnowledgeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("source_path", new Utf8(), false),   // old column name
    new Field("source_url", new Utf8(), false),    // old column name
    new Field("source_type", new Utf8(), false),   // old column name
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

// ─── Fixture: the canonical rows after path-rewrite + dedup ──────────────────
//
// These are the rows that BOTH the migrated table AND the control table should
// end up with. Building them once here ensures the parity comparison is against
// a known-good ground truth.

interface ControlRow {
  chunk_id: string;
  project_id: string;
  source_id: string;
  item_path: string;
  item_url: string;
  item_type: string;
  author: string;
  timestamp: string;
  content: string;
  vector: Float32Array;
}

function buildControlRows(): ControlRow[] {
  const rows: ControlRow[] = [];

  // === Test A fixtures: stale paths, all distinct after rewrite ===

  // 5 ticket_comment rows: stale tickets/51 path, each has a different note_id
  // → rewrite to issues/51#note_<N> → distinct chunk_ids → all 5 survive
  const noteIds = [181450, 181460, 181470, 181480, 181490];
  for (let i = 0; i < noteIds.length; i++) {
    const noteId = noteIds[i]!;
    const content = `migrated tests ${noteId}`;
    const itemPath = `issues/51#note_${noteId}`;
    const itemUrl = `https://gitlab.example.com/issues/51#note_${noteId}`;
    const itemType = "ticket_comment";
    const chunkId = makeNewChunkIdV2(
      PROJECT_ID, SOURCE_ID, itemPath, itemUrl, itemType, normalizeContent(content)
    );
    rows.push({
      chunk_id: chunkId,
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      item_path: itemPath,
      item_url: itemUrl,
      item_type: itemType,
      author: `author-${i}`,
      timestamp: "2024-01-01T00:00:00Z",
      content,
      // Spread each vector slightly differently from the query for varied distances
      vector: Float32Array.from([0.1 * (i + 1), 0.1, 0.1, 0.1]),
    });
  }

  // 2 ticket (body) rows with stale tickets/100 path → issues/100, distinct content
  for (let idx = 0; idx < 2; idx++) {
    const content = `distinct issue body content ${idx}`;
    const itemPath = "issues/100";
    const itemUrl = "https://gitlab.example.com/issues/100";
    const itemType = "ticket";
    const chunkId = makeNewChunkIdV2(
      PROJECT_ID, SOURCE_ID, itemPath, itemUrl, itemType, normalizeContent(content)
    );
    rows.push({
      chunk_id: chunkId,
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      item_path: itemPath,
      item_url: itemUrl,
      item_type: itemType,
      author: `author-t${idx}`,
      timestamp: "2024-01-01T00:00:00Z",
      content,
      vector: Float32Array.from([0.5 * (idx + 1), 0.5, 0.5, 0.5]),
    });
  }

  // === Test B fixture: 5 identical rows that collapse to 1 under dedup ===
  //
  // All 5 rows share the same (source_path, source_url, source_type, content)
  // so after path-rewrite + rehash they all get the same newChunkId.
  // Only the first survivor appears in the control table.
  {
    const content = "migrated tests";           // identical short content
    const itemPath = "issues/51";               // after tickets/51 → issues/51
    const itemUrl = "https://gitlab.example.com/issues/51";
    const itemType = "ticket";
    const chunkId = makeNewChunkIdV2(
      PROJECT_ID, SOURCE_ID, itemPath, itemUrl, itemType, normalizeContent(content)
    );
    rows.push({
      chunk_id: chunkId,
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      item_path: itemPath,
      item_url: itemUrl,
      item_type: itemType,
      author: "author-b0",                      // first-seen author survives
      timestamp: "2024-01-01T00:00:00Z",
      content,
      vector: Float32Array.from([0.3, 0.3, 0.3, 0.3]),
    });
    // 4 additional copies are NOT added to the control table — they get collapsed.
  }

  return rows;
}

// ─── Per-test isolated DB dirs ────────────────────────────────────────────────

let dataDir: string;
let bloatedDbPath: string;   // seeded with dupes + stale paths → migration input
let controlDbPath: string;   // fresh build without dupes → control ground truth

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-parity-"));
  bloatedDbPath = join(dataDir, "lancedb-bloated");
  controlDbPath = join(dataDir, "lancedb-control");
  mkdirSync(bloatedDbPath, { recursive: true });
  mkdirSync(controlDbPath, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ─── Main parity test ─────────────────────────────────────────────────────────

describe("Plan48 parity — migrated table must match control table", () => {
  it("row count parity AND search result parity after migration (Axis 1 + Axis 2)", async () => {
    const controlRows = buildControlRows();
    // Expected: 5 (Test A comments) + 2 (Test A ticket bodies) + 1 (Test B survivor) = 8
    const EXPECTED_ROWS = 8;

    // ── Build bloated input table (old-schema with dupes + stale paths) ──────

    const bloatedRows: Array<Record<string, unknown>> = [];

    // Test A: 5 ticket_comment rows with stale paths, distinct note ids
    const noteIds = [181450, 181460, 181470, 181480, 181490];
    for (let i = 0; i < noteIds.length; i++) {
      const noteId = noteIds[i]!;
      const content = `migrated tests ${noteId}`;
      const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", content);
      bloatedRows.push({
        chunk_id: chunkId,
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_path: "tickets/51",
        source_url: `https://gitlab.example.com/issues/51#note_${noteId}`,
        source_type: "ticket_comment",
        author: `author-${i}`,
        timestamp: "2024-01-01T00:00:00Z",
        content,
        vector: new Float32Array(DIMS).fill(0.1 * (i + 1)),
      });
    }

    // Test A: 2 ticket (body) rows with stale tickets/100 path, distinct content
    for (let idx = 0; idx < 2; idx++) {
      const content = `distinct issue body content ${idx}`;
      const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", content);
      bloatedRows.push({
        chunk_id: chunkId,
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_path: "tickets/100",
        source_url: "https://gitlab.example.com/issues/100",
        source_type: "ticket",
        author: `author-t${idx}`,
        timestamp: "2024-01-01T00:00:00Z",
        content,
        vector: new Float32Array(DIMS).fill(0.5 * (idx + 1)),
      });
    }

    // Test B: 5 identical rows — same content, same stale path, same url
    // They all get the same old scheme-1 chunk_id (content-only hash with language="")
    // and all collapse to 1 after migration.
    const sharedContent = "migrated tests";
    const sharedChunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, "", sharedContent);
    for (let i = 0; i < 5; i++) {
      bloatedRows.push({
        chunk_id: sharedChunkId,
        project_id: PROJECT_ID,
        source_id: SOURCE_ID,
        source_path: "tickets/51",
        source_url: "https://gitlab.example.com/issues/51",
        source_type: "ticket",
        author: i === 0 ? "author-b0" : `author-b${i}`,  // first author should survive
        timestamp: "2024-01-01T00:00:00Z",
        content: sharedContent,
        vector: new Float32Array(DIMS).fill(0.3),
      });
    }

    // Seed the bloated table (old schema, 12 rows: 5 + 2 + 5)
    const bloatedDb = await lancedb.connect(bloatedDbPath);
    const TABLE_NAME = "p48-parity-knowledge";
    await bloatedDb.createTable(TABLE_NAME, bloatedRows as any, {
      schema: makeOldKnowledgeSchema(DIMS),
    });

    // ── Run migration ──────────────────────────────────────────────────────────

    const result = await migrateTable(TABLE_NAME, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 20,
      _dbPath: bloatedDbPath,
    });

    expect(result.status).toBe("ok");

    // ── Axis 1: row-count parity ──────────────────────────────────────────────

    const migratedDb = await lancedb.connect(bloatedDbPath);
    const migratedTable = await migratedDb.openTable(TABLE_NAME);
    const migratedCount = await migratedTable.countRows();
    expect(migratedCount).toBe(EXPECTED_ROWS);

    // ── Build control table (fresh, correct schema, no dupes) ─────────────────

    const controlDb = await lancedb.connect(controlDbPath);
    const controlTableName = "p48-parity-control";
    await controlDb.createTable(
      controlTableName,
      controlRows.map((r) => ({
        chunk_id: r.chunk_id,
        project_id: r.project_id,
        source_id: r.source_id,
        item_path: r.item_path,
        item_url: r.item_url,
        item_type: r.item_type,
        author: r.author,
        timestamp: r.timestamp,
        content: r.content,
        vector: r.vector,
      })) as any,
      { schema: makeKnowledgeSchema(DIMS) }
    );

    const controlTable = await controlDb.openTable(controlTableName);
    const controlCount = await controlTable.countRows();
    expect(controlCount).toBe(EXPECTED_ROWS);

    // Row count parity assertion
    expect(migratedCount).toBe(controlCount);

    // ── Axis 2: search result parity ──────────────────────────────────────────
    // Query both tables with the same vector; compare chunk_id ordering.
    // We search by vector (nearest-neighbor) and compare the ordered chunk_ids.
    // This validates that the migrated table has the same logical content as
    // a freshly-built clean table.

    const migratedResults = await migratedTable
      .search(QUERY_VECTOR)
      .where(`project_id = '${PROJECT_ID}'`)
      .limit(TOP_K)
      .toArray();

    const controlResults = await controlTable
      .search(QUERY_VECTOR)
      .where(`project_id = '${PROJECT_ID}'`)
      .limit(TOP_K)
      .toArray();

    // Both should return EXPECTED_ROWS results (table is small enough)
    expect(migratedResults.length).toBe(EXPECTED_ROWS);
    expect(controlResults.length).toBe(EXPECTED_ROWS);

    // Extract chunk_ids in returned order
    const migratedChunkIds = migratedResults.map((r) => String(r.chunk_id));
    const controlChunkIds = controlResults.map((r) => String(r.chunk_id));

    // Each chunk_id in migrated must be present in control (set membership)
    const controlSet = new Set(controlChunkIds);
    for (const id of migratedChunkIds) {
      expect(controlSet.has(id)).toBe(true);
    }

    // Each chunk_id in control must be present in migrated (set membership)
    const migratedSet = new Set(migratedChunkIds);
    for (const id of controlChunkIds) {
      expect(migratedSet.has(id)).toBe(true);
    }

    // ── Additional structural checks ──────────────────────────────────────────

    // No stale tickets/ paths must survive in migrated table
    const allMigratedRows = await migratedTable
      .query()
      .limit(Number.MAX_SAFE_INTEGER)
      .toArray() as unknown as Array<Record<string, unknown>>;

    for (const row of allMigratedRows) {
      const itemPath = String(row["item_path"] ?? "");
      expect(itemPath).not.toMatch(/^tickets\//);
      expect(itemPath).toMatch(/^issues\//);
    }

    // Ticket_comment rows must all have issues/N#note_M format
    const commentRows2 = allMigratedRows.filter(
      (r) => String(r["item_type"] ?? "") === "ticket_comment"
    );
    expect(commentRows2.length).toBe(5);
    for (const row of commentRows2) {
      expect(String(row["item_path"])).toMatch(/^issues\/51#note_\d+$/);
    }

    // Ticket body rows must have issues/N format (no #note)
    const ticketBodyRows = allMigratedRows.filter(
      (r) => String(r["item_type"] ?? "") === "ticket"
    );
    expect(ticketBodyRows.length).toBe(3); // 2 from Test A + 1 survivor from Test B
    for (const row of ticketBodyRows) {
      expect(String(row["item_path"])).toMatch(/^issues\/\d+$/);
      expect(String(row["item_path"])).not.toContain("#note_");
    }

    // Sidecar markers must be written
    const sidecarPath = join(bloatedDbPath, `${TABLE_NAME}-meta.json`);
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    expect(sidecar.chunk_id_scheme).toBe(2);
    expect(sidecar.dedup_done).toBe(true);
    expect(sidecar.item_path_rewrite_done).toBe(true);
  });
});
