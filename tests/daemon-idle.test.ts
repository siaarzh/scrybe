/**
 * Phase 4 — Idle state machine.
 * Pure unit tests; uses fake timers to avoid waiting 60 s.
 * Relies on isolate.ts (setupFiles) for per-test module reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Short HOT window so fake-timer advances stay small
process.env["SCRYBE_DAEMON_HOT_MS"] = "1000";
process.env["SCRYBE_DAEMON_COLD_MULTIPLIER"] = "3";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  try {
    const { _resetForTests } = await import("../src/daemon/idle-state.js");
    _resetForTests();
  } catch { /* ignore */ }
  vi.useRealTimers();
});

describe("idle state — initial state", () => {
  it("starts in cold state", async () => {
    const { getState } = await import("../src/daemon/idle-state.js");
    expect(getState()).toBe("cold");
  });

  it("getDebounceMs returns base × multiplier in cold state", async () => {
    const { getDebounceMs } = await import("../src/daemon/idle-state.js");
    expect(getDebounceMs(100)).toBe(300); // 100 × COLD_MULTIPLIER(3)
  });
});

describe("idle state — touchActive()", () => {
  it("transitions to hot on first touch", async () => {
    const { touchActive, getState } = await import("../src/daemon/idle-state.js");
    touchActive();
    expect(getState()).toBe("hot");
  });

  it("getDebounceMs returns base (no multiplier) in hot state", async () => {
    const { touchActive, getDebounceMs } = await import("../src/daemon/idle-state.js");
    touchActive();
    expect(getDebounceMs(100)).toBe(100);
  });

  it("returns to cold after HOT_MS elapses", async () => {
    const { touchActive, getState } = await import("../src/daemon/idle-state.js");
    touchActive();
    expect(getState()).toBe("hot");

    vi.advanceTimersByTime(1001); // > HOT_MS=1000
    expect(getState()).toBe("cold");
  });

  it("resets the HOT timer on repeated touches", async () => {
    const { touchActive, getState } = await import("../src/daemon/idle-state.js");
    touchActive();
    vi.advanceTimersByTime(800);  // not yet expired
    touchActive();                // reset timer
    vi.advanceTimersByTime(800);  // 1600 ms total, but timer was reset at 800
    expect(getState()).toBe("hot");

    vi.advanceTimersByTime(300);  // 800+1100 = now past the reset timer
    expect(getState()).toBe("cold");
  });
});

describe("idle state — onStateChange()", () => {
  it("fires callback on cold → hot transition", async () => {
    const { touchActive, onStateChange } = await import("../src/daemon/idle-state.js");
    const changes: string[] = [];
    onStateChange((s) => changes.push(s));

    touchActive();
    expect(changes).toEqual(["hot"]);
  });

  it("fires callback on hot → cold transition", async () => {
    const { touchActive, onStateChange } = await import("../src/daemon/idle-state.js");
    const changes: string[] = [];
    onStateChange((s) => changes.push(s));

    touchActive();
    vi.advanceTimersByTime(1001);
    expect(changes).toEqual(["hot", "cold"]);
  });

  it("does not fire callback for repeated touches in hot state", async () => {
    const { touchActive, onStateChange } = await import("../src/daemon/idle-state.js");
    const changes: string[] = [];
    onStateChange((s) => changes.push(s));

    touchActive();
    touchActive(); // already hot — no new callback
    touchActive();
    expect(changes).toEqual(["hot"]); // only one transition
  });
});
