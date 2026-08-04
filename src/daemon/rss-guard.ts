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
 *
 * ── Restart-watchdog: escalate a hung restart to a forced exit ──────────────
 * `doRestart` is fire-and-forget (`void` return) — the actual restart is an
 * async `shutdown()` in main.ts that this module cannot await. Historically
 * the `_restartInProgress` latch it sets was never cleared outside of tests:
 * if `shutdown()` hung or its promise rejected, the process stayed alive
 * forever with the guard permanently disarmed — and `evaluateRss` returned
 * "below-threshold" **silently** on every later tick (no diagEmit at all),
 * so RSS growth would then run completely unobserved.
 *
 * Re-arming the latch does NOT fix that, and must never be relied on as the
 * recovery mechanism. By the time a restart has hung, `shutdown()` has already
 * (synchronously, before its first `await`) run `stopRssGuard()`, which clears
 * this module's interval — so nothing ever calls `evaluateRss()` again no
 * matter what the latch says. `shutdown()` is also re-entrancy-guarded
 * (`shutdownCalled`), so a second `doRestart` would be an immediate no-op.
 * A re-armed guard on a half-torn-down daemon (sampler, lifecycle and
 * build-integrity checks all stopped) is a daemon that is alive and
 * unobserved: exactly the failure this module exists to prevent.
 *
 * So the watchdog ESCALATES instead: if the process is still alive
 * `RESTART_WATCHDOG_MS` after a restart was ordered, it calls the injected
 * `escalate` hook, whose production implementation releases the pidfile and
 * data-dir ownership and terminates the process with a non-zero exit. That
 * gets us what the guard wanted in the first place — this over-budget process
 * gone, and a fresh daemon brought up by the normal recovery paths
 * (`ensureRunning()` on the next MCP call, always-on respawn, or systemd
 * `Restart=on-failure` on the installed unit). The latch reset and the
 * failure diagEmit are kept IN ADDITION to the escalation, never instead of
 * it, so an escalate hook that is a no-op (tests) still leaves observable
 * state rather than a silent wedge.
 *
 * A genuinely successful restart calls `process.exit()` inside `shutdown()`,
 * so the watchdog can only ever fire when the restart did NOT happen — see
 * RESTART_WATCHDOG_MS for how the window is sized to guarantee that. While
 * the latch is armed, every tick still emits a diagEmit record instead of
 * returning silently.
 *
 * To bound thrash on the residual path where `escalate` does not actually
 * terminate the process, the watchdog window doubles on each consecutive
 * failure (capped at `RESTART_WATCHDOG_MAX_MS`).
 */

import { config } from "../config.js";
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

/**
 * Upper bound on how long a HEALTHY rss-guard restart can take, in ms.
 *
 * `doRestart` calls main.ts `shutdown()` with `drainCapMs =
 * config.daemonRestartDrainMs` (2 s default). Note it does NOT use
 * `config.daemonShutdownMaxWaitMs` (30 min) — that cap is for an operator
 * SIGTERM with a real reindex in flight and never applies on this path. But
 * `runShutdownDrain` also honours its own `nonReindexCapMs` (30 s default,
 * main.ts `runShutdownDrain`), which dominates the 2 s cap when a non-reindex
 * job happens to be active during a hard-ceiling restart. Add slack for the
 * rest of teardown (watcher/git-watcher/http-server stop, DB close, respawn).
 *
 * Kept in sync by construction where possible: the drain cap is read from
 * config, the 30 s term mirrors main.ts's `nonReindexCapMs` default.
 */
const HEALTHY_RESTART_BUDGET_MS =
  Math.max(config.daemonRestartDrainMs, 30_000) + 15_000;

/**
 * Watchdog window (ms): how long to wait, after ordering a restart, before
 * concluding it did not complete and escalating to a forced exit. Doubles per
 * consecutive failure up to RESTART_WATCHDOG_MAX_MS.
 *
 * Default 120 s, and floored at 2× HEALTHY_RESTART_BUDGET_MS however it is
 * configured — so the window always clearly outlasts a healthy shutdown and
 * a successful restart's `process.exit()` always wins the race. A too-small
 * operator value cannot make the escalation fire on a slow-but-working
 * shutdown; it can only ever make it slower to give up.
 */
export const RESTART_WATCHDOG_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_RSS_GUARD_WATCHDOG_MS"] ?? "", 10);
  const configured = Number.isFinite(v) && v > 0 ? v : 120_000;
  return Math.max(configured, HEALTHY_RESTART_BUDGET_MS * 2);
})();

/**
 * Ceiling on the doubling backoff described above. Default 30 min. Never
 * allowed below RESTART_WATCHDOG_MS — the backoff cap must not shrink the base
 * window back under a healthy shutdown's duration.
 */
export const RESTART_WATCHDOG_MAX_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_RSS_GUARD_WATCHDOG_MAX_MS"] ?? "", 10);
  const configured = Number.isFinite(v) && v > 0 ? v : 30 * 60_000;
  return Math.max(configured, RESTART_WATCHDOG_MS);
})();

// ─── Types ─────────────────────────────────────────────────────────────────

