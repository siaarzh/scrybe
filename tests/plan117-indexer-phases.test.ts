/**
 * Plan 117 — the indexer actually emits the per-phase records, end to end.
 *
 * The unit tests in plan117-phase-telemetry.test.ts cover the emitter; this
 * file covers the wiring: a real index run over a fixture repo must leave a
 * phase-log whose phases match the code path taken, in order, with the work
 * counters populated.
 *
 * The second case is the one this plan exists for: an incremental re-run that
 * decides to process NOTHING must still leave records saying so. Previously
 * that outcome was indistinguishable from "the daemon was killed before it
 * could write anything".
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";

function readPhaseLog(): Array<Record<string, any>> {
  const path = join(process.env["SCRYBE_DATA_DIR"]!, "phase-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("indexer per-phase memory telemetry", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("a full index emits the phases the code actually runs, in order", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const records = readPhaseLog();
    const phases = records.filter((r) => r.event === "indexer.phase").map((r) => r.phase);

    // preflight_health is full-mode only; chunk_embed may appear more than once
    // if the run crossed a segment boundary.
    expect(phases[0]).toBe("preflight_health");
    expect(phases).toContain("scan");
    expect(phases).toContain("diff");
    expect(phases).toContain("stale_apply");
    expect(phases).toContain("chunk_embed");
    expect(phases.indexOf("scan")).toBeLessThan(phases.indexOf("diff"));
    expect(phases.indexOf("diff")).toBeLessThan(phases.indexOf("stale_apply"));
    expect(phases.indexOf("stale_apply")).toBeLessThan(phases.indexOf("chunk_embed"));

    // Every record carries the join keys and a full RSS triple.
    for (const r of records.filter((x) => x.event === "indexer.phase")) {
      expect(r.projectId).toBe(project!.projectId);
      expect(r.sourceId).toBe(project!.sourceId);
      expect(r.pid).toBe(process.pid);
      expect(typeof r.startRssBytes).toBe("number");
      expect(typeof r.peakRssBytes).toBe("number");
      expect(typeof r.endRssBytes).toBe("number");
      expect(r.peakRssBytes).toBeGreaterThanOrEqual(r.startRssBytes);
      expect(r.outcome).toBe("ok");
    }

    const scan = records.find((r) => r.phase === "scan")!;
    expect(scan.work.sources_found).toBeGreaterThan(0);

    const diff = records.find((r) => r.phase === "diff")!;
    expect(diff.work.files_total).toBeGreaterThan(0);
    expect(diff.work.files_to_reindex).toBeGreaterThan(0);

    const embed = records.filter((r) => r.phase === "chunk_embed");
    expect(embed.at(-1)!.final).toBe(true);
    expect(embed.at(-1)!.work.cumulative_chunks_prepared).toBeGreaterThan(0);
  });

  it("records job intent, so 'scanned N, processed 0' is distinguishable from 'no record written'", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");
    await runIndex(project.projectId, project.sourceId, "incremental");

    const intents = readPhaseLog().filter((r) => r.event === "indexer.job.intent");
    const incremental = intents.filter((r) => r.mode === "incremental");

    expect(incremental.map((r) => r.stage)).toEqual(["started", "planned"]);
    const planned = incremental.find((r) => r.stage === "planned")!;
    expect(planned.files_total).toBeGreaterThan(0);
    expect(planned.files_to_reindex).toBe(0);
    expect(planned.files_to_remove).toBe(0);

    // And the no-op run still produced its own phase records.
    const phases = readPhaseLog()
      .filter((r) => r.event === "indexer.phase" && r.mode === "incremental")
      .map((r) => r.phase);
    expect(phases).toContain("scan");
    expect(phases).toContain("diff");
    expect(phases).toContain("chunk_embed");
    // Nothing changed → no FTS rebuild / compaction / prune ran.
    expect(phases).not.toContain("compact");
    expect(phases).not.toContain("prune_orphans");
  });
});
