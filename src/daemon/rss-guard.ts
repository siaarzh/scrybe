/**
 * Daemon RSS-threshold self-restart guard — Plan 92 Phase 2.
 *
 * Evaluates the current RSS on each mem-sampler tick. When RSS exceeds
 * SCRYBE_DAEMON_MAX_RSS_MB AND the daemon is idle (queue empty + no active
 * jobs), it triggers a graceful self-restart: calls the registered shutdown
 * callback which drains briefly, removes the pidfile, and (in always-on mode)
 * spawns a replacement daemon after the pidfile is gone.
 *
 * A higher hard-ceiling (SCRYBE_DAEMON_MAX_RSS_HARD_MB) overrides the idle
 * requirement — the daemon restarts unconditionally, relying on the existing
 * v0.38.0 `interrupted`-state cold-start reconcile to recover any ghost
 * running jobs.
 *
 * Configuration (all env vars):
 *   SCRYBE_DAEMON_MAX_RSS_MB       — soft ceiling, idle-gated restart  (default 1536 MB; 0 = disabled)
 *   SCRYBE_DAEMON_MAX_RSS_HARD_MB  — hard ceiling, unconditional restart (default 3072 MB; 0 = disabled)
 *
 * Every evaluation that crosses either threshold is logged via diagEmit() with
 * the current rssBytes and the reason ("idle-restart" | "deferred-busy" |
 * "hard-ceiling-restart"). Non-crossing evaluations are silent.
 *
 * The guard piggybacks on the mem-sampler interval
 * (SCRYBE_DAEMON_MEM_SAMPLE_MS, default 60 s).  Call `startRssGuard()` once
 * after `startMemSampler()`, passing:
 *   - getQueueStats  — from queue.ts
 *   - doRestart      — callback that spawns + shuts down (injected for testability)
 *
 * Injection-only pattern: no top-level side-effects, fully unit-testable.
 */

import { diagEmit } from "./events.js";
import { getLatestMemSample } from "./mem-sampler.js";

// ─── Config ────────────────────────────────────────────────────────────────

/**
 * Soft RSS ceiling in bytes, idle-gated.
 * Default 1536 MB. Set SCRYBE_DAEMON_MAX_RSS_MB=0 to disable.
 */
export const MAX_RSS_SOFT_BYTES = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_MAX_RSS_MB"] ?? "", 10);
  if (Number.isFinite(v) && v === 0) return 0; // explicitly disabled
  const mb = Number.isFinite(v) && v > 0 ? v : 1536;
  return mb * 1024 * 1024;
})();

/**
 * Hard RSS ceiling in bytes, unconditional.
 * Default 3072 MB. Set SCRYBE_DAEMON_MAX_RSS_HARD_MB=0 to disable.
 */
export const MAX_RSS_HARD_BYTES = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_MAX_RSS_HARD_MB"] ?? "", 10);
  if (Number.isFinite(v) && v === 0) return 0; // explicitly disabled
  const mb = Number.isFinite(v) && v > 0 ? v : 3072;
  return mb * 1024 * 1024;
})();

// ─── Types ─────────────────────────────────────────────────────────────────

export type RestartReason =
  | "idle-restart"         // soft threshold + idle → restart
  | "deferred-busy"        // soft threshold but jobs active → deferred
  | "hard-ceiling-restart" // hard threshold → restart regardless
  | "below-threshold";     // RSS below soft threshold → no action

export interface RssGuardOpts {
  /** Returns current active + pending job counts. From queue.ts `getQueueStats`. */
  getQueueStats: () => { active: number; pending: number };
  /**
   * Called when a restart decision is made. Implementations must:
   *   1. Call shutdown() with a short drain cap (daemonRestartDrainMs) so the
   *      over-budget process releases the pidfile promptly.
   *   2. In always-on mode only: pass spawnAfterRemovePidfile=true so the
   *      replacement is spawned strictly AFTER removePidfile() — never before.
   *   3. In on-demand mode: do NOT spawn a replacement; recovery is via the
   *      MCP shim's ensureRunning on the next tool call.
   *
   * No spawn-before-shutdown: the old pattern of calling spawnDaemonDetached()
   * first caused the replacement to bail "already running" because the pidfile
   * was still held by the exiting process.
   *
   * Injected for testability — do NOT import spawnDaemonDetached or shutdown
   * directly inside this module (keeps tests side-effect free).
   */
  doRestart: (reason: "idle-restart" | "hard-ceiling-restart") => void;
  /**
   * Returns current RSS in bytes. Defaults to reading from the latest
   * mem-sampler snapshot, then falling back to process.memoryUsage().rss.
   * Override in tests to inject deterministic values.
   */
  getRssBytes?: () => number;
}

