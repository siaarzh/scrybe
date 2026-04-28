/**
 * Integration tests for Plan 20 — branch annotations on SearchResult.
 * Verifies that searchCode returns source_id and branches[] on every hit.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { switchBranch, getCurrentBranch } from "./helpers/git.js";

describe("search — branch annotations (Plan 20)", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("every hit has source_id populated", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const hits = await search(project.projectId, "function");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(typeof hit.source_id).toBe("string");
      expect(hit.source_id).toBe(project.sourceId);
    }
  });

  it("every hit has branches array", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const hits = await search(project.projectId, "function");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(Array.isArray(hit.branches)).toBe(true);
    }
  });

  it("shared chunks across two branches have both branches in annotation", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    // Index default branch
    await runIndex(project.projectId, project.sourceId, "full");

    // Index feat/example
    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    // Search on feat/example — shared chunks (alphaGreeting) should have both branches
    const hits = await search(project.projectId, "alphaGreeting", { branch: "feat/example" });
    const sharedHit = hits.find((h) => h.content.includes("alphaGreeting"));
    expect(sharedHit).toBeDefined();
    expect(sharedHit!.branches).toContain(defaultBranch);
    expect(sharedHit!.branches).toContain("feat/example");
  });

  it("branch-local chunks have only their branch in annotation", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    await runIndex(project.projectId, project.sourceId, "full");

    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    // alphaFarewell exists only on feat/example
    const hits = await search(project.projectId, "alphaFarewell", { branch: "feat/example" });
    const featOnlyHit = hits.find((h) => h.content.includes("alphaFarewell"));
    expect(featOnlyHit).toBeDefined();
    expect(featOnlyHit!.branches).toContain("feat/example");
    expect(featOnlyHit!.branches).not.toContain(defaultBranch);
  });

  it("master/main is sorted first in branches array", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    await runIndex(project.projectId, project.sourceId, "full");
    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    const hits = await search(project.projectId, "alphaGreeting", { branch: "feat/example" });
    const sharedHit = hits.find((h) => h.content.includes("alphaGreeting") && h.branches.length >= 2);
    if (sharedHit) {
      // defaultBranch (master or main) must appear before feat/example
      expect(sharedHit.branches[0]).toBe(defaultBranch);
    }
  });

  it("compat mode (SCRYBE_SKIP_MIGRATION=1) returns branches array without throwing", async () => {
    // SCRYBE_SKIP_MIGRATION=1 skips the branch *filter* on search (no chunk_id IN-clause),
    // but the branch annotation step (getBranchesForChunks) still runs on the top-K results.
    // The ?? [] fallback in search.ts ensures every hit has `branches` as an array.
    const origVal = process.env.SCRYBE_SKIP_MIGRATION;
    process.env.SCRYBE_SKIP_MIGRATION = "1";

    try {
      fixture = await cloneFixture("sample-repo");
      project = await createTempProject({ rootPath: fixture.path });

      // We must index first — SCRYBE_SKIP_MIGRATION only skips branch filter on search,
      // not the index itself.
      await runIndex(project.projectId, project.sourceId, "full");

      const hits = await search(project.projectId, "function");
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        // ?? [] in search.ts guarantees the field is always an array (never undefined).
        expect(Array.isArray(hit.branches)).toBe(true);
      }
    } finally {
      if (origVal === undefined) {
        delete process.env.SCRYBE_SKIP_MIGRATION;
      } else {
        process.env.SCRYBE_SKIP_MIGRATION = origVal;
      }
    }
  });
});
