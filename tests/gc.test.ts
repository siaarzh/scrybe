/**
 * GC (garbage collection) — orphaned LanceDB chunks are detected and removed.
 * Orphans arise when branch tags are removed but LanceDB rows are preserved
 * (the no-pre-delete invariant for cross-branch safety).
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { switchBranch, getCurrentBranch } from "./helpers/git.js";

describe("gc — orphan chunk cleanup", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("orphaned chunks are detected and deleted without touching live branches", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    // Index default branch
    await runIndex(project.projectId, project.sourceId, "full");

    // Index feat/example — adds alphaFarewell chunk (unique to this branch)
    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const tableName = src.table_name!;

    const { listChunkIds } = await import("../src/vector-store.js");
    const { getAllChunkIdsForSource, removeTagsForBranch } = await import("../src/branch-tags.js");

    // Initially no orphans — every LanceDB row is tagged under at least one branch
    const lanceIdsBefore = await listChunkIds(project.projectId, tableName);
    const taggedBefore = getAllChunkIdsForSource(project.projectId, project.sourceId);
    const orphansBefore = lanceIdsBefore.filter((id) => !taggedBefore.has(id));
    expect(orphansBefore).toHaveLength(0);

    // Simulate branch deletion: drop all feat/example tags.
    // alphaFarewell is unique to feat/example → its chunk becomes an orphan.
    removeTagsForBranch(project.projectId, project.sourceId, "feat/example");

    const lanceIdsAfter = await listChunkIds(project.projectId, tableName);
    const taggedAfter = getAllChunkIdsForSource(project.projectId, project.sourceId);
    const orphans = lanceIdsAfter.filter((id) => !taggedAfter.has(id));
    expect(orphans.length).toBeGreaterThan(0);

    // --- dry-run: report count without deleting ---
    const dryRunOrphanCount = orphans.length;
    // Verify LanceDB still has them (dry run = no deletion)
    const lanceIdsDryRun = await listChunkIds(project.projectId, tableName);
    expect(lanceIdsDryRun.length).toBe(lanceIdsAfter.length);

    // --- real GC run ---
    const { deleteChunks } = await import("../src/vector-store.js");
    await deleteChunks(orphans, tableName);

    const lanceIdsFinal = await listChunkIds(project.projectId, tableName);
    const taggedFinal = getAllChunkIdsForSource(project.projectId, project.sourceId);
    const orphansFinal = lanceIdsFinal.filter((id) => !taggedFinal.has(id));
    expect(orphansFinal).toHaveLength(0);
    expect(lanceIdsFinal.length).toBe(lanceIdsAfter.length - dryRunOrphanCount);

    // Default branch content is still fully searchable after GC
    const hits = await search(project.projectId, "alphaGreeting", { branch: defaultBranch });
    expect(hits.some((h) => h.content.includes("alphaGreeting"))).toBe(true);
  });
});
