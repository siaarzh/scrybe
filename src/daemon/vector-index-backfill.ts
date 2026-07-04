/**
 * Vector-index idle backfill — Plan 95 Phase 3.
 *
 * One-time backfill for existing tables that crossed (or already exceed) the
 * row-count threshold but don't have a native ANN vector index yet — tables
 * created before this feature shipped, or ones that grew past
 * SCRYBE_VECTOR_INDEX_MIN_ROWS since their last reindex. Mirrors the auto-gc
 * idle-scheduling shape (`IdleTracker`, per-project timer reset on any queue
 * event, `.unref()`-ed timers, zero `LifecycleManager` interaction — see
 * memory [[architecture-auto-gc-idle-transparent]]): after
 * SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS of no queue activity for a project,
 * its source tables are queued for a build check.
 *
 * All the actual work — row-count gating, idempotency (skip if already
 * indexed), writeWithRetry serialization, cache invalidation — lives in
 * `createVectorIndex()` (src/vector-store.ts, Plan 95 Phase 2). This module
 * only decides *when* to call it and ensures calls run one table at a time
 * (never a parallel storm across projects/sources) via a single global FIFO.
 *
 * Additive only: no re-embed, no chunk-id/schema change — a build only adds
 * an `_indices` fragment to the table.
 *
 * Master gate: SCRYBE_VECTOR_INDEX (config.vectorIndexEnabled) — reuses the
 * same flag that gates query-time index usage. If index usage is force-
 * disabled, building one during idle time would be wasted work.
 *
 * ─── Rebuild cadence (Plan 95 Phase 4) ─────────────────────────────────────
 *
 * createVectorIndex() only builds an index when one is absent — once built,
 * later incremental upserts land in a new, unindexed Lance fragment that
 * LanceDB flat-merges into query results (so search stays correct — verified
 * rank-0 in the Plan 95 grill), but that fragment grows unbounded until
 * something rebuilds the index. `recordUpsertForRebuildCadence` (called by
 * the indexer after every batched upsert) tracks, per table, the NET row
 * growth since the index was last (re)built (rowsAfter − rowsBefore); once the
 * accumulation crosses a threshold it marks the table for a FORCE rebuild via
 * `markTableForRebuild`, consumed by `processQueue` below the next time that
 * table is swept. NOTE: net growth undercounts pure-churn — a modify-heavy
 * incremental that deletes N old chunks and inserts N new ones nets ~0 while
 * still growing the unindexed fragment. That path is perf-only (flat-merge
 * keeps results correct), and the `markFullReindexForRebuild` path below
 * catches large rewrites; counting rows-written rather than net delta is a
 * possible future refinement. `markFullReindexForRebuild` (called by the
 * indexer after a full reindex) marks unconditionally, since a full reindex
 * can rewrite a large fraction of a table's rows in one go.
 *
 * Threshold: max(SCRYBE_VECTOR_INDEX_REBUILD_ROWS [default 1000], 20% of the
 * table's row count at record time) — an absolute floor so small-but-busy
 * tables still get periodic rebuilds, and a proportional ceiling so very
 * large tables aren't rebuilt on every ~1000-row trickle. Picked by judgment
 * (not benchmarked) — the rebuild is a pure perf optimization, not a
 * correctness fix, so getting K exactly right is not critical.
 *
 * Marking only records intent (an in-memory flag) — it never enqueues or
 * builds anything itself. The actual rebuild stays idle-gated: it only runs
 * when this module's existing IdleTracker/global FIFO (above) next sweeps
 * that table, i.e. after the project has gone idle. This deliberately reuses
 * the Phase 3 machinery rather than adding a second scheduler.
 *
 * The accumulator is process-local and NOT persisted — a daemon restart
 * resets it to 0. That only delays the next rebuild by however many rows
 * accumulate post-restart; it never affects search correctness (flat-merge
 * covers the gap regardless of accumulator state).
 */
