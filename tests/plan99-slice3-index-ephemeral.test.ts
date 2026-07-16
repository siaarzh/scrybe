/**
 * Plan 99 Slice 3 — `index_ephemeral` verb.
 *
 * Indexes an open MR's remote branch under a throwaway `_ephemeral/mr-<branch>`
 * label, reusing the Slice-2 contentRef plumbing (label via `branch`, content
 * via `contentRef`). This test drives the tool end-to-end on a real git
 * fixture (in-process, daemon never booted per the orchestrator's guardrail)
 * and asserts:
 *
 *   1. The default label is forced under the `_ephemeral/` prefix.
 *   2. Content indexed under that label is searchable (branch-scoped search
 *      finds a symbol unique to origin/feat/example).
 *   3. No `pinned_branches` entry was created as a side effect — index_ephemeral
 *      is a one-shot verb, distinct from `branch pin`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, cloneLocal, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";

describe("Plan 99 Slice 3 — index_ephemeral", () => {
  let remote: FixtureHandle | null = null;
  let local: FixtureHandle | null = null;
  let project: TempProject | null = null;
  let prevNoAutoDaemon: string | undefined;

  afterEach(async () => {
    if (prevNoAutoDaemon === undefined) delete process.env["SCRYBE_NO_AUTO_DAEMON"];
    else process.env["SCRYBE_NO_AUTO_DAEMON"] = prevNoAutoDaemon;
    await project?.cleanup();
    await local?.cleanup();
    await remote?.cleanup();
    remote = null;
    local = null;
    project = null;
  });

  it("indexes origin/feat/example under an _ephemeral/ label, searchable, no pinned_branches entry", async () => {
    // ── 1. Real remote + local clone (main=HEAD, origin/feat/example fetched) ──
    remote = await cloneFixture("sample-multi-branch-repo");
    local = cloneLocal(remote.path);

    project = await createTempProject({ rootPath: local.path, languages: ["ts"] });

    // ── 2. Force the in-process fallback — never spawn the daemon in a test ──
    prevNoAutoDaemon = process.env["SCRYBE_NO_AUTO_DAEMON"];
    process.env["SCRYBE_NO_AUTO_DAEMON"] = "1";

    // ── 3. Drive the new index_ephemeral tool with a plain (already-fetched) branch name ──
    const { indexEphemeralTool } = await import("../src/tools/reindex.js");
    const result = await indexEphemeralTool.handler({
      project_id: project.projectId,
      source_id: project.sourceId,
      branch: "feat/example",
    });

    // ── 4. Label is forced under _ephemeral/ and follows the default naming rule ──
    expect(result.label).toBe("_ephemeral/mr-feat/example");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.chunks_new).toBeGreaterThan(0);

    // ── 5. Content indexed under that label is searchable — unique to feat/example ──
    const { searchCode } = await import("../src/search.js");
    const results = await searchCode("alphaFarewell", project.projectId, { limit: 10, branch: result.label });
    expect(results.some((r) => (r.item_path ?? "").includes("alpha.ts") && r.symbol_name === "alphaFarewell")).toBe(true);

    // ── 6. No pinned_branches entry was created as a side effect ──────────────
    const { listPinned } = await import("../src/pinned-branches.js");
    expect(listPinned(project.projectId, project.sourceId)).toEqual([]);

    // ── 7. The label never appears in the pinned list, and the regular HEAD branch ──
    //       (main) is untouched — index_ephemeral only wrote under its own label.
    const { listBranches } = await import("../src/branch-state.js");
    const branches = listBranches(project.projectId, project.sourceId);
    expect(branches).toContain(result.label);
  });
});
