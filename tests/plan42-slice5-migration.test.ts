/**
 * Plan 42 Slice 5 — knowledge metadata columns migration.
 *
 * Tests A–D cover:
 *   A. Old-schema knowledge table (no metadata cols) → migrated to new schema
 *      (metadata cols present), cursor deleted, branch_tags wiped, sidecar stamped.
 *   B. Code table alongside → left untouched (migration only touches ticket sources).
 *   C. Idempotency — second run returns status "skipped" (no-op).
 *   D. Source with no table_name → skipped (not yet indexed).
 *
 * The tests use SCRYBE_DATA_DIR (set per-test by tests/isolate.ts) so that
 * knowledgeTableHasMetadataColumns() reads sidecars from the same path that
 * the mocked _dropAndRecreate writes them to.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import {
  migrateKnowledgeTablesForPlan42,
} from "../src/migrations.js";
import {
  CURRENT_KNOWLEDGE_SCHEMA_VERSION,
} from "../src/vector-store.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const FAKE_DIMS = 4;
const PROJECT_ID = "test-project-42";
const KNOWLEDGE_SOURCE_ID = "gitlab-issues";
const CODE_SOURCE_ID = "code";

// ─── Helpers — derive paths from SCRYBE_DATA_DIR set by isolate.ts ────────────

function getTestDataDir(): string {
  return process.env["SCRYBE_DATA_DIR"]!;
}

function getLanceDbPath(): string {
  return join(getTestDataDir(), "lancedb");
}

function getCursorsDir(): string {
  return join(getTestDataDir(), "cursors");
}

// ─── Old-schema Arrow schemas (pre-Plan-42 — no metadata columns) ─────────────

/** Knowledge (ticket) schema without metadata columns */
function makeOldKnowledgeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("item_path", new Utf8(), false),
    new Field("item_url", new Utf8(), false),
    new Field("item_type", new Utf8(), false),
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

/** Current knowledge schema WITH metadata columns (should be returned by makeKnowledgeSchema) */
function makeNewKnowledgeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("item_path", new Utf8(), false),
    new Field("item_url", new Utf8(), false),
    new Field("item_type", new Utf8(), false),
    new Field("author", new Utf8(), false),
    new Field("timestamp", new Utf8(), false),
    new Field("content", new Utf8(), false),
    new Field("state", new Utf8(), false),
    new Field("labels", new Utf8(), false),
    new Field("assignees", new Utf8(), false),
    new Field("milestone", new Utf8(), false),
    new Field("confidential", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dims, new Field("item", new Float32(), false)),
      false
    ),
  ]);
}

/** Current code schema (no metadata columns expected — must not be touched) */
function makeCurrentCodeSchema(dims: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("item_path", new Utf8(), false),
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

// ─── Sidecar helpers (read/write to LanceDB path) ────────────────────────────

function readSidecar(tableName: string): Record<string, unknown> | null {
  const p = join(getLanceDbPath(), `${tableName}-meta.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function writeSidecar(tableName: string, fields: Record<string, unknown>): void {
  const p = join(getLanceDbPath(), `${tableName}-meta.json`);
  const existing: Record<string, unknown> = existsSync(p)
    ? JSON.parse(readFileSync(p, "utf8"))
    : {};
  writeFileSync(p, JSON.stringify({ ...existing, ...fields }, null, 2) + "\n", "utf8");
}

/**
 * Injectable replacement for knowledgeTableHasMetadataColumns that reads
 * sidecars from the test's lancedb path rather than from the module-level DB_PATH
 * constant (which captures SCRYBE_DATA_DIR at module load time, before isolate.ts
 * sets the per-test value).
 */
function makeHasMetadataColumns(knowledgeSchemaVersion: number) {
  return (tableName: string): boolean => {
    const meta = readSidecar(tableName);
    if (meta === null) return false;
    const v = meta["knowledge_schema_version"];
    if (typeof v === "number") return v >= knowledgeSchemaVersion;
    return false;
  };
}

// ─── Cursor helpers (read/write to SCRYBE_DATA_DIR/cursors/) ─────────────────

function writeCursor(projectId: string, sourceId: string, value: string): void {
  const dir = getCursorsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${projectId}__${sourceId}.json`),
    JSON.stringify({ updated_after: value }),
    "utf8"
  );
}

