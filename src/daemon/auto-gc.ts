/**
 * Auto-GC engine — two triggers:
 *   1. Idle trigger: per-project timer, reset on any queue event. Fires auto-gc after
 *      SCRYBE_AUTO_GC_IDLE_MS (default 5 min) of inactivity for a project.
 *   2. Ratio trigger: after indexSource completes, compute orphan ratio. If above
 *      SCRYBE_AUTO_GC_RATIO and debounce elapsed, enqueue auto-gc.
 *
 * Master disable: SCRYBE_AUTO_GC=0
 */
import { listProjects, getProject } from "../registry.js";
import { listChunkIds, countTableRows } from "../vector-store.js";
import { getAllChunkIdsForSource } from "../branch-state.js";
import { getLastGcTime } from "../jobs-store.js";
import { submitToQueue, onQueueJobEvent } from "./queue.js";
import type { DaemonEvent } from "./http-server.js";

// ─── Config ───────────────────────────────────────────────────────────────

function isAutoGcEnabled(): boolean {
  return process.env["SCRYBE_AUTO_GC"] !== "0";
}

function getIdleMs(): number {
  const v = parseFloat(process.env["SCRYBE_AUTO_GC_IDLE_MS"] ?? "");
  return Number.isFinite(v) && v > 0 ? v : 300_000; // 5 min
}

function getRatioThreshold(): number {
  const v = parseFloat(process.env["SCRYBE_AUTO_GC_RATIO"] ?? "");
  return Number.isFinite(v) && v > 0 ? v : 0.15;
}

function getRatioDebounceMs(): number {
  const v = parseFloat(process.env["SCRYBE_AUTO_GC_RATIO_DEBOUNCE_MS"] ?? "");
  return Number.isFinite(v) && v > 0 ? v : 1_800_000; // 30 min
}

// ─── IdleTracker ──────────────────────────────────────────────────────────

/**
 * Per-project idle timer. Resets on any queue event for the project.
 * After idleMs of no events, calls the onIdle callback.
 */
export class IdleTracker {
  private readonly _idleMs: number;
  private readonly _onIdle: (projectId: string) => void;
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(idleMs: number, onIdle: (projectId: string) => void) {
    this._idleMs = idleMs;
    this._onIdle = onIdle;
  }

  /** Reset (or start) idle timer for a project. */
  reset(projectId: string): void {
    const existing = this._timers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._timers.delete(projectId);
      this._onIdle(projectId);
    }, this._idleMs);
    // Allow process to exit even if timer is outstanding
    if (typeof timer === "object" && "unref" in timer) (timer as any).unref();
    this._timers.set(projectId, timer);
  }

  /** Cancel timer for a project without triggering idle. */
  cancel(projectId: string): void {
    const existing = this._timers.get(projectId);
    if (existing) {
      clearTimeout(existing);
      this._timers.delete(projectId);
    }
  }

  /** Cancel all timers (daemon shutdown). */
  cancelAll(): void {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  /** For testing — check if a timer is active for a project. */
  hasTimer(projectId: string): boolean {
    return this._timers.has(projectId);
  }
}

// ─── Orphan detection ─────────────────────────────────────────────────────

/**
 * Returns true if any code source for the project has at least one orphan chunk
 * (LanceDB row not referenced by any branch tag). Checks live row counts vs
 * branch-tag counts — no caching.
 *
 * Returns true on any read error (defensive default: better to run unnecessary
 * gc than to silently miss orphans). Returns false for projects with no code
 * sources (knowledge-only projects have no orphan concept).
 */
