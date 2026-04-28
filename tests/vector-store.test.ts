/**
 * Fix 4 — maybeCompact threshold + compactTable (gc full-purge).
 *
 * maybeCompact fires when version count >= SCRYBE_LANCE_COMPACT_THRESHOLD and
 * keeps a brief grace (default 60s, SCRYBE_LANCE_GRACE_MS). compactTable (used
 * by gc) purges all old versions immediately and returns measured disk-delta
 * (Lance's prune.bytesRemoved is unreliable — see compactTable docstring).
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";

describe("maybeCompact + compactTable (Fix 4)", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("compactTable reduces version count on a table with multiple versions", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Each full index creates new Lance versions
    await runIndex(project.projectId, project.sourceId, "full");
    await runIndex(project.projectId, project.sourceId, "full");
    await runIndex(project.projectId, project.sourceId, "full");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const tableName = src.table_name!;

    const { getTableStats, compactTable } = await import("../src/vector-store.js");

    const before = await getTableStats(tableName);
    await compactTable(tableName);
    const after = await getTableStats(tableName);

    // After full-purge compaction, version count should be reduced
    expect(after.versionCount).toBeLessThan(before.versionCount);
    // Rows must still be there (compaction doesn't delete data)
    const { countTableRows } = await import("../src/vector-store.js");
    expect(await countTableRows(tableName)).toBeGreaterThan(0);
  });

  it("getTableStats returns sizeBytes > 0 and versionCount >= 1 for indexed table", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;

    const { getTableStats } = await import("../src/vector-store.js");
    const stats = await getTableStats(src.table_name!);

    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.versionCount).toBeGreaterThanOrEqual(1);
  });

  // M-D16 Fix C — compactTable returns bytes reclaimed (was Promise<void>).
  it("compactTable returns a non-negative number of bytes reclaimed", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // One full index, then a re-index that orphans data → compaction has work to do.
    await runIndex(project.projectId, project.sourceId, "full");
    await runIndex(project.projectId, project.sourceId, "full");
    await runIndex(project.projectId, project.sourceId, "full");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;

    const { compactTable } = await import("../src/vector-store.js");
    const reclaimed = await compactTable(src.table_name!);

    expect(typeof reclaimed).toBe("number");
    expect(reclaimed).toBeGreaterThanOrEqual(0);
  });

  it("compactTable on a missing table returns 0", async () => {
    const { compactTable } = await import("../src/vector-store.js");
    const reclaimed = await compactTable("definitely_not_a_real_table_md16");
    expect(reclaimed).toBe(0);
  });

  // M21.1 — repeated full reindex must not balloon disk after explicit gc.
  // Pre-fix: cmx-core/primary went from 895 MB → 27 GB (30x) during a 25-min burst.
  // The grace window means within-burst orphans aren't reclaimable in tests
  // (which complete in seconds), but a follow-up compactTable (full purge) must
  // bring disk back to within ~2x of the single-reindex baseline.
  it("repeated full reindex + gc returns disk to baseline", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const { getTableStats, compactTable } = await import("../src/vector-store.js");

    await compactTable(src.table_name!);
    const baseline = (await getTableStats(src.table_name!)).sizeBytes;

    // Five more full reindexes — same data, no logical change.
    for (let i = 0; i < 5; i++) {
      await runIndex(project.projectId, project.sourceId, "full");
    }
    await compactTable(src.table_name!);

    const final = (await getTableStats(src.table_name!)).sizeBytes;

    // After explicit gc the table should be back near the single-reindex size.
    // Pre-fix behavior: 5-30x. Post-fix: within 2x is comfortable.
    expect(final).toBeLessThan(baseline * 2);
  });

  // M21.1 — compactTable returns honest disk delta, not Lance's phantom bytesRemoved.
  // Pre-fix bug: every gc call printed the same "Reclaimed N MB" forever because
  // OptimizeStats.prune.bytesRemoved counts bytes referenced by the dropped manifest,
  // not bytes physically deleted. After the fix, a steady-state second call returns
  // near-zero (< 1 KB — only the difference between successive manifest file sizes).
  it("compactTable on a steady-state table reports near-zero on the second call", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const { compactTable } = await import("../src/vector-store.js");

    await compactTable(src.table_name!); // first call may free real bytes
    const second = await compactTable(src.table_name!);
    // Pre-fix this returned ~1.96 MB on every steady-state call. Post-fix it's
    // bounded by the manifest-file size delta between consecutive optimize writes.
    expect(second).toBeLessThan(1024);
  });
});
