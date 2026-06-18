/**
 * Plan 92 Phase 2 — RSS-threshold self-restart guard unit tests.
 *
 * Tests the three branches of `evaluateRss`:
 *   1. idle-restart   — soft threshold crossed + queue idle → doRestart called
 *   2. deferred-busy  — soft threshold crossed + active jobs → deferred, no restart
 *   3. hard-ceiling   — hard threshold crossed (regardless of idle state) → doRestart called
 *   4. below-threshold — RSS under soft threshold → silent no-op
 *
 * All dependencies (getRssBytes, getQueueStats, doRestart) are injected.
 * diagEmit is mocked so no real log file is written.
 * No real processes are spawned; no real timers fire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../src/daemon/events.js", () => ({
  diagEmit: vi.fn(),
}));

// mem-sampler is imported transitively by rss-guard; mock so no side effects.
vi.mock("../src/daemon/mem-sampler.js", () => ({
  getLatestMemSample: vi.fn(() => null),
  startMemSampler: vi.fn(),
  stopMemSampler: vi.fn(),
  sampleNow: vi.fn(() => ({
    rssBytes: 0,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    externalBytes: 0,
    sampledAt: new Date().toISOString(),
  })),
  MEM_SAMPLE_INTERVAL_MS: 60_000,
  _resetMemSamplerForTests: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

const MB = 1024 * 1024;

/** Build opts with fully controlled injections. */
function makeOpts(overrides: {
  rssBytes: number;
  active?: number;
  pending?: number;
  doRestart?: ReturnType<typeof vi.fn>;
}) {
  return {
    getRssBytes: () => overrides.rssBytes,
    getQueueStats: () => ({
      active: overrides.active ?? 0,
      pending: overrides.pending ?? 0,
      maxConcurrent: 1,
    }),
    doRestart: overrides.doRestart ?? vi.fn(),
  };
}

// ─── Module under test ────────────────────────────────────────────────────

import {
  evaluateRss,
  startRssGuard,
  stopRssGuard,
  _resetRssGuardForTests,
  MAX_RSS_SOFT_BYTES,
  MAX_RSS_HARD_BYTES,
} from "../src/daemon/rss-guard.js";
import { diagEmit } from "../src/daemon/events.js";

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetRssGuardForTests();
  // Provide stable env-derived thresholds for each test.
  // The module reads the env at import time so we test with whatever the module loaded.
  // Force env to known values between test runs requires module re-import; instead
  // we inject getRssBytes and set values relative to the exported constants.
});

afterEach(() => {
  _resetRssGuardForTests();
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("evaluateRss — idle-restart branch", () => {
  it("calls doRestart when rss > soft threshold and queue is idle", () => {
    // Place RSS just above the soft ceiling
    const rssBytes = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;
    const doRestart = vi.fn();

    const result = evaluateRss(makeOpts({ rssBytes, doRestart }));

    expect(result).toBe("idle-restart");
    expect(doRestart).toHaveBeenCalledOnce();
    expect(doRestart).toHaveBeenCalledWith("idle-restart");
  });

  it("logs the restart decision via diagEmit with rssBytes + reason", () => {
    const rssBytes = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;

    evaluateRss(makeOpts({ rssBytes }));

    expect(diagEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rss-guard.restart",
        reason: "idle-restart",
        rssBytes,
      })
    );
  });
});

