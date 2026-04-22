/**
 * Daemon idle state machine — Phase 4.
 * Two states: HOT (active window after any event), COLD (default).
 * HOT → COLD transition is the only automatic one — via timeout.
 * COLD → HOT is triggered by any watcher event (via touchActive()).
 *
 * In COLD state the watcher debounce is multiplied by COLD_MULTIPLIER to
 * reduce unnecessary reindexes during long periods without activity.
 */

const HOT_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_HOT_MS"] ?? "", 10);
  return v > 0 ? v : 60_000;
})();

const COLD_MULTIPLIER = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_COLD_MULTIPLIER"] ?? "", 10);
  return v > 0 ? v : 5;
})();

type IdleState = "hot" | "cold";

let _state: IdleState = "cold";
let _timer: ReturnType<typeof setTimeout> | null = null;
let _onChange: ((s: IdleState) => void) | null = null;

/** Call on any meaningful event to transition to HOT and reset the timer. */
export function touchActive(): void {
  const wasHot = _state === "hot";
  _state = "hot";
  if (!wasHot) _onChange?.("hot");
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _state = "cold";
    _timer = null;
    _onChange?.("cold");
  }, HOT_MS);
}

export function getState(): IdleState { return _state; }

/** Returns `baseMs` in HOT state, `baseMs * COLD_MULTIPLIER` in COLD state. */
export function getDebounceMs(baseMs: number): number {
  return _state === "cold" ? baseMs * COLD_MULTIPLIER : baseMs;
}

/** Register a callback to fire on HOT ↔ COLD transitions. */
export function onStateChange(cb: (s: IdleState) => void): void {
  _onChange = cb;
}

/** Only for tests — resets all module-level state. */
export function _resetForTests(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _state = "cold";
  _onChange = null;
}
