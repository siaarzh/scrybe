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
 *
 * Public API surface consumed by Plan 109 Phase 2 (intra-span RSS peak):
 *   - `createSpanRssTracker(startRssBytes)` — per-span high-water-mark tracker.
 *     Each call site that emits an `activity-span` record owns exactly one
 *     tracker instance for the lifetime of its own span. There is no shared
 *     module-level running max, so overlapping spans (measured: the majority
 *     of spans overlap another in production) each track their own interior
 *     peak independently and cannot book one another's high-water mark.
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

/**
 * A per-span RSS high-water-mark tracker (Plan 109 Phase 2).
 *
 * Two-point (start, end) sampling cannot see a spike that rises and subsides
 * inside a span. `sample()` is meant to be called repeatedly during the
 * span's lifetime (e.g. from an existing poll timer, or a dedicated
 * `.unref()`-ed interval bracketing the span) so the tracker actually
 * observes the interior, not just its endpoints.
 *
 * Each tracker is its own closure over a private `peak` variable — there is
 * no shared/global state, so instantiating one per span is what keeps
 * concurrent, overlapping spans from clobbering each other's peak.
 */
export interface SpanRssTracker {
  /** Take a fresh full sample now and fold it into this span's running peak. */
  sample(): MemSample;
  /**
   * Cheap variant of `sample()` for high-frequency polling: reads RSS only,
   * via `process.memoryUsage.rss()` (~8 µs), and folds it into the peak.
   *
   * `sample()` calls the full `process.memoryUsage()` — which walks V8 heap
   * statistics — and allocates a `new Date().toISOString()` for the timestamp.
   * That is fine a handful of times per span, but not at tens of hertz per
   * concurrent in-flight call. Use this when only the peak matters and the
   * returned MemSample fields would be thrown away.
   *
   * Returns the RSS just read, in bytes.
   */
  sampleRss(): number;
  /** Highest rssBytes observed by this tracker so far (includes the start value). */
  peakRssBytes(): number;
}

/**
 * Create a new high-water-mark tracker for one span, seeded with the RSS
 * observed at span start. Call `sample()` periodically during the span and
 * read `peakRssBytes()` when the span ends.
 */
export function createSpanRssTracker(startRssBytes: number): SpanRssTracker {
  let peak = startRssBytes;
  return {
    sample(): MemSample {
      const snap = sampleNow();
      if (snap.rssBytes > peak) peak = snap.rssBytes;
      return snap;
    },
    sampleRss(): number {
      // Same private `peak` closure as sample() — per-span isolation is
      // unchanged; this only skips the heap stats and the ISO timestamp.
      const rss = process.memoryUsage.rss();
      if (rss > peak) peak = rss;
      return rss;
    },
    peakRssBytes(): number {
      return peak;
    },
  };
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