function cursorExists(projectId: string, sourceId: string): boolean {
  return existsSync(join(getCursorsDir(), `${projectId}__${sourceId}.json`));
}

// ─── Shared mock _dropAndRecreate (writes sidecar under the test lancedb dir) ─

function makeMockDropAndRecreate() {
  return async (
    tableName: string,
    schema: import("apache-arrow").Schema,
    sidecarFields: Record<string, unknown>
  ) => {
    const dbPath = getLanceDbPath();
    const db = await lancedb.connect(dbPath);
    const names = await db.tableNames();
    if (names.includes(tableName)) await db.dropTable(tableName);
    await db.createEmptyTable(tableName, schema);
    writeSidecar(tableName, sidecarFields);
  };
}

// ─── Test A — old-schema knowledge table is migrated ─────────────────────────

describe("Plan42-A — old-schema knowledge table gets migrated", () => {
  it("drops+recreates with metadata cols, deletes cursor, wipes branch_tags, stamps sidecar", async () => {
    const dbPath = getLanceDbPath();
    mkdirSync(dbPath, { recursive: true });

    const tableName = `p42a-knowledge`;

    // Create old-schema table (no metadata columns)
    const rows: Array<Record<string, unknown>> = [0, 1, 2].map((i) => ({
      chunk_id: `chunk-${i}`,
      project_id: PROJECT_ID,
      source_id: KNOWLEDGE_SOURCE_ID,
      item_path: `issues/${100 + i}`,
      item_url: `https://gitlab.example.com/issues/${100 + i}`,
      item_type: "ticket",
      author: `author-${i}`,
      timestamp: "2024-01-01T00:00:00Z",
      content: `issue body content ${i}`,
      vector: new Float32Array(FAKE_DIMS).fill(0.1 * (i + 1)),
    }));

    const db = await lancedb.connect(dbPath);
    await db.createTable(tableName, rows as any, { schema: makeOldKnowledgeSchema(FAKE_DIMS) });

    // Verify old schema does NOT have metadata columns
    const oldTable = await db.openTable(tableName);
    const oldSchema = await oldTable.schema();
    expect(oldSchema.fields.map((f) => f.name)).not.toContain("state");
    expect(await oldTable.countRows()).toBe(3);

    // Write a cursor that should be deleted
    writeCursor(PROJECT_ID, KNOWLEDGE_SOURCE_ID, "2024-01-01T00:00:00Z");
    expect(cursorExists(PROJECT_ID, KNOWLEDGE_SOURCE_ID)).toBe(true);

    let wipedProject: string | null = null;
    let wipedSource: string | null = null;

    const results = await migrateKnowledgeTablesForPlan42({
      _lanceDbPath: dbPath,
      _projects: [{
        id: PROJECT_ID,
        sources: [{
          source_id: KNOWLEDGE_SOURCE_ID,
          source_config: { type: "ticket" },
          table_name: tableName,
        }],
      }],
      _hasMetadataColumns: makeHasMetadataColumns(CURRENT_KNOWLEDGE_SCHEMA_VERSION),
      _dropAndRecreate: makeMockDropAndRecreate(),
      _deleteCursor: (projectId, sourceId) => {
        const p = join(getCursorsDir(), `${projectId}__${sourceId}.json`);
        if (existsSync(p)) rmSync(p);
      },
      _wipeSource: (projectId, sourceId) => {
        wipedProject = projectId;
        wipedSource = sourceId;
      },
    });

    // Migration result
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.projectId).toBe(PROJECT_ID);
    expect(results[0]!.sourceId).toBe(KNOWLEDGE_SOURCE_ID);

    // Cursor deleted
    expect(cursorExists(PROJECT_ID, KNOWLEDGE_SOURCE_ID)).toBe(false);

    // Branch_tags wipe triggered
    expect(wipedProject).toBe(PROJECT_ID);
    expect(wipedSource).toBe(KNOWLEDGE_SOURCE_ID);

    // Recreated table has the 5 new metadata columns
    const db3 = await lancedb.connect(dbPath);
    const table = await db3.openTable(tableName);
    const newSchema = await table.schema();
    const fieldNames = newSchema.fields.map((f) => f.name);

    expect(fieldNames).toContain("state");
    expect(fieldNames).toContain("labels");
    expect(fieldNames).toContain("assignees");
    expect(fieldNames).toContain("milestone");
    expect(fieldNames).toContain("confidential");

    // Table is empty (data dropped — will be re-fetched on next reindex)
    expect(await table.countRows()).toBe(0);

    // Sidecar stamped with knowledge_schema_version
    const meta = readSidecar(tableName);
    expect(meta?.["knowledge_schema_version"]).toBe(CURRENT_KNOWLEDGE_SCHEMA_VERSION);
  });
});

