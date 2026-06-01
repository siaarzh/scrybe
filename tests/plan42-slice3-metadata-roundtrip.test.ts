/**
 * Plan 42 Slice 3 — Metadata persist + return round-trip.
 *
 * Verifies that:
 *   1. upsertKnowledge writes the 5 metadata fields (state, labels, assignees,
 *      milestone, confidential) for a ticket chunk with metadata set.
 *   2. searchKnowledge returns those metadata JSON strings intact.
 *   3. A non-ticket chunk (no metadata fields) survives with "" defaults on all 5.
 *   4. ftsSearchKnowledge also returns the metadata strings.
 *
 * Pattern mirrors plan81-cosine-score.test.ts — temp dir + SCRYBE_DATA_DIR override,
 * vi.resetModules() between runs, no persistent state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DIMS = 3;
const PROJECT_ID = "p42-meta-test";
const SOURCE_ID = "gitlab-issues";

// Simple unit-norm vectors (identical so they all score 1.0 — ranking doesn't matter for this test)
const V1 = [1, 0, 0];
const V2 = [1, 0, 0];
const V3 = [1, 0, 0];

let testDir = "";
let savedDataDir: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "scrybe-p42-s3-"));
  mkdirSync(join(testDir, "lancedb"), { recursive: true });
  savedDataDir = process.env["SCRYBE_DATA_DIR"];
  process.env["SCRYBE_DATA_DIR"] = testDir;
  vi.resetModules();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100));
  if (savedDataDir === undefined) {
    delete process.env["SCRYBE_DATA_DIR"];
  } else {
    process.env["SCRYBE_DATA_DIR"] = savedDataDir;
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

describe("Plan 42 Slice 3 — metadata persist + return round-trip", () => {
  it("searchKnowledge returns metadata fields intact for a ticket chunk", async () => {
    const { searchKnowledge, upsertKnowledge } = await import("../src/vector-store.js");

    const TABLE_NAME = `p42-vs-${Date.now()}`;

    const ticketChunk = {
      chunk_id: "p42-ticket-1",
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      item_path: "issues/42",
      item_url: "https://gitlab.example.com/project/-/issues/42",
      item_type: "ticket",
      author: "alice",
      timestamp: "2024-06-01T10:00:00Z",
      content: "ticket with metadata",
      state: "open",
      labels: '["bug","frontend"]',
      assignees: '["alice","bob"]',
      milestone: '{"title":"26.4","due_date":"2026-07-01"}',
      confidential: "false",
    };

    await upsertKnowledge([ticketChunk], [V1], TABLE_NAME, DIMS);

    const results = await searchKnowledge([1, 0, 0], PROJECT_ID, 5, TABLE_NAME, DIMS);

    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.item_path === "issues/42");
    expect(hit).toBeDefined();

    expect(hit!.state).toBe("open");
    expect(hit!.labels).toBe('["bug","frontend"]');
    expect(hit!.assignees).toBe('["alice","bob"]');
    expect(hit!.milestone).toBe('{"title":"26.4","due_date":"2026-07-01"}');
    expect(hit!.confidential).toBe("false");
  });

  it("searchKnowledge returns '' defaults for a non-ticket chunk (no metadata fields)", async () => {
    const { searchKnowledge, upsertKnowledge } = await import("../src/vector-store.js");

    const TABLE_NAME = `p42-vs-nofields-${Date.now()}`;

    const webpageChunk = {
      chunk_id: "p42-webpage-1",
      project_id: PROJECT_ID,
      source_id: "docs",
      item_path: "docs/readme",
      item_url: "https://example.com/readme",
      item_type: "webpage",
      author: "",
      timestamp: "",
      content: "webpage without metadata",
      // No state/labels/assignees/milestone/confidential
    };

    await upsertKnowledge([webpageChunk], [V2], TABLE_NAME, DIMS);

    const results = await searchKnowledge([1, 0, 0], PROJECT_ID, 5, TABLE_NAME, DIMS);

    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.item_path === "docs/readme");
    expect(hit).toBeDefined();

    expect(hit!.state).toBe("");
    expect(hit!.labels).toBe("");
    expect(hit!.assignees).toBe("");
    expect(hit!.milestone).toBe("");
    expect(hit!.confidential).toBe("");
  });

  it("ftsSearchKnowledge returns metadata fields intact for a ticket chunk", async () => {
    const { upsertKnowledge, ftsSearchKnowledge, createKnowledgeFtsIndex } = await import(
      "../src/vector-store.js"
    );

    const TABLE_NAME = `p42-fts-${Date.now()}`;

    const ticketChunk = {
      chunk_id: "p42-fts-ticket-1",
      project_id: PROJECT_ID,
      source_id: SOURCE_ID,
      item_path: "issues/99",
      item_url: "https://gitlab.example.com/project/-/issues/99",
      item_type: "ticket_comment",
      author: "charlie",
      timestamp: "2024-06-01T12:00:00Z",
      content: "fts searchable comment with metadata fields",
      state: "closed",
      labels: '["resolved"]',
      assignees: '["charlie"]',
      milestone: '{"title":"25.0","due_date":"2025-12-01"}',
      confidential: "true",
    };

    await upsertKnowledge([ticketChunk], [V3], TABLE_NAME, DIMS);
    await createKnowledgeFtsIndex(TABLE_NAME);

    const results = await ftsSearchKnowledge("fts searchable", PROJECT_ID, 5, TABLE_NAME);

    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.item_path === "issues/99");
    expect(hit).toBeDefined();

    expect(hit!.state).toBe("closed");
    expect(hit!.labels).toBe('["resolved"]');
    expect(hit!.assignees).toBe('["charlie"]');
    expect(hit!.milestone).toBe('{"title":"25.0","due_date":"2025-12-01"}');
    expect(hit!.confidential).toBe("true");
  });
});
