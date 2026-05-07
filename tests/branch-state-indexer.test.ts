/**
 * Plan 50 Slice 3 — branch_state table + indexer write-on-success.
 *
 * Tests #5–#8:
 *   #5  wipeBranch() removes the branch_state row.
 *   #6  wipeSource() removes all branch_state rows for (project, source).
 *   #7  deleteBranch() removes the branch_state row for that branch.
 *   #8  Successful indexer run writes branch_state with the captured SHA;
 *       aborted/thrown run leaves no row.
 *
 * Uses the same patterns as tests/branch-state.test.ts (dynamic imports,
 * per-test DATA_DIR isolation from tests/isolate.ts) and tests/indexer.test.ts
 * (cloneFixture + createTempProject + runIndex for end-to-end indexer tests).
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";

const P = "bs-idx-proj";
const S = "bs-idx-src";
const B = "main";

// ─── Test #5 ─────────────────────────────────────────────────────────────────

describe("branch_state — wipeBranch clears row", () => {
  it("wipeBranch() removes the branch_state row", async () => {
    const { withBranchSession, setLastIndexedSha, getLastIndexedSha } =
      await import("../src/branch-state.js");

    // Seed a branch_state row directly.
    setLastIndexedSha(P, S, B, "deadbeef1234", Date.now());
    expect(getLastIndexedSha(P, S, B)).toBe("deadbeef1234");

    // wipeBranch via a session.
    await withBranchSession(
      { projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.wipeBranch();
      }
    );

    expect(getLastIndexedSha(P, S, B)).toBeNull();
  });
});

// ─── Test #6 ─────────────────────────────────────────────────────────────────

describe("branch_state — wipeSource clears all rows", () => {
  it("wipeSource() removes all branch_state rows for the (project, source)", async () => {
    const { wipeSource, setLastIndexedSha, getLastIndexedSha } =
      await import("../src/branch-state.js");

    // Seed two rows on different branches.
    setLastIndexedSha(P, S, "main", "sha-main-1", Date.now());
    setLastIndexedSha(P, S, "feat/x", "sha-feat-x-1", Date.now());

    expect(getLastIndexedSha(P, S, "main")).not.toBeNull();
    expect(getLastIndexedSha(P, S, "feat/x")).not.toBeNull();

    wipeSource(P, S);

    expect(getLastIndexedSha(P, S, "main")).toBeNull();
    expect(getLastIndexedSha(P, S, "feat/x")).toBeNull();
  });

  it("wipeSource() does not affect rows for a different source", async () => {
    const { wipeSource, setLastIndexedSha, getLastIndexedSha } =
      await import("../src/branch-state.js");

    setLastIndexedSha(P, S, B, "sha-to-wipe", Date.now());
    setLastIndexedSha(P, "other-source", B, "sha-to-keep", Date.now());

    wipeSource(P, S);

    expect(getLastIndexedSha(P, S, B)).toBeNull();
    expect(getLastIndexedSha(P, "other-source", B)).toBe("sha-to-keep");
  });
});

// ─── Test #7 ─────────────────────────────────────────────────────────────────

describe("branch_state — deleteBranch clears row", () => {
  it("deleteBranch() removes the branch_state row for the branch", async () => {
    const { deleteBranch, setLastIndexedSha, getLastIndexedSha } =
      await import("../src/branch-state.js");

    setLastIndexedSha(P, S, B, "sha-delete-me", Date.now());
    setLastIndexedSha(P, S, "feat/other", "sha-keep-me", Date.now());

    expect(getLastIndexedSha(P, S, B)).toBe("sha-delete-me");

    deleteBranch(P, S, B);

    expect(getLastIndexedSha(P, S, B)).toBeNull();
    // Other branch unaffected.
    expect(getLastIndexedSha(P, S, "feat/other")).toBe("sha-keep-me");
  });
});

// ─── Test #8 ─────────────────────────────────────────────────────────────────

describe("branch_state — indexer write-on-success", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("successful indexer run writes branch_state row with the SHA captured at start", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Capture the expected HEAD SHA before indexing.
    const expectedSha = execSync(`git -C "${fixture.path}" rev-parse HEAD`, {
      encoding: "utf8",
    }).trim();

    await runIndex(project.projectId, project.sourceId, "full");

    // The indexer resolves branch from HEAD, so use the same mechanism.
    const { resolveBranchForPath, getLastIndexedSha } =
      await import("../src/branch-state.js");
    const branch = resolveBranchForPath(fixture.path);
    const recorded = getLastIndexedSha(project.projectId, project.sourceId, branch);

    expect(recorded).not.toBeNull();
    // The SHA at start must match the HEAD at the time the indexer started.
    // (No commits happened during the run, so start SHA === HEAD SHA.)
    expect(recorded).toBe(expectedSha);
  });

  it("aborted indexer run (AbortSignal) does not write a branch_state row", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const ac = new AbortController();
    // Abort immediately — before the indexer can do meaningful work.
    ac.abort();

    const { indexSource } = await import("../src/indexer.js");
    await expect(
      indexSource(project.projectId, project.sourceId, "full", { signal: ac.signal })
    ).rejects.toThrow();

    const { resolveBranchForPath, getLastIndexedSha } =
      await import("../src/branch-state.js");
    const branch = resolveBranchForPath(fixture.path);
    const recorded = getLastIndexedSha(project.projectId, project.sourceId, branch);

    expect(recorded).toBeNull();
  });
});
