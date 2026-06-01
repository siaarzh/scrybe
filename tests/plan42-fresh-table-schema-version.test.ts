/**
 * Plan 42 — regression: freshly-created knowledge tables stamp knowledge_schema_version.
 *
 * Bug found during live verification: the table-creation path (getProjectTable ->
 * createEmptyTable) stamped chunk_id_scheme but NOT knowledge_schema_version. Since the
 * backfill migration treats an absent knowledge_schema_version as a pre-v0.41.0 table to
 * drop-recreate, a brand-new knowledge table built under v0.41.0 would be false-positive
 * migrated (wiped + re-fetched) on the next `scrybe migrate` / `doctor --repair`.
 *
 * Slice 5's migration test missed this because it injected a fake `_hasMetadataColumns`
 * detector and never exercised the real sidecar written by the real creation path.
 *
 * These tests drive the REAL creation path (via upsert/upsertKnowledge) and assert the
 * REAL knowledgeTableHasMetadataColumns reads a correctly-stamped sidecar.
 *
 * Harness mirrors plan42-slice3-metadata-roundtrip.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DIMS = 3;
const PROJECT_ID = "p42-schemaver-test";

let testDir = "";
let savedDataDir: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "scrybe-p42-sv-"));
  mkdirSync(join(testDir, "lancedb"), { recursive: true });
  savedDataDir = process.env["SCRYBE_DATA_DIR"];
  process.env["SCRYBE_DATA_DIR"] = testDir;
  vi.resetModules();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100));
  if (savedDataDir === undefined) delete process.env["SCRYBE_DATA_DIR"];
  else process.env["SCRYBE_DATA_DIR"] = savedDataDir;
  if (testDir) {
    try { rmSync(testDir, { recursive: true, force: true }); }
    catch { await new Promise((r) => setTimeout(r, 500)); try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    testDir = "";
  }
});

describe("Plan 42 — fresh knowledge table stamps knowledge_schema_version", () => {
  it("a freshly-created knowledge table is NOT flagged for the backfill migration", async () => {
    const { upsertKnowledge, knowledgeTableHasMetadataColumns, readTableMeta, CURRENT_KNOWLEDGE_SCHEMA_VERSION } =
      await import("../src/vector-store.js");

    const TABLE_NAME = `p42-sv-know-${Date.now()}`;
    const chunk = {
      chunk_id: "p42-sv-1",
      project_id: PROJECT_ID,
      source_id: "gitlab-issues",
      item_path: "issues/1",
      item_url: "https://gitlab.example.com/p/-/issues/1",
      item_type: "ticket",
      author: "alice",
      timestamp: "2024-06-01T10:00:00Z",
      content: "fresh ticket",
      state: "open",
      labels: '["bug"]',
      assignees: '["alice"]',
      milestone: "",
      confidential: "false",
    };

    await upsertKnowledge([chunk], [[1, 0, 0]], TABLE_NAME, DIMS);

    // The real detector the migration uses must report this table as up-to-date.
    expect(knowledgeTableHasMetadataColumns(TABLE_NAME)).toBe(true);

    // And the sidecar should carry the version (not just chunk_id_scheme).
    const meta = readTableMeta(TABLE_NAME);
    expect(meta).not.toBeNull();
    expect(meta!["knowledge_schema_version"]).toBe(CURRENT_KNOWLEDGE_SCHEMA_VERSION);
    expect(meta!["chunk_id_scheme"]).toBe(2); // existing stamp not regressed
  });

  it("a freshly-created CODE table does NOT get a knowledge_schema_version stamp", async () => {
    const { upsert, knowledgeTableHasMetadataColumns, readTableMeta } =
      await import("../src/vector-store.js");

    const TABLE_NAME = `p42-sv-code-${Date.now()}`;
    const codeChunk = {
      chunk_id: "p42-sv-code-1",
      project_id: PROJECT_ID,
      source_id: "primary",
      item_path: "src/foo.ts",
      item_url: "",
      item_type: "code" as const,
      content: "export const x = 1;",
      start_line: 1,
      end_line: 1,
      language: "ts",
      symbol_name: "x",
    };

    await upsert([codeChunk], [[1, 0, 0]], TABLE_NAME, DIMS);

    const meta = readTableMeta(TABLE_NAME);
    expect(meta).not.toBeNull();
    expect(meta!["chunk_id_scheme"]).toBe(2);
    expect(meta!["knowledge_schema_version"]).toBeUndefined();
    expect(knowledgeTableHasMetadataColumns(TABLE_NAME)).toBe(false);
  });
});
