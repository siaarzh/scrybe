/**
 * Phase 3 — Job queue: concurrency limiting, JSONL logging, event emission.
 * Uses vi.mock for jobs.ts and injects a pushEvent spy directly (no http-server dep).
 * Relies on isolate.ts (setupFiles) for per-test module reset + temp SCRYBE_DATA_DIR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import type { DaemonEvent } from "../src/daemon/http-server.js";

// ─── Mocks (hoisted by vitest) ────────────────────────────────────────────

vi.mock("../src/jobs.js", () => ({
  submitJob: vi.fn(),
  submitSourceJob: vi.fn(),
  getJobStatus: vi.fn(),
  cancelJob: vi.fn(),
  cancelAllJobs: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Per-test fake timers — isolate.ts already resets modules so the queue starts fresh
  vi.useFakeTimers();
});

afterEach(async () => {
  // Stop any lingering queue intervals before module state is wiped by isolate.ts
  try {
    const { stopQueue } = await import("../src/daemon/queue.js");
    stopQueue();
  } catch { /* ignore */ }
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("getQueueStats", () => {
  it("returns initial idle state", async () => {
    const { initQueue, getQueueStats } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });
    const stats = getQueueStats();
    expect(stats.active).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.maxConcurrent).toBeGreaterThan(0);
  });
});

describe("enqueue — basic job submission", () => {
  it("resolves with jobId returned by submitJob", async () => {
    const { submitJob } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-abc");

    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    const jobId = await enqueue({ projectId: "proj1", mode: "incremental" });
    expect(jobId).toBe("job-abc");
    expect(submitJob).toHaveBeenCalledWith("proj1", "incremental", undefined, undefined, expect.any(String));
  });

  it("uses submitSourceJob when sourceId is provided", async () => {
    const { submitSourceJob } = await import("../src/jobs.js");
    vi.mocked(submitSourceJob).mockReturnValue("job-src");

    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    const jobId = await enqueue({ projectId: "proj1", sourceId: "primary", mode: "incremental" });
    expect(jobId).toBe("job-src");
    expect(submitSourceJob).toHaveBeenCalledWith("proj1", "primary", "incremental", undefined, expect.any(String));
  });

  it("emits job.started event via pushEvent", async () => {
    const { submitJob } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-xyz");

    const events: DaemonEvent[] = [];
    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: (ev) => events.push(ev) });

    await enqueue({ projectId: "proj1" });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("job.started");
    expect(events[0].projectId).toBe("proj1");
    expect(events[0].detail?.jobId).toBe("job-xyz");
  });
});

describe("enqueue — completion events", () => {
  it("emits job.completed when getJobStatus returns done", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-1");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-1", project_id: "proj1", mode: "incremental",
      status: "done", tasks: [], started_at: Date.now() - 100,
      finished_at: Date.now(), error: null,
    });

    const events: DaemonEvent[] = [];
    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: (ev) => events.push(ev) });

    await enqueue({ projectId: "proj1" });

    // Advance past the 200ms watch interval
    vi.advanceTimersByTime(300);

    expect(events.some((e) => e.event === "job.completed")).toBe(true);
    const done = events.find((e) => e.event === "job.completed")!;
    expect(done.level).toBe("info");
    expect(done.projectId).toBe("proj1");
  });

  it("emits job.failed with error on failure", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-fail");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-fail", project_id: "proj1", mode: "incremental",
      status: "failed", tasks: [], started_at: Date.now() - 100,
      finished_at: Date.now(), error: "embedding API error",
    });

    const events: DaemonEvent[] = [];
    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: (ev) => events.push(ev) });

    await enqueue({ projectId: "proj1" });
    vi.advanceTimersByTime(300);

    const failed = events.find((e) => e.event === "job.failed");
    expect(failed).toBeDefined();
    expect(failed!.level).toBe("error");
    expect(failed!.error?.message).toBe("embedding API error");
  });

  it("emits job.cancelled when status is cancelled", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-cancel");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-cancel", project_id: "proj1", mode: "incremental",
      status: "cancelled", tasks: [], started_at: Date.now() - 100,
      finished_at: Date.now(), error: null,
    });

    const events: DaemonEvent[] = [];
    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: (ev) => events.push(ev) });

    await enqueue({ projectId: "proj1" });
    vi.advanceTimersByTime(300);

    expect(events.some((e) => e.event === "job.cancelled")).toBe(true);
  });
});

describe("enqueue — concurrency", () => {
  it("serializes jobs for the same project", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    let j1Done = false;
    vi.mocked(submitJob).mockReturnValueOnce("job-A").mockReturnValueOnce("job-B");
    vi.mocked(getJobStatus).mockImplementation((id) => {
      if (id === "job-A") return {
        job_id: id, project_id: "same", mode: "incremental" as const,
        status: j1Done ? ("done" as const) : ("running" as const),
        tasks: [], started_at: Date.now(), finished_at: j1Done ? Date.now() : null, error: null,
      };
      return { job_id: id, project_id: "same", mode: "incremental" as const, status: "done" as const, tasks: [], started_at: Date.now(), finished_at: Date.now(), error: null };
    });

    const { initQueue, enqueue, getQueueStats } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    // Enqueue 2 jobs for the same project — second must wait
    const p1 = enqueue({ projectId: "same" });
    const _p2 = enqueue({ projectId: "same" }); // queued
    await p1;

    expect(getQueueStats().active).toBe(1);
    expect(getQueueStats().pending).toBe(1);

    // Complete first job
    j1Done = true;
    vi.advanceTimersByTime(300);

    // Second job should now be active
    expect(getQueueStats().pending).toBe(0);
  });
});

describe("JSONL logging", () => {
  it("appends events to daemon-log.jsonl", async () => {
    const { submitJob } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-log");

    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    await enqueue({ projectId: "proj-log" });

    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as DaemonEvent);
    expect(parsed[0].event).toBe("job.started");
    expect(parsed[0].projectId).toBe("proj-log");
  });

  it("rotates daemon-log.jsonl when it exceeds 10 MB", async () => {
    // Pre-fill the log file to just over 10 MB
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    const bigLine = "{" + "x".repeat(1023) + "}\n";
    const iterations = Math.ceil((10 * 1024 * 1024 + 1) / bigLine.length);
    writeFileSync(logPath, bigLine.repeat(iterations), "utf8");
    expect(statSync(logPath).size).toBeGreaterThanOrEqual(10 * 1024 * 1024);

    const { submitJob } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-rotate");

    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    await enqueue({ projectId: "proj-rotate" });

    // Original file should be rotated to .1
    const arc1 = `${logPath}.1`;
    expect(existsSync(arc1)).toBe(true);
    // New log file should be small (just the started event)
    expect(statSync(logPath).size).toBeLessThan(1024);
  });
});

describe("stopQueue", () => {
  it("rejects pending items and clears timers", async () => {
    // Drain is blocked — project A active, project A also pending
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-stop");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-stop", project_id: "proj", mode: "incremental" as const,
      status: "running", tasks: [], started_at: Date.now(), finished_at: null, error: null,
    });

    const { initQueue, enqueue, stopQueue, getQueueStats } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    await enqueue({ projectId: "proj" }); // active
    const pending = enqueue({ projectId: "proj" }); // queued (same project)

    stopQueue();
    expect(getQueueStats().active).toBe(0);
    expect(getQueueStats().pending).toBe(0);
    await expect(pending).rejects.toThrow("Queue stopped");
  });
});