// ─── Module state ──────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;
/** Guard against concurrent restart calls (e.g. two timer ticks overlapping). */
let _restartInProgress = false;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Arm the RSS guard on the given polling interval.
 * Call once during daemon startup, after `startMemSampler()`.
 * The timer is `.unref()`-ed so it does NOT keep the process alive alone.
 *
 * @param intervalMs — How often to evaluate RSS. Callers pass MEM_SAMPLE_INTERVAL_MS
 *                     so the guard is aligned with the sampler cadence.
 * @param opts       — Injected dependencies (queue stats, restart callback, rss getter).
 */
export function startRssGuard(
  intervalMs: number,
  opts: RssGuardOpts,
): void {
  if (_timer !== null) return; // already running
  if (intervalMs <= 0) return; // disabled (same gate as mem-sampler)
  if (MAX_RSS_SOFT_BYTES === 0 && MAX_RSS_HARD_BYTES === 0) return; // both disabled

  _timer = setInterval(() => {
    evaluateRss(opts);
  }, intervalMs);

  _timer.unref();
}

/**
 * Stop the RSS guard. Call during daemon shutdown.
 * Safe to call if the guard was never started.
 */
export function stopRssGuard(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Evaluate current RSS against the configured thresholds and act.
 * Exported for direct use in unit tests.
 *
 * Returns the decision reason so tests can assert without needing to
 * inspect side-effects.
 */
export function evaluateRss(opts: RssGuardOpts): RestartReason {
  if (_restartInProgress) return "below-threshold"; // safety: avoid double-restart

  const rssBytes = opts.getRssBytes?.() ?? _defaultGetRss();

  // ── Hard ceiling — unconditional ──────────────────────────────────────
  if (MAX_RSS_HARD_BYTES > 0 && rssBytes > MAX_RSS_HARD_BYTES) {
    diagEmit({
      event: "rss-guard.restart",
      level: "warn",
      reason: "hard-ceiling-restart",
      rssBytes,
      thresholdBytes: MAX_RSS_HARD_BYTES,
      softThresholdBytes: MAX_RSS_SOFT_BYTES,
    });
    _restartInProgress = true;
    opts.doRestart("hard-ceiling-restart");
    return "hard-ceiling-restart";
  }

  // ── Soft ceiling — idle-gated ─────────────────────────────────────────
  if (MAX_RSS_SOFT_BYTES > 0 && rssBytes > MAX_RSS_SOFT_BYTES) {
    const stats = opts.getQueueStats();
    const isIdle = stats.active === 0 && stats.pending === 0;

    if (isIdle) {
      diagEmit({
        event: "rss-guard.restart",
        level: "warn",
        reason: "idle-restart",
        rssBytes,
        thresholdBytes: MAX_RSS_SOFT_BYTES,
        hardThresholdBytes: MAX_RSS_HARD_BYTES,
        queueActive: stats.active,
        queuePending: stats.pending,
      });
      _restartInProgress = true;
      opts.doRestart("idle-restart");
      return "idle-restart";
    }

    // Daemon is busy — log a deferral and wait for next tick
    diagEmit({
      event: "rss-guard.deferred",
      level: "info",
      reason: "deferred-busy",
      rssBytes,
      thresholdBytes: MAX_RSS_SOFT_BYTES,
      hardThresholdBytes: MAX_RSS_HARD_BYTES,
      queueActive: stats.active,
      queuePending: stats.pending,
    });
    return "deferred-busy";
  }

  return "below-threshold";
}

/** For tests — reset module state between test cases. */
export function _resetRssGuardForTests(): void {
  stopRssGuard();
  _restartInProgress = false;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function _defaultGetRss(): number {
  // Prefer the cached sampler value (no extra syscall); fall back to live read.
  const sample = getLatestMemSample();
  if (sample !== null) return sample.rssBytes;
  return process.memoryUsage().rss;
}