export async function hasOrphans(projectId: string): Promise<boolean> {
  const project = getProject(projectId);
  if (!project) return false;
  for (const source of project.sources) {
    if (!source.table_name || source.source_config.type !== "code") continue;
    try {
      const lance = await countTableRows(source.table_name);
      const tagged = getAllChunkIdsForSource(projectId, source.source_id).size;
      if (lance > tagged) return true;
    } catch {
      return true; // err on the side of running gc
    }
  }
  return false;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _pushEvent: ((ev: DaemonEvent) => void) | null = null;
let _idleTracker: IdleTracker | null = null;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Initialize and wire up auto-gc triggers.
 * Must be called after initQueue() in main.ts.
 */
export function initAutoGc(opts: { pushEvent: (ev: DaemonEvent) => void }): IdleTracker {
  _pushEvent = opts.pushEvent;

  const tracker = new IdleTracker(getIdleMs(), (projectId) => {
    if (!isAutoGcEnabled()) return;
    hasOrphans(projectId).then((orphans) => {
      if (orphans) {
        enqueueAutoGc(projectId, "idle");
      } else {
        _pushEvent?.({
          ts: new Date().toISOString(),
          level: "info",
          event: "auto-gc.skipped",
          projectId,
          detail: { trigger: "idle", reason: "no-orphans" },
        });
      }
    }).catch(() => {
      // If the orphan check itself throws, run gc to be safe
      enqueueAutoGc(projectId, "idle");
    });
  });
  _idleTracker = tracker;

  // Hook into all queue events to reset idle timers
  onQueueJobEvent((projectId, _jobId, _eventType, _req) => {
    if (isAutoGcEnabled()) tracker.reset(projectId);
  });

  // Arm timers for all projects registered at startup
  if (isAutoGcEnabled()) {
    for (const p of listProjects()) {
      tracker.reset(p.id);
    }
  }

  return tracker;
}

/** Get the currently active IdleTracker (for manual gc to reset timers). */
export function getIdleTracker(): IdleTracker | null {
  return _idleTracker;
}

/**
 * Called from the queue worker after a successful indexSource job completion.
 * Computes orphan ratio; enqueues auto-gc if threshold exceeded and debounce elapsed.
 */
export async function evaluateRatioTrigger(projectId: string, sourceId?: string): Promise<void> {
  if (!isAutoGcEnabled()) return;

  const project = getProject(projectId);
  if (!project) return;

  const threshold = getRatioThreshold();
  const debounceMs = getRatioDebounceMs();

  // Aggregate across code sources
  let totalLance = 0;
  let totalTagged = 0;

  const sources = sourceId
    ? project.sources.filter((s) => s.source_id === sourceId && s.source_config.type === "code")
    : project.sources.filter((s) => s.source_config.type === "code");

  for (const source of sources) {
    if (!source.table_name) continue;
    try {
      const lanceIds = await listChunkIds(projectId, source.table_name);
      const taggedIds = getAllChunkIdsForSource(projectId, source.source_id);
      totalLance += lanceIds.length;
      totalTagged += taggedIds.size;
    } catch { /* non-fatal — skip this source */ }
  }

  if (totalLance === 0) return;

  const orphanRatio = (totalLance - totalTagged) / totalLance;
  if (orphanRatio <= threshold) return;

  // Check debounce — if last gc failed, treat debounce as elapsed (ignoreDebounceForFailed)
  try {
    const lastGcTime = getLastGcTime(projectId, { ignoreDebounceForFailed: true });
    if (lastGcTime !== null && Date.now() - lastGcTime < debounceMs) return;
  } catch { /* non-fatal */ }

  enqueueAutoGc(projectId, "ratio");
}

/**
 * Enqueue an auto-gc job for a project.
 * A2: Validates project still exists before submitting — skips with event if removed.
 * Does nothing if SCRYBE_AUTO_GC=0.
 */
export function enqueueAutoGc(projectId: string, trigger: "idle" | "ratio"): void {
  if (!isAutoGcEnabled()) return;

  // A2: Re-read registry to confirm project still exists
  const project = getProject(projectId);
  if (!project) {
    // Project was removed — cancel its timer and skip
    _idleTracker?.cancel(projectId);
    _pushEvent?.({
      ts: new Date().toISOString(),
      level: "info",
      event: "auto-gc.skipped",
      projectId,
      detail: { trigger, reason: "project_not_found" },
    });
    return;
  }

  _pushEvent?.({
    ts: new Date().toISOString(),
    level: "info",
    event: "auto-gc.scheduled",
    projectId,
    detail: { trigger },
  });

  submitToQueue({
    projectId,
    type: "gc",
    gcOptions: { mode: "grace" },
    mode: "incremental", // required field, unused for gc
  });
}