describe("evaluateRss — deferred-busy branch", () => {
  it("does NOT call doRestart when soft threshold crossed but jobs are active", () => {
    const rssBytes = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;
    const doRestart = vi.fn();

    const result = evaluateRss(makeOpts({ rssBytes, active: 1, doRestart }));

    expect(result).toBe("deferred-busy");
    expect(doRestart).not.toHaveBeenCalled();
  });

  it("does NOT call doRestart when soft threshold crossed but jobs are pending", () => {
    const rssBytes = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;
    const doRestart = vi.fn();

    const result = evaluateRss(makeOpts({ rssBytes, pending: 2, doRestart }));

    expect(result).toBe("deferred-busy");
    expect(doRestart).not.toHaveBeenCalled();
  });

  it("logs a deferral via diagEmit with rssBytes + reason", () => {
    const rssBytes = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;

    evaluateRss(makeOpts({ rssBytes, active: 1 }));

    expect(diagEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rss-guard.deferred",
        reason: "deferred-busy",
        rssBytes,
      })
    );
  });

  it("restarts once the queue drains (subsequent call when idle)", () => {
    const rssBytes = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;
    const doRestart = vi.fn();

    // First tick: busy → deferred
    const r1 = evaluateRss(makeOpts({ rssBytes, active: 1, doRestart }));
    expect(r1).toBe("deferred-busy");
    expect(doRestart).not.toHaveBeenCalled();

    // State reset between the two ticks (guard should NOT be in "restart in progress")
    _resetRssGuardForTests();

    // Second tick: now idle → restarts
    const r2 = evaluateRss(makeOpts({ rssBytes, active: 0, doRestart }));
    expect(r2).toBe("idle-restart");
    expect(doRestart).toHaveBeenCalledOnce();
  });
});

describe("evaluateRss — hard-ceiling branch", () => {
  it("calls doRestart unconditionally when rss > hard threshold even with active jobs", () => {
    const rssBytes = MAX_RSS_HARD_BYTES > 0 ? MAX_RSS_HARD_BYTES + 1 : 3072 * MB + 1;
    const doRestart = vi.fn();

    const result = evaluateRss(makeOpts({ rssBytes, active: 3, doRestart }));

    expect(result).toBe("hard-ceiling-restart");
    expect(doRestart).toHaveBeenCalledOnce();
    expect(doRestart).toHaveBeenCalledWith("hard-ceiling-restart");
  });

  it("logs the hard-ceiling restart via diagEmit with rssBytes + reason", () => {
    const rssBytes = MAX_RSS_HARD_BYTES > 0 ? MAX_RSS_HARD_BYTES + 1 : 3072 * MB + 1;

    evaluateRss(makeOpts({ rssBytes, active: 2 }));

    expect(diagEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "rss-guard.restart",
        reason: "hard-ceiling-restart",
        rssBytes,
      })
    );
  });
});

describe("evaluateRss — below threshold (no-op)", () => {
  it("returns below-threshold and does not call doRestart when rss is low", () => {
    // RSS = 100 MB, well below any real threshold
    const rssBytes = 100 * MB;
    const doRestart = vi.fn();

    const result = evaluateRss(makeOpts({ rssBytes, doRestart }));

    expect(result).toBe("below-threshold");
    expect(doRestart).not.toHaveBeenCalled();
    expect(diagEmit).not.toHaveBeenCalled();
  });
});

describe("startRssGuard — timer wiring", () => {
  it("fires evaluateRss on each interval tick", () => {
    vi.useFakeTimers();

    const doRestart = vi.fn();
    // Use a high RSS so we can detect the call
    const rssAboveSoft = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;

    startRssGuard(100 /* ms */, makeOpts({ rssBytes: rssAboveSoft, doRestart }));

    // No call before the first tick
    expect(doRestart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(doRestart).toHaveBeenCalledOnce();
  });

  it("does not fire if interval is 0 (disabled)", () => {
    vi.useFakeTimers();
    const doRestart = vi.fn();

    startRssGuard(0, makeOpts({ rssBytes: MAX_RSS_HARD_BYTES + 1 || 999 * MB, doRestart }));

    vi.advanceTimersByTime(9999);
    expect(doRestart).not.toHaveBeenCalled();
  });

  it("stopRssGuard cancels the timer", () => {
    vi.useFakeTimers();
    const doRestart = vi.fn();
    const rssAboveSoft = MAX_RSS_SOFT_BYTES > 0 ? MAX_RSS_SOFT_BYTES + 1 : 1536 * MB + 1;

    startRssGuard(100, makeOpts({ rssBytes: rssAboveSoft, doRestart }));
    stopRssGuard();

    vi.advanceTimersByTime(500);
    expect(doRestart).not.toHaveBeenCalled();
  });
});
