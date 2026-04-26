/**
 * Fix 4 — maybeCompact threshold + compactTable (gc full-purge).
 *
 * maybeCompact fires when version count >= SCRYBE_LANCE_COMPACT_THRESHOLD and
 * keeps a 1h grace. compactTable (used by gc) purges all old versions immediately.
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
});
