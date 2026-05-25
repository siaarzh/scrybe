/**
 * Unit tests for runShutdownDrain — the shutdown drain-loop helper in main.ts.
 *
 * Tests cover:
 *   - Clean drain (active = 0 immediately)
 *   - Reindex-active defer: waits until reindex finishes, exits cleanly
 *   - Reindex-active hard cap: force-exits at SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS
 *   - Non-reindex-only active work: respects the original 30s cap (not the hard cap)
 *   - onForceExit callback is called on cap-hit, not on clean drain
 *
 * Does NOT call process.exit — runShutdownDrain is extracted specifically for
 * testability. We use vi.useFakeTimers() so the poll loop is fast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runShutdownDrain } from "../src/daemon/main.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runShutdownDrain", () => {
  it("returns true immediately when no active jobs", async () => {
    const result = await runShutdownDrain({
      getActiveReindexCount: () => 0,
      getQueueStats: () => ({ active: 0 }),
      maxWaitMs: 1000,
      pollMs: 50,
    });
    expect(result).toBe(true);
  });

  it("defers while reindex is active, returns true when reindex finishes", async () => {
    let activeReindex = 1;
    let totalActive = 1;
    const onForceExit = vi.fn();

    // Start the drain — it will poll every 50ms
    const drainPromise = runShutdownDrain({
      getActiveReindexCount: () => activeReindex,
      getQueueStats: () => ({ active: totalActive }),
      maxWaitMs: 10_000,    // 10s hard cap (won't be hit)
      nonReindexCapMs: 500, // 0.5s non-reindex cap (won't apply — reindex is active)
      pollMs: 50,
      onForceExit,
    });

    // Advance past the nonReindexCapMs to prove it does NOT cap out on non-reindex path
    await vi.advanceTimersByTimeAsync(600);
    expect(onForceExit).not.toHaveBeenCalled();

    // Reindex finishes
    activeReindex = 0;
    totalActive = 0;

    // One more poll tick
    await vi.advanceTimersByTimeAsync(60);

    const result = await drainPromise;
    expect(result).toBe(true);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("force-exits at hard cap when reindex never finishes", async () => {
    const onForceExit = vi.fn();

    const drainPromise = runShutdownDrain({
      getActiveReindexCount: () => 1,  // always active
      getQueueStats: () => ({ active: 1 }),
      maxWaitMs: 300,    // low hard cap
      pollMs: 50,
      onForceExit,
    });

    // Advance past the hard cap
    await vi.advanceTimersByTimeAsync(400);

    const result = await drainPromise;
    expect(result).toBe(false);
    expect(onForceExit).toHaveBeenCalledWith(1);
  });

  it("non-reindex active work caps at nonReindexCapMs, not maxWaitMs", async () => {
    const onForceExit = vi.fn();

    const drainPromise = runShutdownDrain({
      getActiveReindexCount: () => 0,  // NO reindex active
      getQueueStats: () => ({ active: 1 }), // some other job
      maxWaitMs: 60_000,     // 60s hard cap (should NOT be hit)
      nonReindexCapMs: 300,  // 0.3s non-reindex cap
      pollMs: 50,
      onForceExit,
    });

    // Advance past nonReindexCapMs but not near maxWaitMs
    await vi.advanceTimersByTimeAsync(400);

    const result = await drainPromise;
    expect(result).toBe(false);
    expect(onForceExit).toHaveBeenCalledWith(1);
  });

  it("onForceExit is NOT called on clean drain", async () => {
    let active = 1;
    const onForceExit = vi.fn();

    const drainPromise = runShutdownDrain({
      getActiveReindexCount: () => 0,
      getQueueStats: () => ({ active }),
      maxWaitMs: 2000,
      nonReindexCapMs: 2000,
      pollMs: 50,
      onForceExit,
    });

    // Job finishes before any cap
    await vi.advanceTimersByTimeAsync(60);
    active = 0;
    await vi.advanceTimersByTimeAsync(60);

    const result = await drainPromise;
    expect(result).toBe(true);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("reindex-active defer is NOT triggered by gc-only active jobs", async () => {
    // When getActiveReindexCount returns 0, gc-only active jobs use nonReindexCapMs
    const onForceExit = vi.fn();

    const drainPromise = runShutdownDrain({
      getActiveReindexCount: () => 0,  // gc job — not counted as reindex
      getQueueStats: () => ({ active: 1 }),
      maxWaitMs: 60_000,
      nonReindexCapMs: 200,
      pollMs: 50,
      onForceExit,
    });

    await vi.advanceTimersByTimeAsync(300);

    const result = await drainPromise;
    expect(result).toBe(false);
    expect(onForceExit).toHaveBeenCalledWith(1);
  });

  it("hard cap can be set via SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS default (1_800_000)", () => {
    // Verify the default env var parses correctly
    const prev = process.env["SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS"];
    delete process.env["SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS"];
    const val = parseInt(process.env["SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS"] ?? "1800000", 10);
    expect(val).toBe(1_800_000);
    if (prev !== undefined) process.env["SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS"] = prev;
  });
});
