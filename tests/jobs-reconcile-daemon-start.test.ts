// The temp daemon skips migrations, so only the start-up reconcile can close these rows.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTempDaemon } from "./helpers/daemon.js";
import type { TempDaemon } from "./helpers/daemon.js";

let daemon: TempDaemon | null = null;

afterEach(async () => {
  if (daemon) { await daemon.stop(); daemon = null; }
});

describe("daemon start reconciles orphaned jobs", () => {
  it("interrupts rows queued before the daemon started and leaves later ones alone", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify([{ id: "live", description: "", sources: [] }]), "utf8");

    const { insertJob, getJobRow } = await import("../src/jobs-store.js");
    const { closeDB } = await import("../src/branch-state.js");
    const row = (job_id: string, status: "queued" | "running", queued_at: number) => ({
      job_id, project_id: "live", source_id: null, branch: null, mode: "incremental" as const, status,
      phase: null, queued_at, started_at: null, finished_at: null, error_message: null,
      origin: "daemon" as const, type: "reindex" as const, result: null,
    });
    insertJob(row("orphan-running", "running", Date.now() - 3_600_000));
    insertJob(row("orphan-queued", "queued", Date.now() - 7_200_000));
    insertJob(row("future-queued", "queued", Date.now() + 3_600_000));
    closeDB();

    // An inherited SCRYBE_DAEMON_LOG_PATH would mix other runs' records and the plain-text log into the file read below.
    const inheritedLogPath = process.env["SCRYBE_DAEMON_LOG_PATH"];
    delete process.env["SCRYBE_DAEMON_LOG_PATH"];
    const beforeStart = Date.now();
    try {
      daemon = await startTempDaemon({ dataDir, projects: [] }); // the daemon reads projects.json, written above
    } finally {
      if (inheritedLogPath !== undefined) process.env["SCRYBE_DAEMON_LOG_PATH"] = inheritedLogPath;
    }

    expect(getJobRow("orphan-running")!.status).toBe("interrupted");
    expect(getJobRow("orphan-queued")!.status).toBe("interrupted");
    expect(getJobRow("orphan-running")!.error_message).toBe("interrupted by daemon restart");
    expect(getJobRow("future-queued")!.status).toBe("queued");

    const records = readFileSync(join(dataDir, "daemon-log.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l));
    const events = records.filter((e) => e.event === "jobs.reconciled");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ interrupted: 2, cancelled: 0 });
    expect([...events[0].detail.sampleJobIds].sort()).toEqual(["orphan-queued", "orphan-running"]);

    // The cutoff is the lock time, taken before daemon.start is logged, not the later startedAt.
    const starts = records.filter((e) => e.event === "daemon.start");
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(events[0].detail.cutoffMs).toBeGreaterThanOrEqual(beforeStart);
    expect(events[0].detail.cutoffMs).toBeLessThanOrEqual(Date.parse(start.ts));
  }, 60_000);
});
