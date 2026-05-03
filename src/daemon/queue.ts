/**
 * Daemon job queue — Phase 3.
 * Wraps jobs.ts with:
 *   - Cross-project concurrency cap (max cpu/2)
 *   - Per-project serialization (no two jobs for the same project run simultaneously)
 *   - JSONL durable log with 10 MB rotation (daemon-log.jsonl)
 *   - SSE / ring-buffer event emission via injected pushEvent
 *
 * pushEvent is injected rather than imported to avoid a circular dependency with
 * http-server.ts (which imports queue.ts for getQueueStats).
 */
import { randomBytes } from "node:crypto";
import { cpus } from "node:os";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { submitJob, submitSourceJob, getJobStatus } from "../jobs.js";
import { insertJob, updateJobStatus, cancelPendingGcJobs } from "../jobs-store.js";
import { getProject } from "../registry.js";
import type { DaemonEvent } from "./http-server.js";
import type { IndexMode } from "../types.js";
import type { JobType } from "../jobs-store.js";

// ─── Config ───────────────────────────────────────────────────────────────

const MAX_CONCURRENT = (() => {
  const env = parseInt(process.env["SCRYBE_DAEMON_MAX_CONCURRENT"] ?? "", 10);
  return env > 0 ? env : Math.max(1, Math.floor(cpus().length / 2));
})();

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Types ────────────────────────────────────────────────────────────────

export interface QueueRequest {
  projectId: string;
  sourceId?: string;
  branch?: string;
  mode?: IndexMode;
  type?: JobType;
  gcOptions?: { mode: "grace" | "purge" };
}

interface PendingItem extends QueueRequest {
  jobId: string;
  resolve: (jobId: string) => void;
  reject: (err: Error) => void;
}

