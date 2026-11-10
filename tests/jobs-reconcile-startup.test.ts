import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const CUTOFF = 1_000_000;

describe("reconcileOrphanedJobs", () => {
  it("marks pre-cutoff pending jobs, leaves later ones, and is idempotent", async () => {
    const dir = process.env["SCRYBE_DATA_DIR"]!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify([{ id: "live", description: "", sources: [] }]),
      "utf8"
    );

    const { insertJob, reconcileOrphanedJobs, listJobRows } = await import("../src/jobs-store.js");
    const mk = (job_id: string, project_id: string, status: "queued" | "running", queued_at: number) =>
      insertJob({
        job_id, project_id, source_id: null, branch: null, mode: "incremental", status,
        phase: null, queued_at, started_at: null, finished_at: null, error_message: null,
        origin: "daemon", type: "reindex", result: null,
      });

    mk("live-run-old", "live", "running", CUTOFF - 10);
    mk("live-q-old", "live", "queued", CUTOFF - 20);
    mk("gone-run-old", "gone", "running", CUTOFF - 30);
    mk("gone-q-old", "gone", "queued", CUTOFF - 40);
    mk("all-run-old", "*", "running", CUTOFF - 50);
    mk("live-run-new", "live", "running", CUTOFF + 10);
    mk("live-q-new", "live", "queued", CUTOFF + 20);
    mk("gone-q-new", "gone", "queued", CUTOFF + 30);

    const res = reconcileOrphanedJobs(CUTOFF);
    expect(res.interrupted).toBe(3);
    expect(res.cancelled).toBe(2);
    expect(res.sampleJobIds.sort()).toEqual(["all-run-old", "gone-q-old", "gone-run-old", "live-q-old", "live-run-old"]);

    const byId = new Map(listJobRows({ limit: 50 }).map((j) => [j.job_id, j]));
    for (const id of ["live-run-old", "live-q-old", "all-run-old"]) {
      expect(byId.get(id)!.status).toBe("interrupted");
      expect(byId.get(id)!.error_message).toBe("interrupted by daemon restart");
      expect(byId.get(id)!.finished_at).not.toBeNull();
    }
    for (const id of ["gone-run-old", "gone-q-old"]) {
      expect(byId.get(id)!.status).toBe("cancelled");
      expect(byId.get(id)!.error_message).toContain("zombie cleanup");
    }
    expect(byId.get("live-run-new")!.status).toBe("running");
    expect(byId.get("live-q-new")!.status).toBe("queued");
    expect(byId.get("gone-q-new")!.status).toBe("queued");

    expect(reconcileOrphanedJobs(CUTOFF)).toEqual({ interrupted: 0, cancelled: 0, sampleJobIds: [] });
  });
});

describe("reconcileOrphanedJobs with an unreadable registry", () => {
  it("interrupts instead of cancelling everything as removed", async () => {
    const dir = process.env["SCRYBE_DATA_DIR"]!;
    writeFileSync(join(dir, "projects.json"), "{ not json", "utf8");
    const { insertJob, reconcileOrphanedJobs, getJobRow } = await import("../src/jobs-store.js");
    insertJob({
      job_id: "unreadable-old", project_id: "live", source_id: null, branch: null, mode: "incremental", status: "running",
      phase: null, queued_at: CUTOFF - 5, started_at: null, finished_at: null, error_message: null,
      origin: "daemon", type: "reindex", result: null,
    });
    const res = reconcileOrphanedJobs(CUTOFF);
    expect(res).toMatchObject({ interrupted: 1, cancelled: 0 });
    expect(getJobRow("unreadable-old")!.status).toBe("interrupted");
  });
});

describe("reconcileOrphanedJobs while another process holds the write lock", () => {
  it("waits for it instead of failing at once", async () => {
    const dir = process.env["SCRYBE_DATA_DIR"]!;
    writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: "live", description: "", sources: [] }]), "utf8");
    const { insertJob, reconcileOrphanedJobs, getJobRow } = await import("../src/jobs-store.js");
    insertJob({
      job_id: "busy-old", project_id: "live", source_id: null, branch: null, mode: "incremental", status: "running",
      phase: null, queued_at: CUTOFF - 5, started_at: null, finished_at: null, error_message: null,
      origin: "daemon", type: "reindex", result: null,
    });
    const { spawn } = await import("child_process");
    const holderSrc = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);` +
      ` db.exec("BEGIN IMMEDIATE"); process.stdout.write("HELD"); setTimeout(() => { db.exec("COMMIT"); process.exit(0); }, 1200);`;
    const holder = spawn(process.execPath, ["-e", holderSrc, join(dir, "branch-tags.db")], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => holder.stdout!.on("data", (b) => { if (String(b).includes("HELD")) resolve(); }));

    const t0 = Date.now();
    const res = reconcileOrphanedJobs(CUTOFF);
    const waited = Date.now() - t0;

    expect(res.interrupted).toBe(1);
    expect(getJobRow("busy-old")!.status).toBe("interrupted");
    expect(waited).toBeGreaterThan(500);
  }, 20_000);
});

describe("reconcileOrphanedJobs with a valid but empty registry", () => {
  it("cancels rows for projects that are no longer registered", async () => {
    const dir = process.env["SCRYBE_DATA_DIR"]!;
    writeFileSync(join(dir, "projects.json"), "[]", "utf8");
    const { insertJob, reconcileOrphanedJobs, getJobRow } = await import("../src/jobs-store.js");
    insertJob({
      job_id: "empty-reg-old", project_id: "gone", source_id: null, branch: null, mode: "incremental", status: "queued",
      phase: null, queued_at: CUTOFF - 5, started_at: null, finished_at: null, error_message: null,
      origin: "daemon", type: "reindex", result: null,
    });
    const res = reconcileOrphanedJobs(CUTOFF);
    expect(res).toMatchObject({ interrupted: 0, cancelled: 1 });
    expect(getJobRow("empty-reg-old")!.status).toBe("cancelled");
  });
});

describe("reconcileJobsAtStartup", () => {
  it("runs only for the data-dir lock holder, with the time it took the lock as the cutoff", async () => {
    const { reconcileJobsAtStartup } = await import("../src/daemon/main.js");
    const calls: number[] = [];
    const emitted: unknown[] = [];
    const reconcile = (t: number) => { calls.push(t); return { interrupted: 1, cancelled: 0, sampleJobIds: ["x"] }; };

    reconcileJobsAtStartup("contended", 42, (e) => emitted.push(e), reconcile);
    reconcileJobsAtStartup("unavailable", 42, (e) => emitted.push(e), reconcile);
    expect(calls).toEqual([]);
    expect(emitted).toEqual([]);

    reconcileJobsAtStartup("acquired", 42, (e) => emitted.push(e), reconcile);
    expect(calls).toEqual([42]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ event: "jobs.reconciled", detail: { interrupted: 1, cancelled: 0, sampleJobIds: ["x"] } });
  });

  it("emits nothing when there was nothing to close, and survives a failing reconcile", async () => {
    const { reconcileJobsAtStartup } = await import("../src/daemon/main.js");
    const emitted: unknown[] = [];
    reconcileJobsAtStartup("acquired", 1, (e) => emitted.push(e), () => ({ interrupted: 0, cancelled: 0, sampleJobIds: [] }));
    expect(() => reconcileJobsAtStartup("acquired", 1, (e) => emitted.push(e), () => { throw new Error("db locked"); })).not.toThrow();
    expect(emitted).toEqual([]);
  });
});