// ─── Test B — code table is NOT touched ──────────────────────────────────────

describe("Plan42-B — code table is left untouched", () => {
  it("skips code sources entirely, only migrates ticket sources", async () => {
    const dbPath = getLanceDbPath();
    mkdirSync(dbPath, { recursive: true });

    const knowledgeTableName = "p42b-knowledge";
    const codeTableName = "p42b-code";

    // Create old-schema knowledge table
    const db = await lancedb.connect(dbPath);
    await db.createTable(
      knowledgeTableName,
      [{
        chunk_id: "kchunk-0",
        project_id: PROJECT_ID,
        source_id: KNOWLEDGE_SOURCE_ID,
        item_path: "issues/1",
        item_url: "https://gitlab.example.com/issues/1",
        item_type: "ticket",
        author: "a",
        timestamp: "2024-01-01T00:00:00Z",
        content: "issue body",
        vector: new Float32Array(FAKE_DIMS).fill(0.5),
      }] as any,
      { schema: makeOldKnowledgeSchema(FAKE_DIMS) }
    );

    // Create code table (current schema)
    await db.createTable(
      codeTableName,
      [{
        chunk_id: "cchunk-0",
        project_id: PROJECT_ID,
        item_path: "src/main.ts",
        content: "export function main() {}",
        start_line: 1,
        end_line: 2,
        language: "typescript",
        symbol_name: "main",
        vector: new Float32Array(FAKE_DIMS).fill(0.3),
      }] as any,
      { schema: makeCurrentCodeSchema(FAKE_DIMS) }
    );
    const codeRowsBefore = await (await db.openTable(codeTableName)).countRows();

    let codeTableTouched = false;

    const results = await migrateKnowledgeTablesForPlan42({
      _lanceDbPath: dbPath,
      _projects: [{
        id: PROJECT_ID,
        sources: [
          {
            source_id: KNOWLEDGE_SOURCE_ID,
            source_config: { type: "ticket" },
            table_name: knowledgeTableName,
          },
          {
            source_id: CODE_SOURCE_ID,
            source_config: { type: "code" },
            table_name: codeTableName,
          },
        ],
      }],
      _hasMetadataColumns: makeHasMetadataColumns(CURRENT_KNOWLEDGE_SCHEMA_VERSION),
      _dropAndRecreate: async (tn, schema, sidecarFields) => {
        if (tn === codeTableName) codeTableTouched = true;
        const db2 = await lancedb.connect(dbPath);
        const names = await db2.tableNames();
        if (names.includes(tn)) await db2.dropTable(tn);
        await db2.createEmptyTable(tn, schema);
        writeSidecar(tn, sidecarFields);
      },
      _deleteCursor: () => {},
      _wipeSource: () => {},
    });

    // Code source must not appear in results at all
    const codeResult = results.find((r) => r.sourceId === CODE_SOURCE_ID);
    expect(codeResult).toBeUndefined();

    // Code table untouched
    expect(codeTableTouched).toBe(false);
    const codeRowsAfter = await (await (await lancedb.connect(dbPath)).openTable(codeTableName)).countRows();
    expect(codeRowsAfter).toBe(codeRowsBefore);

    // Knowledge source migrated
    const knowledgeResult = results.find((r) => r.sourceId === KNOWLEDGE_SOURCE_ID);
    expect(knowledgeResult?.status).toBe("ok");
  });
});

