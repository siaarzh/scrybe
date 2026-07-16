/**
 * Plan 99 Slice 5 — daemon startup sweep of leaked `_ephemeral/*` labels.
 *
 * Drives the sweep in-process (daemon never booted per the orchestrator's
 * guardrail — this test calls `sweepEphemeralBranches` directly against an
 * isolated SCRYBE_DATA_DIR, exactly the shape the real daemon startup hook
 * in main.ts would exercise):
 *
 *   1. Index the real HEAD branch ("master") directly — the durable baseline.
 *   2. index_ephemeral onto "feat/example" — produces chunks shared with
 *      master and chunks unique to the ephemeral label.
 *   3. Seed a decoy branch label ("Xephemeral/foo") that WOULD match an
 *      unescaped `_ephemeral/%` LIKE pattern (single-char wildcard + literal
 *      "ephemeral/") but must NOT match the escaped form the enumerator uses.
 *   4. listEphemeralBranches finds exactly the real ephemeral label — not
 *      "master", not the decoy.
 *   5. sweepEphemeralBranches drops the real ephemeral label (branch_tags/
 *      branch_state gone, unique chunks reclaimed from LanceDB, shared chunks
 *      survive) while "master" and the decoy label are left untouched.
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

describe("Plan 99 Slice 5 — daemon startup ephemeral sweep", () => {
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

  it("reclaims a leaked ephemeral label, spares real branches, and the escaped LIKE does not over-match", async () => {
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

    const { listBranches, getChunkIdsForBranch, listEphemeralBranches, getDB } =
      await import("../src/branch-state.js");
    expect(listBranches(project.projectId, project.sourceId)).toContain("master");
    const masterChunkIds = getChunkIdsForBranch(project.projectId, project.sourceId, "master");
    expect(masterChunkIds.size).toBeGreaterThan(0);

    // ── 4. index_ephemeral onto feat/example ───────────────────────────────
    const { indexEphemeralTool } = await import("../src/tools/reindex.js");
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
    expect(sharedChunkIds.length).toBeGreaterThan(0);
    expect(uniqueChunkIds.length).toBeGreaterThan(0);

    // ── 5. Seed a decoy label that an UNESCAPED '_ephemeral/%' LIKE pattern
    //      would wrongly match ("X" + "ephemeral/" + "foo") but the escaped
    //      form used by listEphemeralBranches must not. ────────────────────
    const decoyLabel = "Xephemeral/foo";
    getDB().prepare(
      `INSERT INTO branch_tags (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(project.projectId, project.sourceId, decoyLabel, "decoy.ts", "decoy-chunk-id", 1, 1);
    expect(listBranches(project.projectId, project.sourceId)).toContain(decoyLabel);

    // ── 6. The enumerator finds exactly the real ephemeral label ───────────
    const enumerated = listEphemeralBranches(project.projectId, project.sourceId);
    expect(enumerated).toEqual([indexResult.label]);
    expect(enumerated).not.toContain(decoyLabel);
    expect(enumerated).not.toContain("master");

    // ── 7. Run the startup sweep exactly as main.ts would ──────────────────
    const { sweepEphemeralBranches } = await import("../src/daemon/ephemeral-sweep.js");
    const { listProjects } = await import("../src/registry.js");
    const swept = await sweepEphemeralBranches(listProjects());

    expect(swept).toHaveLength(1);
    expect(swept[0]?.label).toBe(indexResult.label);
    expect(swept[0]?.orphansDeleted).toBeGreaterThanOrEqual(uniqueChunkIds.length);

    // ── 8. Ephemeral label gone (branch_tags/branch_state/hashes + chunk set empty) ──
    const branchesAfter = listBranches(project.projectId, project.sourceId);
    expect(branchesAfter).not.toContain(indexResult.label);
    expect(getChunkIdsForBranch(project.projectId, project.sourceId, indexResult.label).size).toBe(0);

    // ── 9. Real branches + the decoy survive untouched ─────────────────────
    expect(branchesAfter).toContain("master");
    expect(branchesAfter).toContain(decoyLabel);

    // ── 10. Unique chunks reclaimed by gc; shared chunks (still tagged to master) survive ──
    const { getSource } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const source = getSource(project.projectId, project.sourceId);
    expect(source?.table_name).toBeTruthy();
    const lanceIdsAfter = await listChunkIds(project.projectId, source!.table_name!);
    for (const id of sharedChunkIds) expect(lanceIdsAfter).toContain(id);
    for (const id of uniqueChunkIds) expect(lanceIdsAfter).not.toContain(id);
  }, 60_000);
});
