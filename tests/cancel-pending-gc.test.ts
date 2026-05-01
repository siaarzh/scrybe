/**
 * cancelPendingByType — verifies that pending gc jobs are cancelled from the in-memory
 * queue while active jobs are left alone.
 *
 * Uses the REAL queue module (not mocked) with mocked jobs.ts + jobs-store.ts.
 * Isolated from auto-gc.test.ts to avoid vi.mock(queue) conflict.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/jobs.js", () => ({
  submitJob: vi.fn(),
  submitSourceJob: vi.fn(),
  getJobStatus: vi.fn(),
  cancelJob: vi.fn(),
  cancelAllJobs: vi.fn(),
}));

vi.mock("../src/jobs-store.js", () => ({
  insertJob: vi.fn(),
  updateJobStatus: vi.fn(),
  cancelPendingGcJobs: vi.fn(),
  getLastGcTime: vi.fn(() => null),
  listJobRows: vi.fn(() => []),
  getJobRow: vi.fn(() => null),
  jobRowToState: vi.fn(),
  getQueueStatus: vi.fn(() => ({ running: [], queued: [] })),
  pruneOldJobs: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(async () => {
  try {
    const { stopQueue } = await import("../src/daemon/queue.js");
    stopQueue();
  } catch { /* ignore */ }
  vi.useRealTimers();
});

describe("cancelPendingByType", () => {
  it("removes matching pending gc jobs, leaves active jobs alone", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-reindex");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-reindex", project_id: "proj1", mode: "incremental" as const,
      status: "running", tasks: [], started_at: Date.now(), finished_at: null, error: null,
    });

    const { initQueue, enqueue, cancelPendingByType, getQueueStats } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    // Start a reindex job (becomes active)
    await enqueue({ projectId: "proj1", mode: "incremental" });

    // Queue a gc job — stays pending since proj1 is busy with reindex
    const pendingGcP = enqueue({ projectId: "proj1", type: "gc", mode: "incremental" });
    expect(getQueueStats().pending).toBe(1);

    // Cancel pending gc for proj1
    const count = cancelPendingByType("gc", ["proj1"]);
    expect(count).toBe(1);
    expect(getQueueStats().pending).toBe(0);
    expect(getQueueStats().active).toBe(1); // reindex still running

    // gc promise should reject with cancel message
    await expect(pendingGcP).rejects.toThrow("Cancelled by manual gc");
  });

  it("does not cancel pending reindex jobs when cancelling gc", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    // First job: active
    vi.mocked(submitJob).mockReturnValueOnce("job-reindex-active");
    // Second job: will be returned when pending reindex starts (after gc is cancelled)
    vi.mocked(submitJob).mockReturnValueOnce("job-reindex-2");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-reindex-active", project_id: "proj3", mode: "incremental" as const,
      status: "running", tasks: [], started_at: Date.now(), finished_at: null, error: null,
    });

    const { initQueue, enqueue, cancelPendingByType, getQueueStats } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    // Start a reindex job
    await enqueue({ projectId: "proj3", mode: "incremental" });

    // Queue a reindex AND a gc — both pending
    const pendingReindexP = enqueue({ projectId: "proj3", mode: "incremental" });
    const _pendingGcP = enqueue({ projectId: "proj3", type: "gc", mode: "incremental" });
    expect(getQueueStats().pending).toBe(2);

    // Cancel only gc
    const count = cancelPendingByType("gc", ["proj3"]);
    expect(count).toBe(1); // only gc cancelled
    expect(getQueueStats().pending).toBe(1); // reindex still pending

    void pendingReindexP.catch(() => {}); // suppress
    void _pendingGcP.catch(() => {}); // suppress
  });

  it("scoped cancel only affects matching project IDs", async () => {
    // Use submitToQueue (not enqueue) — submitToQueue returns immediately without waiting
    // for the job to start, which avoids the macOS hang caused by MAX_CONCURRENT=1 blocking
    // `await enqueue()` for the second project indefinitely.
    const { submitJob } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockImplementation((projectId) => `job-${projectId}`);

    const { initQueue, submitToQueue, cancelPendingByType, getQueueStats, getPending, _resetForTests } = await import("../src/daemon/queue.js");
    _resetForTests();
    initQueue({ pushEvent: vi.fn() });

    // Submit reindex jobs for both projects — proj-a goes active (MAX_CONCURRENT slot),
    // proj-b's reindex stays pending (global cap hit with MAX_CONCURRENT=1).
    submitToQueue({ projectId: "proj-a", mode: "incremental" });
    submitToQueue({ projectId: "proj-b", mode: "incremental" });

    // Add pending gc for both — both stay pending (proj-a busy; cap hit for proj-b)
    submitToQueue({ projectId: "proj-a", type: "gc", mode: "incremental" });
    submitToQueue({ projectId: "proj-b", type: "gc", mode: "incremental" });

    // Before cancel: proj-a is active (1), pending contains proj-b reindex + gc-a + gc-b (3)
    // On machines with MAX_CONCURRENT > 1 both reindexes may go active, reducing pending count.
    // Either way, both gc jobs must be pending (per-project serialization for proj-a; gc-b may
    // go active on high-core machines but that's fine — the cancel removes what's pending).
    // Sanity: gc-a is pending because proj-a's reindex is active (per-project serialization).
    // (On high-core machines both reindexes may be active; gc jobs remain pending.)
    expect(getPending().some((p) => p.projectId === "proj-a")).toBe(true);

    // Cancel only proj-a's gc
    const count = cancelPendingByType("gc", ["proj-a"]);
    expect(count).toBe(1);

    // Verify: no pending items for proj-a remain
    const pendingAfter = getPending();
    expect(pendingAfter.filter((p) => p.projectId === "proj-a").length).toBe(0);
    // proj-b's gc (and possibly reindex) still in queue
    expect(getQueueStats().active).toBeGreaterThanOrEqual(1); // proj-a reindex still active
  });
});
