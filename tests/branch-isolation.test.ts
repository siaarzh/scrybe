/**
 * Branch isolation — content on feat/example must not appear in main search results.
 * Also verifies content-addressed dedup (identical chunks share one LanceDB row)
 * and that getBranchesForSource/list_branches reflects indexed branches.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { switchBranch, getCurrentBranch } from "./helpers/git.js";

describe("branch isolation", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("alphaFarewell (feat/example only) is absent from main search results", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Capture the default branch name (may be "main" or "master" depending on git config)
    const defaultBranch = getCurrentBranch(fixture);

    // Index the default branch (working tree is on it after clone)
    await runIndex(project.projectId, project.sourceId, "full");

    // Switch to feat/example and index — auto-resolves branch to "feat/example"
    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");
    // No need to switch back — search uses explicit branch params

    // alphaFarewell exists only on feat/example — must not appear in default-branch search
    const mainHits = await search(project.projectId, "alphaFarewell", { branch: defaultBranch });
    const falsePositives = mainHits.filter((h) => h.content.includes("alphaFarewell"));
    expect(falsePositives).toHaveLength(0);

    // alphaFarewell must be findable on feat/example
    const featHits = await search(project.projectId, "alphaFarewell", { branch: "feat/example" });
    expect(featHits.some((h) => h.content.includes("alphaFarewell"))).toBe(true);
  });

  it("alphaGreeting (shared content) is findable on both branches", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    // Index default branch
    await runIndex(project.projectId, project.sourceId, "full");

    // Index feat/example
    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    const mainHits = await search(project.projectId, "alphaGreeting", { branch: defaultBranch });
    expect(mainHits.some((h) => h.content.includes("alphaGreeting"))).toBe(true);

    const featHits = await search(project.projectId, "alphaGreeting", { branch: "feat/example" });
    expect(featHits.some((h) => h.content.includes("alphaGreeting"))).toBe(true);
  });

  it("identical content across branches shares one LanceDB row (dedup)", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    await runIndex(project.projectId, project.sourceId, "full");

    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    const { getSource } = await import("../src/registry.js");
    const src = getSource(project.projectId, project.sourceId)!;
    const tableName = src.table_name!;

    const { listChunkIds } = await import("../src/vector-store.js");
    const { getChunkIdsForBranch } = await import("../src/branch-state.js");

    const lanceIds = new Set(await listChunkIds(project.projectId, tableName));
    const defaultIds = getChunkIdsForBranch(project.projectId, project.sourceId, defaultBranch);
    const featIds = getChunkIdsForBranch(project.projectId, project.sourceId, "feat/example");

    // At least one chunk is shared (alphaGreeting lives on both branches)
    const sharedIds = [...defaultIds].filter((id) => featIds.has(id));
    expect(sharedIds.length).toBeGreaterThan(0);

    // LanceDB has fewer rows than the naive sum — shared chunks stored once, tagged twice
    expect(lanceIds.size).toBeLessThan(defaultIds.size + featIds.size);

    // Every tagged chunk_id has a backing LanceDB row (no dangling tags)
    for (const id of defaultIds) expect(lanceIds.has(id)).toBe(true);
    for (const id of featIds) expect(lanceIds.has(id)).toBe(true);
  });

  it("getBranchesForSource returns all indexed branches", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const defaultBranch = getCurrentBranch(fixture);

    await runIndex(project.projectId, project.sourceId, "full");

    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    const { listBranches } = await import("../src/branch-state.js");
    const branches = listBranches(project.projectId, project.sourceId);

    expect(branches).toContain(defaultBranch);
    expect(branches).toContain("feat/example");
    expect(branches).toHaveLength(2);
  });
});