export type RestartReason =
  | "idle-restart"         // soft threshold + idle → restart
  | "deferred-busy"        // soft threshold but jobs active → deferred
  | "hard-ceiling-restart" // hard threshold → restart regardless
  | "restart-pending"      // a restart was already ordered; watchdog still running
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
   * Terminal escalation: called when `RESTART_WATCHDOG_MS` elapses and the
   * process ordered by `doRestart` is STILL alive — i.e. `shutdown()` hung or
   * rejected. Implementations must actually end the process (after best-effort
   * pidfile / ownership release), because at that point the guard, mem-sampler,
   * lifecycle manager and build-integrity check have all been stopped by
   * `shutdown()`'s synchronous prefix and the daemon can no longer observe or
   * contain its own memory. Leaving the process alive here is never correct.
   *
   * Injected so tests can assert the escalation without terminating the test
   * runner. Required (not optional) on purpose: there is no safe default that
   * leaves the process alive, and a missing hook must be a compile error rather
   * than a silently unguarded daemon.
   */
  escalate: (info: {
    reason: "idle-restart" | "hard-ceiling-restart";
    windowMs: number;
    consecutiveFailures: number;
  }) => void;
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
/** Watchdog timer that clears `_restartInProgress` if the restart never completes. */
let _restartWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive restarts that the watchdog concluded never completed. Drives backoff. */
let _consecutiveRestartFailures = 0;

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
  // Clear the restart watchdog too (repo convention: timers are cleared on
  // every stop path) — but ONLY when no restart is in flight.
  //
  // The one caller that stops the guard mid-restart is `shutdown()` itself:
  // `doRestart` → `shutdown()` → `stopRssGuard()`, synchronously, before the
  // drain that may hang. Clearing the watchdog there would delete the only
  // thing that can still rescue a hung shutdown, which is precisely the bug
  // this watchdog exists for. So while `_restartInProgress` is latched the
  // watchdog deliberately outlives the guard; every other stop path (SIGTERM
  // shutdown, test reset) clears it.
  if (!_restartInProgress && _restartWatchdogTimer !== null) {
    clearTimeout(_restartWatchdogTimer);
    _restartWatchdogTimer = null;
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
  if (_restartInProgress) {
    // A restart was already ordered and the watchdog has not yet concluded it
    // failed. Do NOT silently no-op here (that was the bug this guards
    // against) — emit a record so an operator can see the guard is still
    // waiting on a prior restart rather than assuming it went silent.
    diagEmit({
      event: "rss-guard.restart-pending",
      level: "info",
      reason: "restart-pending",
      consecutiveFailures: _consecutiveRestartFailures,
    });
    return "restart-pending";
  }

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
    _orderRestart("hard-ceiling-restart", opts);
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
      _orderRestart("idle-restart", opts);
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
  _consecutiveRestartFailures = 0;
  if (_restartWatchdogTimer !== null) {
    clearTimeout(_restartWatchdogTimer);
    _restartWatchdogTimer = null;
  }
}

// ─── Internal ──────────────────────────────────────────────────────────────

/**
 * Order a restart: set the latch, call the injected `doRestart`, and arm a
 * watchdog that escalates to a forced exit (via the injected `escalate` hook)
 * if the process is still alive once the window elapses — see the module doc
 * comment above.
 */
function _orderRestart(
  reason: "idle-restart" | "hard-ceiling-restart",
  opts: RssGuardOpts,
): void {
  _restartInProgress = true;

  const windowMs = Math.min(
    RESTART_WATCHDOG_MS * 2 ** _consecutiveRestartFailures,
    RESTART_WATCHDOG_MAX_MS,
  );

  if (_restartWatchdogTimer !== null) clearTimeout(_restartWatchdogTimer);
  _restartWatchdogTimer = setTimeout(() => {
    _restartWatchdogTimer = null;
    // If _restartInProgress is still true here, the process did not exit —
    // the restart never completed (shutdown() hung, rejected, or the
    // respawn/exit path silently swallowed an error upstream in main.ts).
    if (!_restartInProgress) return;

    // Reset the latch and record the failure FIRST, so the state is observable
    // even if `escalate` is a no-op (tests) or throws. This is in addition to
    // the escalation below, never a substitute for it: on a real daemon the
    // guard's interval is already gone by now, so a re-armed latch alone would
    // leave the process alive and unobserved.
    _restartInProgress = false;
    _consecutiveRestartFailures += 1;
    diagEmit({
      event: "rss-guard.restart-watchdog-timeout",
      level: "error",
      reason,
      windowMs,
      consecutiveFailures: _consecutiveRestartFailures,
      escalating: true,
    });

    // Terminal: end this over-budget, half-torn-down process so the pidfile is
    // released and a fresh daemon can come up. Never left as "alive but
    // unguarded".
    opts.escalate({
      reason,
      windowMs,
      consecutiveFailures: _consecutiveRestartFailures,
    });
  }, windowMs);
  _restartWatchdogTimer.unref();

  opts.doRestart(reason);
}

function _defaultGetRss(): number {
  // Prefer the cached sampler value (no extra syscall); fall back to live read.
  const sample = getLatestMemSample();
  if (sample !== null) return sample.rssBytes;
  return process.memoryUsage().rss;
}
