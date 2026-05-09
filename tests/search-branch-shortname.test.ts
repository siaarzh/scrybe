/**
 * Integration tests for Plan 53 — branch short-name resolution in searchCode.
 *
 * Verifies that `searchCode` returns results when:
 *   1. Pinned-form indexed (`origin/feat/example`), caller supplies short name (`feat/example`).
 *   2. Short-form indexed (`feat/example`), caller supplies qualified ref (`origin/feat/example`).
 *   3. Unknown branch supplied — returns [] without throwing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { switchBranch } from "./helpers/git.js";

describe("search — branch short-name resolution (Plan 53)", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("Test 1: pinned-form indexed (origin/feat/example), short name supplied returns hits", async () => {
    // Simulate the pinned-branch path: index normally on feat/example (short form),
    // then directly rewrite the branch_tags rows to use the qualified ref form
    // (origin/feat/example), which mirrors how doctor.ts writes pinned branches.
    // This avoids calling runIndex with origin/feat/example (which times out
    // because git rev-parse --verify needs the remote-tracking ref to be fully
    // resolvable in the test environment).
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "full");

    // Now rewrite branch_tags rows: rename "feat/example" → "origin/feat/example"
    // to simulate the pinned-branch storage format.
    const { getDB } = await import("../src/branch-state.js");
    const db = getDB();
    db.prepare(
      "UPDATE branch_tags SET branch=? WHERE project_id=? AND source_id=? AND branch=?"
    ).run("origin/feat/example", project.projectId, project.sourceId, "feat/example");

    // Caller supplies short name — resolver must flip to origin/feat/example.
    const hits = await search(project.projectId, "alphaFarewell", { branch: "feat/example" });
    expect(hits.some((h) => h.content.includes("alphaFarewell"))).toBe(true);
  }, 60000);

  it("Test 2: short-form indexed (feat/example), qualified ref supplied returns hits", async () => {
    // Index normally on feat/example (HEAD-based short-name path).
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "full");

    // Caller supplies qualified form — resolver must strip origin/ prefix.
    const hits = await search(project.projectId, "alphaFarewell", { branch: "origin/feat/example" });
    expect(hits.some((h) => h.content.includes("alphaFarewell"))).toBe(true);
  }, 60000);

  it("Test 3: unknown branch returns [] without throwing", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Index the default branch so the project has some chunks.
    await runIndex(project.projectId, project.sourceId, "full");

    // Neither "completely-made-up" nor "origin/completely-made-up" is indexed.
    const hits = await search(project.projectId, "alphaGreeting", { branch: "completely-made-up" });
    expect(hits).toEqual([]);
  }, 60000);
});
