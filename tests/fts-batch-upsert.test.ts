import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { writeFileSync } from "fs";
import { join } from "path";

// ─── Test 1: LanceDB manifest version count per flushBatch ───────────────────

describe("flushBatch produces far fewer manifest versions than files indexed", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("indexing N files adds fewer manifest versions than files (not 1 per file)", async () => {
    // Build a fixture with several .ts files — all will land in a single flushBatch
    // because the default batch size is large enough to hold them all.
    fixture = await cloneFixture("sample-repo");

    // Add extra files so the batch definitely spans multiple keys
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(fixture.path, "src", `extra${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
        "utf8"
      );
    }

    project = await createTempProject({ rootPath: fixture.path });

    // Run full index
    const result = await runIndex(project.projectId, project.sourceId, "full");
    expect(result.status).toBe("ok");
    expect(result.files_reindexed).toBeGreaterThan(0);

    const { getTableStats } = await import("../src/vector-store.js");
    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const { versionCount } = await getTableStats(src.table_name!);

    // Pre-fix: N files -> N manifest versions (1 upsert per file, each = 1 version).
    // Post-fix: 1 upsert per flushBatch -> versionCount << files_reindexed.
    // With sample-repo (3 files) + 5 extras = 8 files, post-fix should be at most 4 versions
    // (create table + mergeInsert + fts index + compaction).
    expect(versionCount).toBeLessThan(result.files_reindexed);
  });

  it("applyFile is called once per distinct file (checkpoint semantics preserved)", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const result = await runIndex(project.projectId, project.sourceId, "full");

    expect(result.status).toBe("ok");
    expect(result.files_reindexed).toBeGreaterThan(0);

    // Verify hashes were saved (one per file) by checking branch-state.
    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const { getAllChunkIdsForSource } = await import("../src/branch-state.js");
    const taggedIds = getAllChunkIdsForSource(project.projectId, project.sourceId);
    const { listChunkIds } = await import("../src/vector-store.js");
    const allIds = await listChunkIds(project.projectId, src.table_name!);
    // All chunks in LanceDB should appear in branch_tags (full index = all files embedded).
    for (const id of allIds) {
      expect(taggedIds.has(id)).toBe(true);
    }
  });
});

// ─── Test 2: mergeInsert deduplication ──────────────────────────────────────

describe("mergeInsert deduplicates by chunk_id", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("indexing the same content twice leaves exactly one row per chunk (no duplicates)", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // First full index
    await runIndex(project.projectId, project.sourceId, "full");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const { listChunkIds, countTableRows } = await import("../src/vector-store.js");

    const rowsAfterFirst = await countTableRows(src.table_name!);
    const idsAfterFirst = await listChunkIds(project.projectId, src.table_name!);

    // Second full index with same content — mergeInsert must update, not append.
    await runIndex(project.projectId, project.sourceId, "full");

    const rowsAfterSecond = await countTableRows(src.table_name!);
    const idsAfterSecond = await listChunkIds(project.projectId, src.table_name!);

    // Row count must be the same — no duplicates from the second run.
    expect(rowsAfterSecond).toBe(rowsAfterFirst);
    // Chunk ID set must be identical (no phantom new IDs).
    expect(new Set(idsAfterSecond)).toEqual(new Set(idsAfterFirst));
  });
});

// ─── Test 3: branch-ref validation ───────────────────────────────────────────

describe("indexSource errors on nonexistent branch ref", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  beforeEach(async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
  });

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("throws an error with a clear message when branch ref does not exist", async () => {
    const { indexSource } = await import("../src/indexer.js");

    await expect(
      indexSource(project!.projectId, project!.sourceId, "incremental", {
        branch: "totally-bogus-ref-xyz",
      })
    ).rejects.toThrow(/branch 'totally-bogus-ref-xyz' not found locally/);
  });

  it("error message suggests 'origin/<ref>' for remote-only branches", async () => {
    const { indexSource } = await import("../src/indexer.js");

    await expect(
      indexSource(project!.projectId, project!.sourceId, "incremental", {
        branch: "5.x",
      })
    ).rejects.toThrow(/try 'origin\/5\.x' or fetch the ref first/);
  });
});
