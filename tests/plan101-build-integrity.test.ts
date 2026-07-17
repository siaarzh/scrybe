/**
 * Plan 101 Phase 1 — build-integrity self-check unit tests.
 *
 * Verifies the latch semantics locked in D5:
 *   - one miss alone does not degrade
 *   - two CONSECUTIVE misses flip isDegraded() to true
 *   - once degraded, the path reappearing does NOT un-latch it
 * and D4: the resolved path is absolute.
 *
 * `existsSync` is mocked so the daemon's own real module path is never
 * actually touched — this test controls presence/absence directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAbsolute } from "node:path";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(() => true),
  };
});

// ─── Module under test ─────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import {
  checkOnce,
  isDegraded,
  startBuildIntegrityCheck,
  _getOwnModulePathForTests,
  _resetBuildIntegrityForTests,
} from "../src/daemon/build-integrity.js";

// ─── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
  _resetBuildIntegrityForTests();
});

afterEach(() => {
  _resetBuildIntegrityForTests();
  vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe("checkOnce / isDegraded — latch semantics (D5)", () => {
  it("a single miss does not degrade", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = checkOnce();

    expect(result).toBe(false);
    expect(isDegraded()).toBe(false);
  });

  it("two consecutive misses flip isDegraded() to true", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    checkOnce();
    expect(isDegraded()).toBe(false);

    checkOnce();
    expect(isDegraded()).toBe(true);
  });

  it("a non-consecutive miss (hit in between) does not degrade", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    checkOnce(); // miss 1

    vi.mocked(existsSync).mockReturnValue(true);
    checkOnce(); // hit — resets the counter
    expect(isDegraded()).toBe(false);

    vi.mocked(existsSync).mockReturnValue(false);
    checkOnce(); // miss again, but counter was reset — this is only miss #1 again
    expect(isDegraded()).toBe(false);
  });

  it("once degraded, a subsequent check with the path restored stays degraded (latch holds)", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    checkOnce(); // miss 1
    checkOnce(); // miss 2 — latches
    expect(isDegraded()).toBe(true);

    vi.mocked(existsSync).mockReturnValue(true);
    const result = checkOnce(); // path "reappears"

    expect(result).toBe(true); // this individual check reports present
    expect(isDegraded()).toBe(true); // but the latch never clears
  });
});

describe("_getOwnModulePathForTests — D4 (never argv[1])", () => {
  it("resolves to an absolute path", () => {
    const path = _getOwnModulePathForTests();
    expect(isAbsolute(path)).toBe(true);
  });
});

describe("startBuildIntegrityCheck — timer wiring", () => {
  it("runs checkOnce on each interval tick", () => {
    vi.useFakeTimers();
    vi.mocked(existsSync).mockReturnValue(false);

    const stop = startBuildIntegrityCheck(100);

    expect(isDegraded()).toBe(false); // no tick yet

    vi.advanceTimersByTime(100); // miss 1
    expect(isDegraded()).toBe(false);

    vi.advanceTimersByTime(100); // miss 2 — latches
    expect(isDegraded()).toBe(true);

    stop();
  });

  it("stop() cancels the timer — no further checks run", () => {
    vi.useFakeTimers();
    vi.mocked(existsSync).mockReturnValue(false);

    const stop = startBuildIntegrityCheck(100);
    stop();

    vi.advanceTimersByTime(10_000);
    expect(isDegraded()).toBe(false);
  });
});
