/**
 * Plan 43 — drop-and-recreate migration: end-to-end tests against real LanceDB.
 * Tests C5a, C5b, C5c.
 *
 * These tests build old-schema tables in a temp DATA_DIR, run migrateTable,
 * and assert that the result has new-schema columns with correctly recomputed
 * chunk_ids and preserved vectors.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
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

const FAKE_DIMS = 4; // tiny fake vectors — enough for schema validation
const PROJECT_ID = "test-project";
const SOURCE_ID = "test-source";

// ─── Old-schema Arrow schemas ─────────────────────────────────────────────────

function makeOldKnowledgeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("source_path", new Utf8(), false),   // old name
    new Field("source_url", new Utf8(), false),    // old name
    new Field("source_type", new Utf8(), false),   // old name
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
    new Field("file_path", new Utf8(), false),     // old name
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

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeKnowledgeRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const content = `knowledge content ${i}`;
    const sourcePath = `issues/${i}`;
    const sourceUrl = `https://example.com/issues/${i}`;
    const sourceType = "ticket";
    const language = "";
    const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, language, content);
    const vector = new Float32Array(FAKE_DIMS).fill(0.1 * (i + 1));
    return {
      chunk_id: chunkId,
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      source_path: sourcePath,
      source_url: sourceUrl,
      source_type: sourceType,
      author: `author-${i}`,
      timestamp: "2024-01-01T00:00:00Z",
      content,
      vector,
    };
  });
}

function makeCodeRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const content = `code content ${i}`;
    const filePath = `src/file${i}.ts`;
    const language = "typescript";
    const chunkId = makeOldChunkIdV1(PROJECT_ID, SOURCE_ID, language, content);
    const vector = new Float32Array(FAKE_DIMS).fill(0.2 * (i + 1));
    return {
      chunk_id: chunkId,
      project_id: PROJECT_ID,
      file_path: filePath,
      content,
      start_line: i * 10,
      end_line: i * 10 + 5,
      language,
      symbol_name: `fn${i}`,
      vector,
    };
  });
}

// ─── Sidecar helper (test-local, writes directly into the test dbPath) ────────

function writeTestSidecar(dbPath: string, tableName: string, meta: Record<string, unknown>): void {
  mkdirSync(dbPath, { recursive: true });
  writeFileSync(join(dbPath, `${tableName}-meta.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function readTestSidecar(dbPath: string, tableName: string): Record<string, unknown> | null {
  const p = join(dbPath, `${tableName}-meta.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// ─── Per-test setup: isolated DB dir ─────────────────────────────────────────

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-plan43-migration-"));
  dbPath = join(dataDir, "lancedb");
  mkdirSync(dbPath, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ─── C5a — knowledge table: old schema → new schema ──────────────────────────

describe("C5a — knowledge table migrates old schema to new schema", () => {
  it("migrates 5-row knowledge table: renames columns, rewrites chunk_ids, preserves vectors", async () => {
    const tableName = "c5a-knowledge";
    const rows = makeKnowledgeRows(5);

    // Create old-schema table
    const db = await lancedb.connect(dbPath);
    const schema = makeOldKnowledgeSchema(FAKE_DIMS);
    await db.createTable(tableName, rows as any, { schema });

    // Record one vector before migration for later comparison
    const beforeVector = rows[2]["vector"] as Float32Array;

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });

    expect(result.status).toBe("ok");
    expect(result.rows_rehashed).toBe(5);

    // Open migrated table
    const db2 = await lancedb.connect(dbPath);
    const table = await db2.openTable(tableName);
    const tableSchema = await table.schema();

    // Assert new column names are present
    const colNames = tableSchema.fields.map((f) => f.name);
    expect(colNames).toContain("item_path");
    expect(colNames).toContain("item_url");
    expect(colNames).toContain("item_type");

    // Assert old column names are gone
    expect(colNames).not.toContain("source_path");
    expect(colNames).not.toContain("source_url");
    expect(colNames).not.toContain("source_type");

    // Assert all rows have correct new chunk_ids
    const migratedRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
    expect(migratedRows.length).toBe(5);

    for (const row of migratedRows) {
      const content = String(row["content"] ?? "");
      const itemPath = String(row["item_path"] ?? "");
      const itemUrl = String(row["item_url"] ?? "");
      const itemType = String(row["item_type"] ?? "");
      const expectedId = makeNewChunkIdV2(PROJECT_ID, SOURCE_ID, itemPath, itemUrl, itemType, normalizeContent(content));
      expect(row["chunk_id"]).toBe(expectedId);
    }

    // Assert vector preserved for row index 2 (matched by content)
    const matchedRow = migratedRows.find((r) => String(r["content"]).includes("content 2"));
    expect(matchedRow).toBeDefined();
    const afterVector = matchedRow!["vector"] as Float32Array;
    expect(Array.from(afterVector)).toEqual(Array.from(beforeVector));

    // Assert sidecar stamped at scheme 2
    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
  });
});

// ─── C5b — code table: old schema → new schema ───────────────────────────────

describe("C5b — code table migrates old schema to new schema", () => {
  it("migrates 5-row code table: renames file_path to item_path, rewrites chunk_ids, preserves vectors", async () => {
    const tableName = "c5b-code";
    const rows = makeCodeRows(5);

    const db = await lancedb.connect(dbPath);
    const schema = makeOldCodeSchema(FAKE_DIMS);
    await db.createTable(tableName, rows as any, { schema });

    const beforeVector = rows[1]["vector"] as Float32Array;

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });

    expect(result.status).toBe("ok");
    expect(result.rows_rehashed).toBe(5);

    const db2 = await lancedb.connect(dbPath);
    const table = await db2.openTable(tableName);
    const tableSchema = await table.schema();
    const colNames = tableSchema.fields.map((f) => f.name);

    expect(colNames).toContain("item_path");
    expect(colNames).not.toContain("file_path");

    const migratedRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
    expect(migratedRows.length).toBe(5);

    for (const row of migratedRows) {
      const content = String(row["content"] ?? "");
      const itemPath = String(row["item_path"] ?? "");
      const expectedId = makeNewChunkIdV2(PROJECT_ID, SOURCE_ID, itemPath, "", "code", normalizeContent(content));
      expect(row["chunk_id"]).toBe(expectedId);
    }

    // Assert vector preserved for row index 1
    const matchedRow = migratedRows.find((r) => String(r["content"]).includes("content 1"));
    expect(matchedRow).toBeDefined();
    const afterVector = matchedRow!["vector"] as Float32Array;
    expect(Array.from(afterVector)).toEqual(Array.from(beforeVector));

    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
  });
});

// ─── C5c — restart-safety: mixed old + new chunk_id rows ─────────────────────

describe("C5c — restart-safety: mixed old+new rows converge correctly", () => {
  it("with 1→2-migrating marker and old-schema table, migration does not abort and produces correct new chunk_ids", async () => {
    const tableName = "c5c-restart";

    // Populate an old-schema knowledge table and write the in-progress marker manually,
    // simulating a crash that happened right after the marker write but before drop.
    const rows = makeKnowledgeRows(5);
    const db = await lancedb.connect(dbPath);
    const schema = makeOldKnowledgeSchema(FAKE_DIMS);
    await db.createTable(tableName, rows as any, { schema });

    writeTestSidecar(dbPath, tableName, { chunk_id_scheme: "1→2-migrating" });

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });

    // Must not abort
    expect(result.status).toBe("ok");
    expect(result.rows_rehashed).toBe(5);

    // All rows must have correct new chunk_ids
    const db2 = await lancedb.connect(dbPath);
    const table = await db2.openTable(tableName);
    const migratedRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
    expect(migratedRows.length).toBe(5);

    for (const row of migratedRows) {
      const content = String(row["content"] ?? "");
      const itemPath = String(row["item_path"] ?? "");
      const itemUrl = String(row["item_url"] ?? "");
      const itemType = String(row["item_type"] ?? "");
      const expectedId = makeNewChunkIdV2(PROJECT_ID, SOURCE_ID, itemPath, itemUrl, itemType, normalizeContent(content));
      expect(row["chunk_id"]).toBe(expectedId);
    }

    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
  });

  it("if table is missing and marker says 1→2-migrating, returns failed with clear message", async () => {
    const tableName = "c5c-missing-table";

    // Write marker but do NOT create the table (simulates crash between drop and recreate)
    writeTestSidecar(dbPath, tableName, { chunk_id_scheme: "1→2-migrating" });

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, { _dbPath: dbPath });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/reindex --full/);
  });
});

// ─── C5d — validation-failed marker is honored on retry ──────────────────────

describe("C5d — validation_failed marker prevents retry from blowing past validation", () => {
  it("first run: corrupt table fails validation and marker is set to validation_failed", async () => {
    const tableName = "c5d-corrupt";

    // Build an old-schema table where stored chunk_ids do NOT match the v1 hash.
    const rows = makeKnowledgeRows(3).map((r) => ({ ...r, chunk_id: "garbage-id-not-matching-hash" }));
    const db = await lancedb.connect(dbPath);
    const schema = makeOldKnowledgeSchema(FAKE_DIMS);
    await db.createTable(tableName, rows as any, { schema });

    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, {
      validationSampleSize: 10,
      _dbPath: dbPath,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/Pre-migration validation failed/);

    // Marker should now be validation_failed (NOT 1→2-migrating)
    const meta = readTestSidecar(dbPath, tableName);
    expect(meta?.["chunk_id_scheme"]).toBe("validation_failed");
  });

  it("second run on same corrupt table: returns failed without entering restart path", async () => {
    const tableName = "c5d-corrupt-retry";

    const rows = makeKnowledgeRows(3).map((r) => ({ ...r, chunk_id: "garbage-id" }));
    const db = await lancedb.connect(dbPath);
    const schema = makeOldKnowledgeSchema(FAKE_DIMS);
    await db.createTable(tableName, rows as any, { schema });

    // First run — sets validation_failed marker
    await migrateTable(tableName, PROJECT_ID, SOURCE_ID, { validationSampleSize: 10, _dbPath: dbPath });

    // Second run — must fail immediately, NOT drop+recreate
    const result = await migrateTable(tableName, PROJECT_ID, SOURCE_ID, { validationSampleSize: 10, _dbPath: dbPath });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/previously failed/);

    // Table must still exist (not destroyed by a blind retry)
    const db2 = await lancedb.connect(dbPath);
    const names = await db2.tableNames();
    expect(names).toContain(tableName);

    // Schema must still be the OLD schema (proving we did NOT silently rebuild it)
    const table = await db2.openTable(tableName);
    const colNames = (await table.schema()).fields.map((f) => f.name);
    expect(colNames).toContain("source_path");
    expect(colNames).not.toContain("item_path");
  });
});