interface ActiveEntry extends QueueRequest {
  jobId: string;
  startedAt: string;
  timer: ReturnType<typeof setInterval>;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _pushEvent: ((ev: DaemonEvent) => void) | null = null;
let _pending: PendingItem[] = [];
let _active = new Map<string, ActiveEntry>(); // jobId → entry

/** Job lifecycle event hook — fired for any projectId on submit, complete, or fail. */
export type QueueJobEventType = "submitted" | "completed" | "failed" | "cancelled";
export type QueueJobEventCallback = (projectId: string, jobId: string, eventType: QueueJobEventType, req: QueueRequest) => void;
let _jobEventCallbacks: QueueJobEventCallback[] = [];

// ─── Public API ───────────────────────────────────────────────────────────

/** Wire in the SSE emitter. Must be called before enqueue(). */
export function initQueue(opts: { pushEvent: (ev: DaemonEvent) => void }): void {
  _pushEvent = opts.pushEvent;
}

/** Register a callback for job lifecycle events (submitted/completed/failed/cancelled). */
export function onQueueJobEvent(cb: QueueJobEventCallback): void {
  _jobEventCallbacks.push(cb);
}

/**
 * Cancel pending (not-yet-started) jobs of a given type, optionally scoped to project IDs.
 * Does NOT cancel active (running) jobs — they finish cleanly.
 * Returns count of items removed from the in-memory pending queue.
 */
export function cancelPendingByType(type: JobType, projectIds?: string[]): number {
  const before = _pending.length;
  const cancelledJobIds: string[] = [];

  _pending = _pending.filter((item) => {
    const typeMatch = (item.type ?? "reindex") === type;
    const scopeMatch = !projectIds || projectIds.includes(item.projectId);
    if (typeMatch && scopeMatch) {
      cancelledJobIds.push(item.jobId);
      item.reject(new Error("Cancelled by manual gc"));
      return false;
    }
    return true;
  });

  // Also mark them cancelled in SQLite
  if (cancelledJobIds.length > 0 && projectIds) {
    try { cancelPendingGcJobs(projectIds); } catch { /* non-fatal */ }
  } else if (cancelledJobIds.length > 0) {
    // No scope — cancel all pending gc in SQLite
    try { cancelPendingGcJobs(cancelledJobIds.map(() => "*")); } catch { /* non-fatal */ }
  }

  return before - _pending.length;
}

/** Returns current queue depth and concurrency cap. Used by /status. */
export function getQueueStats(): { active: number; pending: number; maxConcurrent: number } {
  return { active: _active.size, pending: _pending.length, maxConcurrent: MAX_CONCURRENT };
}

export interface SubmitResult {
  jobId: string;
  status: "queued" | "running";
  queuePosition?: number;
  duplicateOfPending: boolean;
}

/**
 * Submit a job to the queue immediately — returns without waiting for the job to start.
 * Use this from HTTP handlers so /kick never hangs.
 */
export function submitToQueue(req: QueueRequest): SubmitResult {
  const jobId = randomBytes(4).toString("hex");
  const now = Date.now();

  const duplicateOfPending = _pending.some(
    (p) =>
      p.projectId === req.projectId &&
      p.sourceId === req.sourceId &&
      (p.mode ?? "incremental") === (req.mode ?? "incremental") &&
      p.branch === req.branch
  );

  // Write to SQLite as "queued" so it's visible to list_jobs immediately
  try {
    insertJob({
      job_id: jobId,
      project_id: req.projectId,
      source_id: req.sourceId ?? null,
      branch: req.branch ?? null,
      mode: req.mode ?? "incremental",
      status: "queued",
      phase: null,
      queued_at: now,
      started_at: null,
      finished_at: null,
      error_message: null,
      origin: "daemon",
      type: req.type ?? "reindex",
      result: null,
    });
  } catch { /* non-fatal */ }

  const item: PendingItem = { ...req, jobId, resolve: () => {}, reject: () => {} };
  _pending.push(item);
  fireJobEventCallbacks(req.projectId, jobId, "submitted", req);
  drain();

  if (_active.has(jobId)) {
    return { jobId, status: "running", duplicateOfPending };
  }
  const queuePosition = _pending.findIndex((p) => p.jobId === jobId);
  return { jobId, status: "queued", queuePosition: queuePosition >= 0 ? queuePosition : undefined, duplicateOfPending };
}

/**
 * Submit a job through the queue.
 * Resolves with the job_id once the job STARTS (not when it completes).
 * If the project is currently busy or MAX_CONCURRENT is reached, the request
 * waits in the pending list until a slot opens.
 */
export function enqueue(req: QueueRequest): Promise<string> {
  const jobId = randomBytes(4).toString("hex");
  return new Promise<string>((resolve, reject) => {
    _pending.push({ ...req, jobId, resolve, reject });
    fireJobEventCallbacks(req.projectId, jobId, "submitted", req);
    drain();
  });
}

/** Return pending jobs (queued but not yet started). Used by /status and queue_status. */
export function getPending(): Array<{ jobId: string; projectId: string; sourceId?: string; mode: IndexMode; queuedAt?: number }> {
  return _pending.map((p) => ({
    jobId: p.jobId,
    projectId: p.projectId,
    sourceId: p.sourceId,
    mode: p.mode ?? "incremental",
  }));
}

/** Drain all pending items and stop all watch timers. Call on daemon shutdown. */
export function stopQueue(): void {
  for (const entry of _active.values()) clearInterval(entry.timer);
  _active.clear();

  for (const item of _pending) item.reject(new Error("Queue stopped"));
  _pending = [];
}

/** Only for tests — resets module-level state so each test starts clean. */
export function _resetForTests(): void {
  stopQueue();
  _pushEvent = null;
  _jobEventCallbacks = [];
}

// ─── Internal ─────────────────────────────────────────────────────────────

function activeProjectIds(): Set<string> {
  const ids = new Set<string>();
  for (const e of _active.values()) ids.add(e.projectId);
  return ids;
}

function drain(): void {
  while (_active.size < MAX_CONCURRENT && _pending.length > 0) {
    const busy = activeProjectIds();
    const idx = _pending.findIndex((r) => !busy.has(r.projectId));
    if (idx === -1) break;

    const item = _pending.splice(idx, 1)[0];
    const startedAt = new Date().toISOString();
    const jobType = item.type ?? "reindex";

    // A3: Fail-fast on phantom project — project may have been removed between
    // submitToQueue and drain. Defense-in-depth for edge cases A1/A2 miss.
    // Only check if projects.json exists (skip on fresh install / test env without registry).
    try {
      const registryPath = join(config.dataDir, "projects.json");
      if (existsSync(registryPath) && !getProject(item.projectId)) {
        try {
          updateJobStatus(item.jobId, {
            status: "failed",
            finished_at: Date.now(),
            error_message: "project no longer exists",
          });
        } catch { /* non-fatal */ }
        emit({
          ts: startedAt,
          level: "warn",
          event: "job.failed",
          projectId: item.projectId,
          detail: { jobId: item.jobId, type: jobType, skippedOrphan: true, reason: "project no longer exists" },
        });
        item.resolve(item.jobId); // resolve so callers don't hang
        fireJobEventCallbacks(item.projectId, item.jobId, "failed", item);
        continue;
      }
    } catch { /* registry read failure — proceed normally */ }

    if (jobType === "gc") {
      // GC jobs are dispatched to the gc handler asynchronously;
      // we track them ourselves in _active.
      const gcJobId = item.jobId;
      item.resolve(gcJobId);

      // Update SQLite row to "running"
      try {
        updateJobStatus(gcJobId, { status: "running", started_at: Date.now() });
      } catch { /* non-fatal */ }

      emit({
        ts: startedAt, level: "info", event: "job.started",
        projectId: item.projectId, sourceId: item.sourceId,
        detail: { jobId: gcJobId, type: "gc", gcMode: item.gcOptions?.mode ?? "grace" },
      });

      const timer = setInterval(() => {
        // GC jobs use a flag stored in _active — we resolve when the async work sets it
        const entry = _active.get(gcJobId);
        if (!entry || !(entry as any)._gcDone) return;

        clearInterval(timer);
        _active.delete(gcJobId);
        drain();
      }, 200);

      const entry: ActiveEntry = {
        ...item,
        jobId: gcJobId,
        startedAt,
        timer,
      };
      _active.set(gcJobId, entry);

      // Run the gc handler asynchronously
      runGcJob(item, gcJobId, startedAt);
      continue;
    }

    // Reindex job — delegate to jobs.ts
    const result = item.sourceId
      ? submitSourceJob(item.projectId, item.sourceId, item.mode ?? "incremental", item.branch, item.jobId)
      : submitJob(item.projectId, item.mode ?? "incremental", undefined, item.branch, item.jobId);

    if (typeof result !== "string") {
      // jobs.ts says already_running — project added to active via an out-of-band submitJob call;
      // re-queue and wait for it to finish before retrying
      _pending.unshift({ ...item });
      break;
    }

    const jobId = result;
    item.resolve(jobId);

    emit({
      ts: startedAt, level: "info", event: "job.started",
      projectId: item.projectId, sourceId: item.sourceId, branch: item.branch,
      detail: { jobId, mode: item.mode ?? "incremental" },
    });

    const timer = setInterval(() => {
      const status = getJobStatus(jobId);
      if (!status || status.status === "running") return;

      clearInterval(timer);
      _active.delete(jobId);

      const durationMs =
        status.finished_at != null && status.started_at != null
          ? status.finished_at - status.started_at
          : undefined;

      const eventName: DaemonEvent["event"] =
        status.status === "done" ? "job.completed"
        : status.status === "cancelled" ? "job.cancelled"
        : "job.failed";

      const reqCopy = item;
      fireJobEventCallbacks(
        item.projectId, jobId,
        status.status === "done" ? "completed" : status.status === "failed" ? "failed" : "cancelled",
        reqCopy
      );

      emit({
        ts: new Date().toISOString(),
        level: status.status === "failed" ? "error" : "info",
        event: eventName,
        projectId: item.projectId,
        sourceId: item.sourceId,
        branch: item.branch,
        durationMs,
        ...(status.error ? { error: { message: status.error } } : {}),
        detail: { jobId },
      });

      drain();
    }, 200);

    _active.set(jobId, {
      ...item,
      jobId,
      startedAt,
      timer,
    });
  }
}

async function runGcJob(item: PendingItem, gcJobId: string, _startedAt: string): Promise<void> {
  const { runGcJobHandler } = await import("./gc-handler.js");
  const gcMode = item.gcOptions?.mode ?? "grace";
  // "grace" mode = auto-triggered gc; "purge" = user-explicit
  const isAutoTrigger = gcMode === "grace";

  try {
    const gcResult = await runGcJobHandler({
      projectId: item.projectId,
      sourceId: item.sourceId,
      mode: gcMode,
    });

    try {
      updateJobStatus(gcJobId, {
        status: "done",
        finished_at: Date.now(),
        result: JSON.stringify(gcResult),
      });
    } catch { /* non-fatal */ }

    fireJobEventCallbacks(item.projectId, gcJobId, "completed", item);

    emit({
      ts: new Date().toISOString(), level: "info", event: "job.completed",
      projectId: item.projectId, sourceId: item.sourceId,
      durationMs: gcResult.duration_ms,
      detail: {
        jobId: gcJobId,
        type: "gc",
        orphans_deleted: gcResult.orphans_deleted,
        bytes_freed: gcResult.bytes_freed,
      },
    });

    if (isAutoTrigger) {
      emit({
        ts: new Date().toISOString(), level: "info", event: "auto-gc.completed",
        projectId: item.projectId,
        durationMs: gcResult.duration_ms,
        detail: {
          orphans_deleted: gcResult.orphans_deleted,
          bytes_freed: gcResult.bytes_freed,
          duration_ms: gcResult.duration_ms,
        },
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    try {
      updateJobStatus(gcJobId, {
        status: "failed",
        finished_at: Date.now(),
        error_message: message,
      });
    } catch { /* non-fatal */ }

    fireJobEventCallbacks(item.projectId, gcJobId, "failed", item);

    emit({
      ts: new Date().toISOString(), level: "error", event: "job.failed",
      projectId: item.projectId, sourceId: item.sourceId,
      error: { message },
      detail: { jobId: gcJobId, type: "gc" },
    });

    if (isAutoTrigger) {
      emit({
        ts: new Date().toISOString(), level: "error", event: "auto-gc.failed",
        projectId: item.projectId,
        error: { message },
        detail: { error: message },
      });
    }
  }

  // Signal the polling timer that gc is done
  const entry = _active.get(gcJobId);
  if (entry) { (entry as any)._gcDone = true; }
}

function fireJobEventCallbacks(
  projectId: string, jobId: string, eventType: QueueJobEventType, req: QueueRequest
): void {
  for (const cb of _jobEventCallbacks) {
    try { cb(projectId, jobId, eventType, req); } catch { /* non-fatal */ }
  }
}

function emit(ev: DaemonEvent): void {
  _pushEvent?.(ev);
  appendLog(ev);
}

function logFilePath(): string {
  return process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
}

function appendLog(ev: DaemonEvent): void {
  const path = logFilePath();
  try {
    if (existsSync(path) && statSync(path).size >= MAX_LOG_BYTES) rotate(path);
    appendFileSync(path, JSON.stringify(ev) + "\n", "utf8");
  } catch { /* non-fatal — log I/O must not crash the daemon */ }
}

function rotate(path: string): void {
  const arc2 = `${path}.2`;
  const arc1 = `${path}.1`;
  try { if (existsSync(arc1)) renameSync(arc1, arc2); } catch { /* ignore */ }
  try { renameSync(path, arc1); } catch { /* ignore */ }
}
