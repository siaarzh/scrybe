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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCursor } from "../cursors.js";
import { config } from "../config.js";
import { getState } from "./idle-state.js";
import { enqueue } from "./queue.js";
import { diagEmit } from "./events.js";
import { listProjects } from "../registry.js";
import type { DaemonEvent } from "./http-server.js";
import type { QueueJobEventType, QueueRequest } from "./queue.js";
import type { Project, Source } from "../types.js";

// ─── Literal-token warning (ADR-0002) ─────────────────────────────────────────
// Fired once per daemon start per source whose token contains no ${VAR} reference.
// A module-level Set keeps it deduplicated across restarts-without-process-exit.
const _warnedLiteralToken = new Set<string>();

/** Returns true if the token string contains at least one ${VAR} reference. */
function hasEnvRef(token: string): boolean {
  return /\$\{[A-Z_][A-Z0-9_]*\}/.test(token);
}

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
  /**
   * Set when an unset env-var token error has already been warned for this source.
   * Cleared on success so a subsequent re-arm (e.g. after env var is set) re-warns
   * if the var goes missing again.
   */
  warnedUnsetVar: boolean;
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

/**
 * Register a single ticket source into `_pollers`. Shared by boot and reconcile.
 * Handles literal-token warn-once, cursor-based backfill delay, and hot/cold cadence.
 */
function registerTicketSource(project: Project, source: Source): void {
  const key = `${project.id}:${source.source_id}`;

  // Already registered — skip (reconcile handles updates at the diff level)
  if (_pollers.has(key)) return;

  // Extract hostname for per-host serialization.
  const baseUrl = (source.source_config as { type: "ticket"; base_url: string }).base_url;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = `unknown:${source.source_id}`;
  }

  // ADR-0002: warn once per daemon start when token is a literal (not ${VAR}).
  const rawToken = (source.source_config as { type: "ticket"; token: string }).token ?? "";
  if (!hasEnvRef(rawToken) && rawToken !== "" && !_warnedLiteralToken.has(key)) {
    _warnedLiteralToken.add(key);
    emit({
      ts: new Date().toISOString(),
      level: "warn",
      event: "watcher.event",
      projectId: project.id,
      detail: {
        // Use a distinct phase so downstream filters can distinguish this
        // from auth-failure or unset-var warnings (ADR-0002).
        phase: "ticket-poller.literal-token",
        sourceId: source.source_id,
        literalTokenWarn: true,
        message: `Source "${source.source_id}" uses a literal token. ` +
          `Store the token in an env var (e.g. SCRYBE_GITLAB_TOKEN) and reference it as \${SCRYBE_GITLAB_TOKEN} ` +
          `to avoid exposing credentials in projects.json.`,
      },
    });
  }

  const ps: TicketPollerState = {
    projectId: project.id,
    sourceId: source.source_id,
    host,
    timer: null,
    retries: 0,
    warnedTokenExpired: false,
    warnedUnsetVar: false,
  };
  _pollers.set(key, ps);

  // Backfill: if no cursor exists yet, poll immediately (delay 0); otherwise
  // start on the normal cadence so startup doesn't hammer every ticket source.
  const cursor = loadCursor(project.id, source.source_id);
  schedulePoller(ps, cursor === null ? 0 : (getState() === "hot" ? TICKET_ACTIVE_MS : TICKET_IDLE_MS));
}

/**
 * Reconcile running pollers against the current registry state.
 *
 * - New ticket sources (not in `_pollers`): registered with same logic as boot
 *   (literal-token warn-once, backfill: cursor null → delay 0, else hot/cold cadence).
 * - Vanished sources (in `_pollers` but not in registry): timer cleared, entry removed.
 *   Removal is only attempted when the registry file is known to exist so that test
 *   environments without a projects.json do not accidentally clear boot-registered pollers.
 *
 * Safe to call at any time while the daemon is running. Reads `listProjects()`
 * fresh on each call so it sees sources added or removed since the last reconcile.
 */
