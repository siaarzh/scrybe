/**
 * Daemon ticket poller — Plan 44, Phases 1 + 2.
 * Periodically enqueues an incremental reindex for each ticket source so that
 * issue data stays fresh without manual intervention.
 *
 * Each tick calls `enqueue({ projectId, sourceId, mode: "incremental" })` with
 * no branch field — ticket sources are branchless. The indexer and `cursors.ts`
 * handle the actual fetch and cursor update.
 *
 * Active interval:  SCRYBE_DAEMON_TICKET_ACTIVE_MS (default 15 min)
 * Idle interval:    SCRYBE_DAEMON_TICKET_IDLE_MS   (default 60 min)
 * Disable entirely: SCRYBE_DAEMON_NO_TICKET_FETCH=1
 *
 * Phase 2 additions:
 *  - Per-host serialization: at most one poll in flight per hostname.
 *  - Global concurrency cap of MAX_CONCURRENT (2) across all hosts.
 *  - Exponential backoff on poll-cycle failure (RETRY_BASE_MS…RETRY_MAX_MS).
 *  - Warned-state dedup for auth failures (401/403): emits one warn per source
 *    until a subsequent successful cycle resets the flag.
 *
 * NOTE on enqueue-only backoff: `enqueue()` itself only writes to an in-memory
 * queue — it does not perform HTTP calls and will not throw 429/5xx. The
 * backoff/warned-state machinery therefore only fires on queueing errors (e.g.
 * queue full, serialization fault) or on auth errors surfaced during token
 * validation if that step is added upstream. The machinery is fully in place
 * and unit-testable by injecting a throwing enqueue stub; real HTTP errors are
 * surfaced by the indexer worker, not here. See notes_for_next_slice in
 * step-2.json for guidance on slice-3 test strategy.
 */
import { loadCursor } from "../cursors.js";
import { getState } from "./idle-state.js";
import { enqueue } from "./queue.js";
import { diagEmit } from "./events.js";
import type { DaemonEvent } from "./http-server.js";
import type { Project } from "../types.js";

// ─── Config ───────────────────────────────────────────────────────────────

const TICKET_ACTIVE_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] ?? "", 10);
  return v > 0 ? v : 15 * 60_000;
})();

const TICKET_IDLE_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] ?? "", 10);
  return v > 0 ? v : 60 * 60_000;
})();

const SKIP_TICKET_FETCH = process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"] === "1";
const MAX_CONCURRENT = 2;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

// ─── Types ────────────────────────────────────────────────────────────────

interface TicketPollerState {
  projectId: string;
  sourceId: string;
  /** Hostname extracted from the ticket source's base_url. Used as the per-host lock key. */
  host: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Consecutive failure count — drives exponential backoff delay. Reset to 0 on success. */
  retries: number;
  /**
   * Set when a 401/403 auth error has already been warned for this source so
   * that we don't spam the daemon log on every poll tick. Cleared on success.
   */
  warnedTokenExpired: boolean;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _push: ((ev: DaemonEvent) => void) | null = null;
const _pollers = new Map<string, TicketPollerState>();
/** Global count of ticket polls currently in-flight (across all hosts). */
let _activePolls = 0;
/** Per-hostname in-flight flag — prevents concurrent polls against the same host. */
const _hostInFlight = new Set<string>();

// ─── Public API ───────────────────────────────────────────────────────────

export function initTicketPoller(opts: { pushEvent: (ev: DaemonEvent) => void }): void {
  _push = opts.pushEvent;
}

/**
 * Emit a daemon event to BOTH channels: the live SSE ring (pushEvent, for
 * `scrybe daemon` watchers) and the durable daemon-log.jsonl (diagEmit). The
 * durable write is what makes poller activity greppable after the fact — the
 * pushEvent ring is in-memory only and lost on restart.
 */
function emit(ev: DaemonEvent): void {
  _push?.(ev);
  diagEmit(ev as unknown as Record<string, unknown>);
}

/** Start per-source ticket pollers. Backfills cursorless sources immediately. */
export function startTicketPoller(projects: Project[]): void {
  if (SKIP_TICKET_FETCH) return;
  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type !== "ticket") continue;

      // Extract hostname for per-host serialization. Fall back to a unique key
      // derived from the source ID if the base_url is somehow malformed.
      const baseUrl = (source.source_config as { type: "ticket"; base_url: string }).base_url;
      let host: string;
      try {
        host = new URL(baseUrl).host;
      } catch {
        host = `unknown:${source.source_id}`;
      }

