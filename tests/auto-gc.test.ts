/**
 * Unit tests for auto-gc engine (src/daemon/auto-gc.ts) and
 * cancelPendingByType (src/daemon/queue.ts).
 *
 * Tests run in isolation (no sidecar needed — no real embedding).
 * Uses vi.fake timers for idle timer testing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../src/registry.js", () => ({
  listProjects: vi.fn(() => []),
  getProject: vi.fn(),
}));

vi.mock("../src/vector-store.js", () => ({
  listChunkIds: vi.fn(),
}));

vi.mock("../src/branch-state.js", () => ({
  getAllChunkIdsForSource: vi.fn(),
}));

vi.mock("../src/jobs-store.js", () => ({
  getLastGcTime: vi.fn(() => null),
  insertJob: vi.fn(),
  updateJobStatus: vi.fn(),
  cancelPendingGcJobs: vi.fn(),
}));

vi.mock("../src/daemon/queue.js", () => ({
  submitToQueue: vi.fn(() => ({ jobId: "auto-gc-123", status: "queued", duplicateOfPending: false })),
  onQueueJobEvent: vi.fn(),
  cancelPendingByType: vi.fn(() => 0),
}));

vi.mock("../src/jobs.js", () => ({
  submitJob: vi.fn(),
  submitSourceJob: vi.fn(),
  getJobStatus: vi.fn(),
  cancelJob: vi.fn(),
  cancelAllJobs: vi.fn(),
}));

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Clear env vars that affect auto-gc behavior
  delete process.env["SCRYBE_AUTO_GC"];
  delete process.env["SCRYBE_AUTO_GC_IDLE_MS"];
  delete process.env["SCRYBE_AUTO_GC_RATIO"];
  delete process.env["SCRYBE_AUTO_GC_RATIO_DEBOUNCE_MS"];
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

// ─── IdleTracker tests ────────────────────────────────────────────────────

describe("IdleTracker", () => {
  it("fires onIdle callback after window elapses", async () => {
    const { IdleTracker } = await import("../src/daemon/auto-gc.js");
    const onIdle = vi.fn();
    const tracker = new IdleTracker(1000, onIdle);

    tracker.reset("proj-a");
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1001);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledWith("proj-a");
  });

  it("reset correctly debounces — does not fire if reset within window", async () => {
    const { IdleTracker } = await import("../src/daemon/auto-gc.js");
    const onIdle = vi.fn();
    const tracker = new IdleTracker(1000, onIdle);

    tracker.reset("proj-b");
    vi.advanceTimersByTime(500);
    tracker.reset("proj-b"); // reset before window elapses
    vi.advanceTimersByTime(500);
    // Window since last reset hasn't elapsed (only 500ms)
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(501);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("cancel prevents idle from firing", async () => {
    const { IdleTracker } = await import("../src/daemon/auto-gc.js");
    const onIdle = vi.fn();
    const tracker = new IdleTracker(1000, onIdle);

    tracker.reset("proj-c");
    tracker.cancel("proj-c");
    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("hasTimer returns true while timer is active", async () => {
    const { IdleTracker } = await import("../src/daemon/auto-gc.js");
    const tracker = new IdleTracker(1000, vi.fn());
    expect(tracker.hasTimer("proj-x")).toBe(false);
    tracker.reset("proj-x");
    expect(tracker.hasTimer("proj-x")).toBe(true);
    tracker.cancel("proj-x");
    expect(tracker.hasTimer("proj-x")).toBe(false);
  });

  it("cancelAll removes all timers", async () => {
    const { IdleTracker } = await import("../src/daemon/auto-gc.js");
    const onIdle = vi.fn();
    const tracker = new IdleTracker(1000, onIdle);

    tracker.reset("p1");
    tracker.reset("p2");
    tracker.cancelAll();

    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("fires once per idle window (does not repeat)", async () => {
    const { IdleTracker } = await import("../src/daemon/auto-gc.js");
    const onIdle = vi.fn();
    const tracker = new IdleTracker(1000, onIdle);

    tracker.reset("proj-d");
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledOnce(); // timer is single-shot via setTimeout
  });
});

// ─── evaluateRatioTrigger tests ───────────────────────────────────────────

describe("evaluateRatioTrigger", () => {
  it("returns without enqueueing when orphan ratio is below threshold", async () => {
    const { getProject } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const { getAllChunkIdsForSource } = await import("../src/branch-state.js");
    const { submitToQueue } = await import("../src/daemon/queue.js");

    vi.mocked(getProject).mockReturnValue({
      id: "proj-low",
      description: "test",
      sources: [{ source_id: "primary", source_config: { type: "code", root_path: "/tmp", languages: ["ts"] }, table_name: "proj_low_primary" }],
    } as any);
    vi.mocked(listChunkIds).mockResolvedValue(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]); // 10 total
    vi.mocked(getAllChunkIdsForSource).mockReturnValue(new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i"])); // 9 tagged = 10% orphan < 15%

    const { evaluateRatioTrigger } = await import("../src/daemon/auto-gc.js");
    await evaluateRatioTrigger("proj-low");

    expect(submitToQueue).not.toHaveBeenCalled();
  });

  it("enqueues gc when orphan ratio exceeds threshold and debounce has elapsed", async () => {
    const { getProject } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const { getAllChunkIdsForSource } = await import("../src/branch-state.js");
    const { getLastGcTime } = await import("../src/jobs-store.js");
    const { submitToQueue } = await import("../src/daemon/queue.js");

    vi.mocked(getProject).mockReturnValue({
      id: "proj-high",
      description: "test",
      sources: [{ source_id: "primary", source_config: { type: "code", root_path: "/tmp", languages: ["ts"] }, table_name: "proj_high_primary" }],
    } as any);
    vi.mocked(listChunkIds).mockResolvedValue(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]); // 10 total
    vi.mocked(getAllChunkIdsForSource).mockReturnValue(new Set(["a", "b", "c", "d", "e", "f", "g", "h"])); // 8 tagged = 20% orphan > 15%
    vi.mocked(getLastGcTime).mockReturnValue(null); // no previous gc

    const { evaluateRatioTrigger } = await import("../src/daemon/auto-gc.js");
    await evaluateRatioTrigger("proj-high");

    expect(submitToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-high", type: "gc" })
    );
  });

  it("does not enqueue when debounce is still active", async () => {
    const { getProject } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const { getAllChunkIdsForSource } = await import("../src/branch-state.js");
    const { getLastGcTime } = await import("../src/jobs-store.js");
    const { submitToQueue } = await import("../src/daemon/queue.js");

    vi.mocked(getProject).mockReturnValue({
      id: "proj-debounce",
      description: "test",
      sources: [{ source_id: "primary", source_config: { type: "code", root_path: "/tmp", languages: ["ts"] }, table_name: "proj_debounce_primary" }],
    } as any);
    vi.mocked(listChunkIds).mockResolvedValue(new Array(10).fill(0).map((_, i) => `id${i}`));
    vi.mocked(getAllChunkIdsForSource).mockReturnValue(new Set(new Array(8).fill(0).map((_, i) => `id${i}`))); // 20% orphan
    vi.mocked(getLastGcTime).mockReturnValue(Date.now() - 5_000); // 5s ago, debounce = 30 min

    const { evaluateRatioTrigger } = await import("../src/daemon/auto-gc.js");
    await evaluateRatioTrigger("proj-debounce");

    expect(submitToQueue).not.toHaveBeenCalled();
  });

  it("ignores debounce when last gc failed (failed-debounce-reset)", async () => {
    const { getProject } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const { getAllChunkIdsForSource } = await import("../src/branch-state.js");
    const { getLastGcTime } = await import("../src/jobs-store.js");
    const { submitToQueue } = await import("../src/daemon/queue.js");

    vi.mocked(getProject).mockReturnValue({
      id: "proj-failed-gc",
      description: "test",
      sources: [{ source_id: "primary", source_config: { type: "code", root_path: "/tmp", languages: ["ts"] }, table_name: "proj_failed_gc_primary" }],
    } as any);
    vi.mocked(listChunkIds).mockResolvedValue(new Array(10).fill(0).map((_, i) => `id${i}`));
    vi.mocked(getAllChunkIdsForSource).mockReturnValue(new Set(new Array(8).fill(0).map((_, i) => `id${i}`))); // 20% orphan
    // getLastGcTime with ignoreDebounceForFailed returns null (last gc was failed → debounce elapsed)
    vi.mocked(getLastGcTime).mockReturnValue(null);

    const { evaluateRatioTrigger } = await import("../src/daemon/auto-gc.js");
    await evaluateRatioTrigger("proj-failed-gc");

    expect(submitToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-failed-gc", type: "gc" })
    );
  });

  it("skips non-code sources", async () => {
    const { getProject } = await import("../src/registry.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const { submitToQueue } = await import("../src/daemon/queue.js");

    vi.mocked(getProject).mockReturnValue({
      id: "proj-ticket-only",
      description: "test",
      sources: [{ source_id: "gitlab-issues", source_config: { type: "ticket", provider: "gitlab", base_url: "https://x.com", project_id: "1", token: "t" }, table_name: "t1" }],
    } as any);

    const { evaluateRatioTrigger } = await import("../src/daemon/auto-gc.js");
    await evaluateRatioTrigger("proj-ticket-only");

    expect(listChunkIds).not.toHaveBeenCalled();
    expect(submitToQueue).not.toHaveBeenCalled();
  });

  it("does nothing when SCRYBE_AUTO_GC=0", async () => {
    process.env["SCRYBE_AUTO_GC"] = "0";
    const { getProject } = await import("../src/registry.js");
    const { submitToQueue } = await import("../src/daemon/queue.js");

    vi.mocked(getProject).mockReturnValue({
      id: "proj-disabled",
      description: "test",
      sources: [{ source_id: "primary", source_config: { type: "code", root_path: "/tmp", languages: ["ts"] }, table_name: "p" }],
    } as any);

    const { evaluateRatioTrigger } = await import("../src/daemon/auto-gc.js");
    await evaluateRatioTrigger("proj-disabled");

    expect(submitToQueue).not.toHaveBeenCalled();
  });
});

// Note: cancelPendingByType integration tests live in tests/cancel-pending-gc.test.ts
// to avoid conflict with the vi.mock("../src/daemon/queue.js") mock in this file.