export function reconcileTicketPollers(): void {
  if (SKIP_TICKET_FETCH) return;

  const registryPath = join(config.dataDir, "projects.json");
  const registryExists = existsSync(registryPath);

  let projects: Project[];
  try {
    projects = listProjects();
  } catch {
    // Registry read failure — skip reconcile, leave existing pollers intact
    return;
  }

  // Build the set of keys that should exist after reconcile
  const liveKeys = new Set<string>();
  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type !== "ticket") continue;
      const key = `${project.id}:${source.source_id}`;
      liveKeys.add(key);
      // Register new sources (registerTicketSource is a no-op for existing keys)
      registerTicketSource(project, source);
    }
  }

  // Remove pollers for vanished sources — only when registry file exists so that
  // test environments or fresh installs without a projects.json do not wipe pollers
  // that were registered via startTicketPoller with an explicit project list.
  if (registryExists) {
    for (const [key, ps] of _pollers) {
      if (!liveKeys.has(key)) {
        if (ps.timer) clearTimeout(ps.timer);
        _pollers.delete(key);
        _warnedLiteralToken.delete(key);
      }
    }
  }
}

/** Start per-source ticket pollers. Backfills cursorless sources immediately. */
export function startTicketPoller(projects: Project[]): void {
  if (SKIP_TICKET_FETCH) return;
  // Boot path: register all ticket sources from the provided snapshot.
  // Uses registerTicketSource (no-op for already-registered keys) so that if
  // reconcileTicketPollers() was called before startTicketPoller, no source is double-started.
  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type !== "ticket") continue;
      registerTicketSource(project, source);
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
 *
 * Reconciles the poller map before rescheduling so that sources added or removed
 * since the last reconcile are swept up on every cold→hot transition (D2 hook 2).
 */
export function ticketPollerOnHot(): void {
  if (SKIP_TICKET_FETCH) return;
  reconcileTicketPollers();
  for (const ps of _pollers.values()) {
    schedulePoller(ps, 0);
  }
}

/**
 * Handler for queue job events — D2 hook 1.
 *
 * When a reindex job is submitted for a ticket-type source, reconcile the poller
 * map so that a source added via add_source (which always enqueues immediately)
 * is picked up by the poller within the same second, without waiting for a daemon
 * restart.
 *
 * Intended to be passed directly to `onQueueJobEvent(ticketPollerOnJobEvent)` in
 * main.ts. Respects the SKIP_TICKET_FETCH guard semantics (reconcileTicketPollers
 * is a no-op when the guard is set).
 */
export function ticketPollerOnJobEvent(
  projectId: string,
  _jobId: string,
  eventType: QueueJobEventType,
  req: QueueRequest,
): void {
  if (eventType !== "submitted") return;
  if ((req.type ?? "reindex") !== "reindex") return;
  // Only trigger a registry read when the job is for a ticket-type source.
  // If no sourceId, skip — a project-wide reindex could be code or anything.
  if (!req.sourceId) return;
  try {
    const project = listProjects().find((p) => p.id === projectId);
    if (!project) return;
    const source = project.sources.find((s) => s.source_id === req.sourceId);
    if (source?.source_config.type === "ticket") {
      reconcileTicketPollers();
    }
  } catch { /* non-fatal — must not interfere with job submission */ }
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
    ps.warnedUnsetVar = false;
  } catch (err) {
    const msg = String(err);

    // ── Unset env-var token reference — warn once, use idle-cadence retry ─
    // Pattern comes from resolveEnvRef: "env var VAR not set (referenced in scrybe config)"
    // or from the plugin's own rethrow: "references env var VAR which is not set"
    if (msg.includes("not set") && (msg.includes("env var") || msg.includes("references env var"))) {
      if (!ps.warnedUnsetVar) {
        emit({
          ts: new Date().toISOString(),
          level: "warn",
          event: "watcher.event",
          projectId: ps.projectId,
          detail: {
            phase: "ticket-poller",
            sourceId: ps.sourceId,
            error: msg,
            hint: `Set the missing env var in your environment or in <DATA_DIR>/.env, ` +
              `then update the source token with: scrybe update-source --project-id ${ps.projectId} --source-id ${ps.sourceId} --token '\${VAR_NAME}'`,
          },
        });
        ps.warnedUnsetVar = true;
      }
      // Unset-var failures won't improve with rapid retry — schedule at idle cadence
      schedulePoller(ps, TICKET_IDLE_MS);
      return;
    }

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