      const key = `${project.id}:${source.source_id}`;
      const ps: TicketPollerState = {
        projectId: project.id,
        sourceId: source.source_id,
        host,
        timer: null,
        retries: 0,
        warnedTokenExpired: false,
      };
      _pollers.set(key, ps);

      // Backfill: if no cursor exists yet, poll immediately (delay 0); otherwise
      // start on the normal cadence so startup doesn't hammer every ticket source.
      const cursor = loadCursor(project.id, source.source_id);
      schedulePoller(ps, cursor === null ? 0 : (getState() === "hot" ? TICKET_ACTIVE_MS : TICKET_IDLE_MS));
    }
  }
}

/** Stop all ticket pollers — call on daemon shutdown. */
export function stopTicketPoller(): void {
  for (const ps of _pollers.values()) {
    if (ps.timer) clearTimeout(ps.timer);
  }
  _pollers.clear();
  _activePolls = 0;
  _hostInFlight.clear();
}

/**
 * Called by main.ts on a cold→hot transition so every ticket source gets an
 * immediate catch-up poll when a client reconnects after an idle period.
 */
export function ticketPollerOnHot(): void {
  if (SKIP_TICKET_FETCH) return;
  for (const ps of _pollers.values()) {
    schedulePoller(ps, 0);
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────

function schedulePoller(ps: TicketPollerState, delayMs: number): void {
  if (ps.timer) clearTimeout(ps.timer);
  const t = setTimeout(() => {
    ps.timer = null;
    runPoller(ps).catch(() => {});
  }, delayMs);
  t.unref();
  ps.timer = t;
}

async function runPoller(ps: TicketPollerState): Promise<void> {
  // ── Global concurrency cap (mirror fetch-poller's MAX_CONCURRENT pattern) ──
  if (_activePolls >= MAX_CONCURRENT) {
    // At global cap — retry after a short pause (same idiom as fetch-poller)
    schedulePoller(ps, 5_000);
    return;
  }

  // ── Per-host serialization — at most one poll per hostname at a time ──────
  if (_hostInFlight.has(ps.host)) {
    // Another source on the same host is currently polling — back off briefly
    schedulePoller(ps, 5_000);
    return;
  }

  _activePolls++;
  _hostInFlight.add(ps.host);

  try {
    await pollTicketSource(ps);
    // Success: reset backoff counter and re-arm warnings
    ps.retries = 0;
    ps.warnedTokenExpired = false;
  } catch (err) {
    const msg = String(err);

    // ── Auth failure (401 / 403) — warn once per source ───────────────────
    if (msg.includes("expired or invalid")) {
      if (!ps.warnedTokenExpired) {
        emit({
          ts: new Date().toISOString(),
          level: "warn",
          event: "watcher.event",
          projectId: ps.projectId,
          detail: {
            phase: "ticket-poller",
            sourceId: ps.sourceId,
            error: msg,
            hint: `Update the token with: scrybe update-source --project-id ${ps.projectId} --source-id ${ps.sourceId} --gitlab-token <new-token>`,
          },
        });
        ps.warnedTokenExpired = true;
      }
      // Auth failures do not benefit from rapid retry — use full backoff
    }

    // ── Exponential backoff on any poll failure ───────────────────────────
    ps.retries++;
    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, ps.retries - 1), RETRY_MAX_MS);
    emit({
      ts: new Date().toISOString(),
      level: "warn",
      event: "watcher.event",
      projectId: ps.projectId,
      detail: { phase: "ticket-poller", sourceId: ps.sourceId, error: msg, retries: ps.retries },
    });
    schedulePoller(ps, delay);
    return;
  } finally {
    _activePolls--;
    _hostInFlight.delete(ps.host);
  }

  const nextMs = getState() === "hot" ? TICKET_ACTIVE_MS : TICKET_IDLE_MS;
  schedulePoller(ps, nextMs);
}

async function pollTicketSource(ps: TicketPollerState): Promise<void> {
  await enqueue({
    projectId: ps.projectId,
    sourceId: ps.sourceId,
    mode: "incremental",
  });

  emit({
    ts: new Date().toISOString(),
    level: "info",
    event: "watcher.event",
    projectId: ps.projectId,
    detail: { phase: "ticket-poller", sourceId: ps.sourceId, enqueued: true },
  });

  if (process.env["SCRYBE_DEBUG_TICKET_POLLER"] === "1") {
    emit({
      ts: new Date().toISOString(),
      level: "info",
      event: "watcher.event",
      projectId: ps.projectId,
      detail: { phase: "ticket-poller.tick", sourceId: ps.sourceId, host: ps.host },
    });
  }
}
