/**
 * Daemon memory sampler — Plan 92 Phase 1.
 *
 * Periodically samples `process.memoryUsage()` and emits a `mem-sample` record
 * via `diagEmit()` to `daemon-log.jsonl`. The timer is `.unref()`-ed so it
 * does NOT keep the process alive after all other work is done.
 *
 * Sample interval: SCRYBE_DAEMON_MEM_SAMPLE_MS (default 60000 ms)
 *   Set to 0 to disable sampling entirely (useful in tests).
 *
 * Public API surface consumed by Phase 2 (self-restart guard):
 *   - `getLatestMemSample()` — returns the most recent RSS + heap snapshot
 *   - `startMemSampler(diagEmit)` — arms the timer; call once on daemon startup
 *   - `stopMemSampler()` — clears the timer; call on daemon shutdown
 */

import { diagEmit } from "./events.js";

// ─── Config ────────────────────────────────────────────────────────────────

/**
 * Sample interval in ms. Override via SCRYBE_DAEMON_MEM_SAMPLE_MS.
 * Default 60_000 (1 min). Set to 0 to disable.
 */
export const MEM_SAMPLE_INTERVAL_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
})();

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MemSample {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  sampledAt: string; // ISO timestamp
}

// ─── Module state ──────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;
let _latest: MemSample | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns the most recent RSS+heap snapshot, or null if no sample has been taken yet.
 * Used by the Phase 2 self-restart guard to check RSS without touching the log.
 */
export function getLatestMemSample(): MemSample | null {
  return _latest;
}

/**
 * Take an immediate snapshot (without waiting for the timer) and update `_latest`.
 * Exported so callers (e.g. activity-span wrappers) can capture a point-in-time RSS.
 */
export function sampleNow(): MemSample {
  const mem = process.memoryUsage();
  const snap: MemSample = {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    sampledAt: new Date().toISOString(),
  };
  _latest = snap;
  return snap;
}

/**
 * Arm the periodic RSS+heap sampler. Call once during daemon startup.
 * The timer is `.unref()`-ed so it does not keep the process alive alone.
 * No-op if `MEM_SAMPLE_INTERVAL_MS === 0` or if already started.
 */
export function startMemSampler(): void {
  if (_timer !== null) return; // already running
  if (MEM_SAMPLE_INTERVAL_MS === 0) return; // disabled

  // Emit an initial sample immediately so the log has a baseline on startup.
  emitSample();

  _timer = setInterval(() => {
    emitSample();
  }, MEM_SAMPLE_INTERVAL_MS);

  // Must not keep the event loop alive — daemon exits when all refs are released.
  _timer.unref();
}

/**
 * Stop the periodic sampler. Call during daemon shutdown.
 * Safe to call if the sampler was never started.
 */
export function stopMemSampler(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** For tests only — reset module state between test cases. */
export function _resetMemSamplerForTests(): void {
  stopMemSampler();
  _latest = null;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function emitSample(): void {
  const snap = sampleNow();
  diagEmit({
    event: "mem-sample",
    level: "info",
    rssBytes: snap.rssBytes,
    heapUsedBytes: snap.heapUsedBytes,
    heapTotalBytes: snap.heapTotalBytes,
    externalBytes: snap.externalBytes,
  });
}
