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
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockImplementation((projectId) => `job-${projectId}`);
    vi.mocked(getJobStatus).mockImplementation((id) => ({
      job_id: id, project_id: id.replace("job-", ""), mode: "incremental" as const,
      status: "running" as const, tasks: [], started_at: Date.now(), finished_at: null, error: null,
    }));

    const { initQueue, enqueue, cancelPendingByType, getQueueStats } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    // Two projects: proj-a (active) and proj-b (active)
    await enqueue({ projectId: "proj-a", mode: "incremental" });
    await enqueue({ projectId: "proj-b", mode: "incremental" });

    // Add pending gc for both
    const gcAP = enqueue({ projectId: "proj-a", type: "gc", mode: "incremental" });
    const gcBP = enqueue({ projectId: "proj-b", type: "gc", mode: "incremental" });
    expect(getQueueStats().pending).toBe(2);

    // Cancel only proj-a's gc
    const count = cancelPendingByType("gc", ["proj-a"]);
    expect(count).toBe(1);
    expect(getQueueStats().pending).toBe(1); // proj-b's gc still pending

    await expect(gcAP).rejects.toThrow("Cancelled by manual gc");
    void gcBP.catch(() => {}); // proj-b's gc still pending
  });
});
