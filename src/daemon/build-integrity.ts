/**
 * Build-integrity self-check — Plan 101 Phase 1.
 *
 * Detects when the daemon's own build has vanished out from under it (e.g. a
 * throwaway checkout's `dist/` was deleted while the daemon spawned from it is
 * still running). This is the "silent wedge" from the 2026-07-17 incident:
 * the process stays alive and the HTTP listener stays up, but any lazy
 * `import()` (the embedder) starts throwing because the files are gone.
 *
 * Design (locked in Plan 101 D3/D4/D5 — do not relitigate here):
 *   - `ready` means ONLY "my build still exists on disk". Nothing about load,
 *     queue depth, or embed round-trips (D3) — those would misfire against a
 *     busy daemon mid-reindex.
 *   - The path checked is the daemon's OWN loaded module
 *     (`fileURLToPath(import.meta.url)`), resolved once at module init — never
 *     `argv[1]`, which can be relative depending on how the caller was invoked
 *     (D4).
 *   - Two consecutive misses flip degraded (rides out transient FS blips).
 *     Once degraded, the latch never clears, even if the path reappears (D5).
 *   - The interval is `.unref()`-ed and takes `intervalMs` as a plain
 *     parameter — no env var, and deliberately NOT gated on
 *     `SCRYBE_DAEMON_MEM_SAMPLE_MS` (that var also disables rss-guard; reusing
 *     it here would silently disable this check too). This is a third,
 *     independent interval — see `mem-sampler.ts` / `rss-guard.ts` for the
 *     sibling idiom this follows.
 *
 * Consumed by `src/daemon/http-server.ts` (`/health` returns 503 when
 * `isDegraded()`) — see Plan 101 D2 for why 503 (not a `ready: false` body at
 * 200) is the actual recovery signal.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Module state ────────────────────────────────────────────────────────

/**
 * Absolute path to this daemon's own loaded module, resolved once at module
 * init. Never re-derived from `argv[1]` (D4) — that value's absoluteness
 * depends on how the process was invoked.
 */
const _ownModulePath: string = fileURLToPath(import.meta.url);

let _consecutiveMisses = 0;
let _degraded = false;
let _timer: ReturnType<typeof setInterval> | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns the absolute path this check stats. Exported for tests only.
 */
export function _getOwnModulePathForTests(): string {
  return _ownModulePath;
}

/**
 * Runs a single check of the daemon's own build. Updates the consecutive-miss
 * counter and, per the latch semantics (D5), flips `isDegraded()` to true
 * once two consecutive misses have been observed. Never un-flips it.
 *
 * Returns true if the build is present on this check, false if missing.
 * The return value reflects THIS check only — it does not reflect the latch.
 */
export function checkOnce(): boolean {
  // existsSync follows symlinks, so a dangling symlink correctly reads false.
  const present = existsSync(_ownModulePath);

  if (present) {
    _consecutiveMisses = 0;
    return true;
  }

  _consecutiveMisses += 1;
  if (_consecutiveMisses >= 2) {
    _degraded = true; // latch — never cleared, even if the path reappears later
  }
  return false;
}

/**
 * Whether the daemon has latched into a degraded (build-missing) state.
 * Once true, stays true for the lifetime of the process (D5).
 */
export function isDegraded(): boolean {
  return _degraded;
}

/**
 * Arms the periodic build-integrity check. Call once during daemon startup.
 * The timer is `.unref()`-ed so it does not keep the process alive alone.
 * No-op if already started.
 *
 * @param intervalMs — how often to run `checkOnce()`. A plain function
 *   parameter, not an env var (Plan 101 Goals: "no new contracts, no new env
 *   vars"). Defaults to 60s.
 * @returns a stop function that clears the interval. Safe to call more than
 *   once.
 */
export function startBuildIntegrityCheck(intervalMs = 60_000): () => void {
  if (_timer === null) {
    _timer = setInterval(() => {
      checkOnce();
    }, intervalMs);
    _timer.unref();
  }

  return () => {
    if (_timer !== null) {
      clearInterval(_timer);
      _timer = null;
    }
  };
}

/** For tests only — reset module state between test cases. */
export function _resetBuildIntegrityForTests(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
  _consecutiveMisses = 0;
  _degraded = false;
}