import { listProjects, getProject } from "../registry.js";
import { config } from "../config.js";
import { createVectorIndex } from "../vector-store.js";
import { IdleTracker } from "./auto-gc.js";
import { onQueueJobEvent } from "./queue.js";
import type { DaemonEvent } from "./http-server.js";

// ─── Config ───────────────────────────────────────────────────────────────

function isBackfillEnabled(): boolean {
  return config.vectorIndexEnabled;
}

function getIdleMs(): number {
  const v = parseFloat(process.env["SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS"] ?? "");
  return Number.isFinite(v) && v > 0 ? v : 300_000; // 5 min — mirrors auto-gc's default idle window
}

function getRebuildRowThreshold(): number {
  const v = parseInt(process.env["SCRYBE_VECTOR_INDEX_REBUILD_ROWS"] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _pushEvent: ((ev: DaemonEvent) => void) | null = null;
let _tracker: IdleTracker | null = null;

// Global FIFO of table names awaiting a build check — shared across every
// project so builds never run in parallel, regardless of how many projects
// go idle around the same time. createVectorIndex() itself is idempotent and
// cheap to no-op (cached index-presence check), so re-enqueuing an
// already-indexed or below-threshold table is harmless.
let _queue: string[] = [];
const _queued = new Set<string>();
let _processing = false;

// Rebuild-cadence state (Plan 95 Phase 4) — see module doc above.
const _rowsSinceLastBuild = new Map<string, number>();
// Tables that should force-rebuild (drop+recreate the index) the next time
// they're dequeued in processQueue, rather than the plain additive check.
const _pendingForce = new Set<string>();

/** All table names registered for a project (code + knowledge sources alike — both share the 'vector' column). */
function collectTableNames(projectId: string): string[] {
  const project = getProject(projectId);
  if (!project) return [];
  const names: string[] = [];
  for (const source of project.sources) {
    if (source.table_name) names.push(source.table_name);
  }
  return names;
}

function enqueueTables(tableNames: string[]): void {
  let added = false;
  for (const tableName of tableNames) {
    if (!_queued.has(tableName)) {
      _queued.add(tableName);
      _queue.push(tableName);
      added = true;
    }
  }
  if (added) void processQueue();
}

/** Drains `_queue` one table at a time. Re-entrant-safe via `_processing` flag. */
async function processQueue(): Promise<void> {
  if (_processing) return;
  _processing = true;
  try {
    while (_queue.length > 0) {
      const tableName = _queue.shift() as string;
      // Note: kept in `_queued` until the build attempt below settles (not
      // removed here) — this is what makes a duplicate enqueue while the
      // table is mid-build a no-op rather than a second build.
      const startedAt = Date.now();
      // Set.prototype.delete returns whether the value was present — consumes
      // the force mark exactly once (a later mark, e.g. from another full
      // reindex, arms it again for the next sweep).
      const forceRebuild = _pendingForce.delete(tableName);
      try {
        if (forceRebuild) {
          await createVectorIndex(tableName, { force: true });
        } else {
          await createVectorIndex(tableName);
        }
        _pushEvent?.({
          ts: new Date().toISOString(),
          level: "info",
          event: "vector-index.completed",
          detail: { tableName, durationMs: Date.now() - startedAt, forced: forceRebuild },
        });
      } catch (err: unknown) {
        _pushEvent?.({
          ts: new Date().toISOString(),
          level: "warn",
          event: "vector-index.failed",
          detail: { tableName, error: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        _queued.delete(tableName);
      }
    }
  } finally {
    _processing = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Called (directly, or via the IdleTracker onIdle callback) when a project has
 * been idle for the configured window. Collects the project's table names and
 * enqueues them for a sequential build check. No-op if the master gate
 * (SCRYBE_VECTOR_INDEX / config.vectorIndexEnabled) is off.
 */
export function runIdleSweep(projectId: string): void {
  if (!isBackfillEnabled()) return;
  enqueueTables(collectTableNames(projectId));
}

/**
 * Initialize and wire up the idle-backfill trigger.
 * Must be called after initQueue() in main.ts (same ordering constraint as auto-gc).
 */
export function initVectorIndexBackfill(opts: { pushEvent: (ev: DaemonEvent) => void }): IdleTracker {
  _pushEvent = opts.pushEvent;

  const tracker = new IdleTracker(getIdleMs(), (projectId) => runIdleSweep(projectId));
  _tracker = tracker;

  // Hook into all queue events to reset idle timers (same signal auto-gc uses).
  onQueueJobEvent((projectId) => {
    if (isBackfillEnabled()) tracker.reset(projectId);
  });

  // Arm timers for all projects registered at startup.
  if (isBackfillEnabled()) {
    for (const p of listProjects()) tracker.reset(p.id);
  }

  return tracker;
}

/** Get the currently active IdleTracker (for onProjectRemoved wiring in main.ts). */
export function getVectorIndexBackfillTracker(): IdleTracker | null {
  return _tracker;
}

/**
 * Mark `tableName` for a FORCE rebuild (drop + recreate the vector index) the
 * next time it's swept off the global FIFO. Marking never enqueues or builds
 * anything itself — it only annotates what the next idle sweep (driven by
 * the existing IdleTracker, reset on every queue job event) will do once it
 * fires. No-op when the master gate is off.
 */
export function markTableForRebuild(tableName: string): void {
  if (!isBackfillEnabled()) return;
  _pendingForce.add(tableName);
}

/**
 * Called by the indexer after every batched upsert with the number of rows
 * actually added/changed in that batch and the table's new total row count.
 * Accumulates the delta per table and, once it crosses
 * max(SCRYBE_VECTOR_INDEX_REBUILD_ROWS, 20% of rowsAfter), marks the table
 * for a force rebuild and resets the accumulator. This is the only rebuild-
 * cadence entry point the indexer needs for incremental upserts — all
 * threshold/cadence decisions live here so indexer.ts stays a thin reporter
 * of upsert facts. No-op when the master gate is off or nothing was added.
 */
export function recordUpsertForRebuildCadence(tableName: string, rowsAdded: number, rowsAfter: number): void {
  if (!isBackfillEnabled() || rowsAdded <= 0) return;
  const accumulated = (_rowsSinceLastBuild.get(tableName) ?? 0) + rowsAdded;
  const threshold = Math.max(getRebuildRowThreshold(), Math.floor(rowsAfter * 0.2));
  if (accumulated >= threshold) {
    _rowsSinceLastBuild.set(tableName, 0);
    markTableForRebuild(tableName);
  } else {
    _rowsSinceLastBuild.set(tableName, accumulated);
  }
}

/**
 * Called by the indexer after a full reindex completes (mode === "full") and
 * did work. A full reindex can rewrite/add a large fraction of a table's rows
 * in one go, so always request a rebuild rather than waiting for the
 * incremental accumulator (recordUpsertForRebuildCadence) to cross its
 * threshold.
 */
export function markFullReindexForRebuild(tableName: string): void {
  _rowsSinceLastBuild.set(tableName, 0);
  markTableForRebuild(tableName);
}

/** Test-only: number of table names currently queued or in flight. */
export function _pendingCountForTests(): number {
  return _queue.length + (_processing ? 1 : 0);
}

/** Test-only: await until the backfill queue has fully drained. */
export async function _drainForTests(): Promise<void> {
  while (_processing || _queue.length > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Test-only: resets all module-level state. */
export function _resetForTests(): void {
  _pushEvent = null;
  _tracker?.cancelAll();
  _tracker = null;
  _queue = [];
  _queued.clear();
  _processing = false;
  _rowsSinceLastBuild.clear();
  _pendingForce.clear();
}