// ─── Test C — idempotency: second run is a no-op ─────────────────────────────

describe("Plan42-C — idempotency: second run is skipped", () => {
  it("running migration twice: second call returns status=skipped", async () => {
    const dbPath = getLanceDbPath();
    mkdirSync(dbPath, { recursive: true });

    const tableName = "p42c-knowledge";

    const db = await lancedb.connect(dbPath);
    await db.createTable(
      tableName,
      [{
        chunk_id: "chunk-0",
        project_id: PROJECT_ID,
        source_id: KNOWLEDGE_SOURCE_ID,
        item_path: "issues/1",
        item_url: "https://gitlab.example.com/issues/1",
        item_type: "ticket",
        author: "a",
        timestamp: "2024-01-01T00:00:00Z",
        content: "issue body",
        vector: new Float32Array(FAKE_DIMS).fill(0.2),
      }] as any,
      { schema: makeOldKnowledgeSchema(FAKE_DIMS) }
    );

    const projectsList = [{
      id: PROJECT_ID,
      sources: [{
        source_id: KNOWLEDGE_SOURCE_ID,
        source_config: { type: "ticket" as const },
        table_name: tableName,
      }],
    }];

    const dropAndRecreate = makeMockDropAndRecreate();
    const hasMetadataColumns = makeHasMetadataColumns(CURRENT_KNOWLEDGE_SCHEMA_VERSION);

    // First run — migrates
    const first = await migrateKnowledgeTablesForPlan42({
      _lanceDbPath: dbPath,
      _projects: projectsList,
      _hasMetadataColumns: hasMetadataColumns,
      _dropAndRecreate: dropAndRecreate,
      _deleteCursor: () => {},
      _wipeSource: () => {},
    });
    expect(first[0]!.status).toBe("ok");

    // Verify sidecar was written correctly
    expect(readSidecar(tableName)?.["knowledge_schema_version"]).toBe(CURRENT_KNOWLEDGE_SCHEMA_VERSION);

    let dropCalledOnSecondRun = false;

    // Second run — must be a no-op because sidecar says v2
    const second = await migrateKnowledgeTablesForPlan42({
      _lanceDbPath: dbPath,
      _projects: projectsList,
      _hasMetadataColumns: hasMetadataColumns,
      _dropAndRecreate: async () => { dropCalledOnSecondRun = true; },
      _deleteCursor: () => {},
      _wipeSource: () => {},
    });

    expect(second[0]!.status).toBe("skipped");
    expect(second[0]!.reason).toMatch(/already has metadata columns/);
    expect(dropCalledOnSecondRun).toBe(false);
  });
});

// ─── Test D — source with no table_name is skipped ───────────────────────────

describe("Plan42-D — source without table_name is skipped", () => {
  it("returns status=skipped with 'not yet indexed' for sources with no table_name", async () => {
    const results = await migrateKnowledgeTablesForPlan42({
      _lanceDbPath: getLanceDbPath(),
      _projects: [{
        id: PROJECT_ID,
        sources: [{
          source_id: KNOWLEDGE_SOURCE_ID,
          source_config: { type: "ticket" },
          // no table_name
        }],
      }],
      _hasMetadataColumns: makeHasMetadataColumns(CURRENT_KNOWLEDGE_SCHEMA_VERSION),
      _dropAndRecreate: async () => { throw new Error("should not be called"); },
      _deleteCursor: () => {},
      _wipeSource: () => {},
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toMatch(/not yet indexed/);
  });
});
