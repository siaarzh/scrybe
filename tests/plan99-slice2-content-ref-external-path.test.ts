/**
 * Plan 99 Slice 2 — contentRef threaded through the external submit path.
 *
 * Before this slice, the CLI/MCP surface had no way to set a stored branch
 * label that differs from the git ref content is read from — `reindex_source`
 * / `reindex_project` only accepted `branch`, and the daemon's `kickHandler`
 * silently dropped `contentRef` even though queue.ts/jobs.ts/indexer.ts already
 * carried it end-to-end (see .plans/state/orchestrator/plan-99/step-1.json).
 *
 * This test drives the NEW external hop — the `reindex_source` MCP tool's
 * `content_ref` argument — through jobs.ts (in-process fallback, since the
 * daemon must stay down per the orchestrator's daemon-boot guardrail) and
 * into indexSource, and asserts:
 *
 *   1. The stored label ("custom-label") is what appears in branch_tags/
 *      branch_state — never the content ref itself.
 *   2. The content actually indexed under that label matches contentRef
 *      ("origin/feat/example"), NOT the local working tree's checked-out
 *      HEAD ("main") — proven both by SHA comparison and by a search hit
 *      unique to the feat/example branch (`alphaFarewell`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { cloneFixture, cloneLocal, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";

const LABEL = "custom-label";
const CONTENT_REF = "origin/feat/example";

describe("Plan 99 Slice 2 — contentRef via reindex_source (external submit path)", () => {
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

  it("label stays 'custom-label' while content is read from origin/feat/example, not local HEAD", async () => {
    // ── 1. Real remote + local clone (main=HEAD, origin/feat/example fetched) ──
    remote = await cloneFixture("sample-multi-branch-repo");
    local = cloneLocal(remote.path);

    project = await createTempProject({ rootPath: local.path, languages: ["ts"] });

    // ── 2. Force the in-process fallback — never spawn the daemon in a test ──
    prevNoAutoDaemon = process.env["SCRYBE_NO_AUTO_DAEMON"];
    process.env["SCRYBE_NO_AUTO_DAEMON"] = "1";

    // ── 3. Drive the MCP tool's new content_ref arg (the hop this slice fixed) ──
    const { reindexSourceTool } = await import("../src/tools/reindex.js");
    const submitResp = await reindexSourceTool.handler({
      project_id: project.projectId,
      source_id: project.sourceId,
      mode: "full",
      branch: LABEL,
      content_ref: CONTENT_REF,
    });
    expect(submitResp.job_id).toBeTruthy();

    // ── 4. submitSourceJob is fire-and-forget — poll until the background job finishes ──
    const { getJobStatus } = await import("../src/jobs.js");
    const deadline = Date.now() + 20_000;
    let finalStatus: string | undefined;
    while (Date.now() < deadline) {
      const status = getJobStatus(submitResp.job_id);
      finalStatus = status?.status;
      if (finalStatus === "done" || finalStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(finalStatus).toBe("done");

    // ── 5. The stored label is LABEL, never the content ref itself ──────────
    const { listBranches, getLastIndexedSha } = await import("../src/branch-state.js");
    const branches = listBranches(project.projectId, project.sourceId);
    expect(branches).toContain(LABEL);
    expect(branches).not.toContain(CONTENT_REF);

    // ── 6. Content SHA under LABEL matches contentRef, not local HEAD ───────
    const shaUnderLabel = getLastIndexedSha(project.projectId, project.sourceId, LABEL);
    const originFeatSha = execSync(`git -C "${local.path}" rev-parse ${CONTENT_REF}`, { encoding: "utf8" }).trim();
    const localHeadSha = execSync(`git -C "${local.path}" rev-parse HEAD`, { encoding: "utf8" }).trim();
    expect(shaUnderLabel).toBe(originFeatSha);
    expect(shaUnderLabel).not.toBe(localHeadSha);

    // ── 7. Search under LABEL finds content unique to feat/example ──────────
    const { searchCode } = await import("../src/search.js");
    const results = await searchCode("alphaFarewell", project.projectId, { limit: 10, branch: LABEL });
    expect(results.some((r) => (r.item_path ?? "").includes("alpha.ts") && r.symbol_name === "alphaFarewell")).toBe(true);
  });
});
