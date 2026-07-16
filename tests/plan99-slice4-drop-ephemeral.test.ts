/**
 * Plan 99 Slice 4 — `drop_ephemeral` verb + surfacing `deleteBranch` + the
 * source-scoped gc fix.
 *
 * Drives the full lifecycle in-process (daemon never booted per the
 * orchestrator's guardrail):
 *
 *   1. Index the real HEAD branch ("master") directly — the durable baseline.
 *   2. index_ephemeral onto "feat/example" — produces both chunks SHARED with
 *      master (beta.ts/gamma.ts, unchanged content — same chunk_id reused
 *      across branches per the branch-tags design) and chunks UNIQUE to the
 *      ephemeral label (alpha.ts differs on feat/example).
 *   3. drop_ephemeral refuses a non-'_ephemeral/' label (safety: must never
 *      touch 'master'/'dev').
 *   4. drop_ephemeral on the real ephemeral label removes its branch_tags/
 *      branch_state (deleteBranch — first real caller) and its gc pass
 *      reclaims the unique chunks from LanceDB while the shared chunks
 *      (still tagged to master) survive.
 *   5. A second drop_ephemeral on the same (now-gone) label is an idempotent
 *      no-op success.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, cloneLocal, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";

async function waitForJobDone(jobId: string) {
  const { getJobStatus } = await import("../src/jobs.js");
  for (let i = 0; i < 400; i++) {
    const s = getJobStatus(jobId);
    if (s && (s.status === "done" || s.status === "failed" || s.status === "cancelled")) return s;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`job ${jobId} did not reach a terminal state in time`);
}

describe("Plan 99 Slice 4 — drop_ephemeral", () => {
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

  it("removes branch_tags/branch_state, reclaims unique chunks, keeps shared chunks, refuses non-ephemeral labels, and is idempotent", async () => {
    // ── 1. Real remote + local clone (master=HEAD, feat/example fetched) ──
    remote = await cloneFixture("sample-multi-branch-repo");
    local = cloneLocal(remote.path);
    project = await createTempProject({ rootPath: local.path, languages: ["ts"] });

    // ── 2. Force the in-process fallback — never spawn the daemon in a test ──
    prevNoAutoDaemon = process.env["SCRYBE_NO_AUTO_DAEMON"];
    process.env["SCRYBE_NO_AUTO_DAEMON"] = "1";

    // ── 3. Index the real HEAD branch ("master") directly ─────────────────
    const { submitSourceJob } = await import("../src/jobs.js");
    const masterJobResult = submitSourceJob(project.projectId, project.sourceId, "incremental");
    expect(typeof masterJobResult).toBe("string");
    const masterStatus = await waitForJobDone(masterJobResult as string);
    expect(masterStatus?.status).toBe("done");

    const { listBranches, getChunkIdsForBranch } = await import("../src/branch-state.js");
    expect(listBranches(project.projectId, project.sourceId)).toContain("master");
    const masterChunkIds = getChunkIdsForBranch(project.projectId, project.sourceId, "master");
    expect(masterChunkIds.size).toBeGreaterThan(0);

    // ── 4. index_ephemeral onto feat/example ───────────────────────────────
    const { indexEphemeralTool, dropEphemeralTool } = await import("../src/tools/reindex.js");
    const indexResult = await indexEphemeralTool.handler({
      project_id: project.projectId,
      source_id: project.sourceId,
      branch: "feat/example",
    });
    expect(indexResult.label).toBe("_ephemeral/mr-feat/example");

    const ephemeralChunkIds = getChunkIdsForBranch(project.projectId, project.sourceId, indexResult.label);
    expect(ephemeralChunkIds.size).toBeGreaterThan(0);

    const sharedChunkIds = [...ephemeralChunkIds].filter((id) => masterChunkIds.has(id));
    const uniqueChunkIds = [...ephemeralChunkIds].filter((id) => !masterChunkIds.has(id));
    // beta.ts/gamma.ts are unchanged between branches -> reused chunk_id, shared.
    expect(sharedChunkIds.length).toBeGreaterThan(0);
    // alpha.ts differs on feat/example (adds alphaFarewell) -> at least one unique chunk.
    expect(uniqueChunkIds.length).toBeGreaterThan(0);

    // ── 5. Refuses to drop a non-'_ephemeral/' label (safety) ──────────────
    await expect(
      dropEphemeralTool.handler({ project_id: project.projectId, source_id: project.sourceId, label: "master" })
    ).rejects.toThrow(/refuses/);
    // master untouched by the refused call
    expect(listBranches(project.projectId, project.sourceId)).toContain("master");

    // ── 6. Drop the real ephemeral label ────────────────────────────────────
    const dropResult = await dropEphemeralTool.handler({
      project_id: project.projectId,
      source_id: project.sourceId,
      label: indexResult.label,
    });
    expect(dropResult.label).toBe(indexResult.label);
    expect(dropResult.dropped).toBe(true);
    expect(dropResult.orphans_deleted).toBeGreaterThanOrEqual(uniqueChunkIds.length);

    // branch_tags/branch_state gone; listBranches no longer shows it; chunk-id set empty.
    const branchesAfter = listBranches(project.projectId, project.sourceId);
    expect(branchesAfter).not.toContain(indexResult.label);
    expect(getChunkIdsForBranch(project.projectId, project.sourceId, indexResult.label).size).toBe(0);

    // ── 7. Unique chunks reclaimed by gc; shared chunks (still tagged to master) survive ──
    const { getSource } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const source = getSource(project.projectId, project.sourceId);
    expect(source?.table_name).toBeTruthy();
    const lanceIdsAfter = await listChunkIds(project.projectId, source!.table_name!);
    for (const id of sharedChunkIds) expect(lanceIdsAfter).toContain(id);
    for (const id of uniqueChunkIds) expect(lanceIdsAfter).not.toContain(id);

    // ── 8. Idempotent: dropping an already-gone label is a no-op success ───
    const dropAgain = await dropEphemeralTool.handler({
      project_id: project.projectId,
      source_id: project.sourceId,
      label: indexResult.label,
    });
    expect(dropAgain.dropped).toBe(false);
    expect(dropAgain.orphans_deleted).toBe(0);
  }, 60_000);
});
