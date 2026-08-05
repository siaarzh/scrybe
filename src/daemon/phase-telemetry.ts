/**
 * Per-phase memory telemetry for an indexing job — Plan 117.
 *
 * ## Why this exists
 *
 * The only per-job memory record we had was `activity-span` (emitted from
 * `queue.ts` when a reindex job finishes). Two measured properties made it
 * useless for attributing daemon growth:
 *
 *   1. It reports **process-global** RSS labelled with **one job**. 9,738 of
 *      14,332 observed spans overlapped another span, so concurrent jobs book
 *      each other's allocation. Restricting to strictly-isolated spans left 125
 *      of them, max duration 1.6 s — i.e. every job long enough to matter
 *      overlaps something.
 *   2. It is written **at job end**. 5,149 of 18,451 jobs emitted no span at
 *      all, because the daemon was killed mid-job. The jobs that never got a
 *      record are exactly the expensive ones.
 *
 * This module addresses (2) directly and narrows (1): each *phase* of a job
 * emits its own record **the moment that phase ends**, so a daemon killed in
 * phase 4 still leaves phases 1–3 on disk. RSS is still process-global (nothing
 * in-process can change that), but a phase boundary is a much tighter bracket
 * than a whole job, and the long streaming phase is additionally cut into
 * time-bounded segments so growth can be located *within* it.
 *
 * ## Sink and volume
 *
 * Records go to `phase-log.jsonl`, **not** `daemon-log.jsonl`. Phase records
 * are ~8x more frequent than job records; folding them into the daemon log
 * would shrink its retention window by the same factor and evict exactly the
 * crash context (`process.uncaughtException`, `mem-sample`, `activity-span`)
 * that incidents are read from. The separate sink self-rotates on every write
 * (the daemon log only checks its size when `queue.ts` emits a job event, so a
 * high-frequency writer could overshoot it between jobs). Join the two streams
 * on `jobId` + `pid`.
 *
 * ## Peak sampling
 *
 * Each phase owns exactly one `createSpanRssTracker()` instance (per-instance
 * closure state — see mem-sampler.ts), so overlapping phases from concurrent
 * jobs cannot clobber one another's high-water mark. The tracker is polled by
 * an `.unref()`-ed interval **and** by explicit `sample()` calls the caller
 * places inside its own loops.
 *
 * The interval only fires when the phase yields to the event loop. A phase that
 * is one blocking native call (a LanceDB compaction, a local ONNX embed) cannot
 * be sampled from JavaScript at all, and for those phases `peakRssBytes` is
 * effectively `max(entry, exit)` — call sites say so at the point of use rather
 * than implying the peak is meaningful.
 */

import { join } from "node:path";
import { config } from "../config.js";
import { diagEmitTo } from "./events.js";
import { rotateIfNeeded } from "./log-rotate.js";
import { createSpanRssTracker } from "./mem-sampler.js";

// ─── Config ────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** RSS poll cadence while a phase is in flight. 0 disables the poll timer. */
const PHASE_RSS_POLL_MS = envInt("SCRYBE_PHASE_RSS_POLL_MS", 250);

/**
 * How long a segmented phase runs before it flushes an interim record.
 * Bounds phase-log volume to ~(duration / this) records for the streaming
 * phase regardless of how many batches it processes. 0 disables segmenting
 * (one record at phase end only).
 */
const PHASE_SEGMENT_MS = envInt("SCRYBE_PHASE_SEGMENT_MS", 15_000);

const PHASE_LOG_MAX_BYTES = envInt("SCRYBE_PHASE_LOG_MAX_BYTES", 16 * 1024 * 1024);
const PHASE_LOG_BACKUPS = envInt("SCRYBE_PHASE_LOG_BACKUPS", 3);

/** Set to "0" to turn the phase log off entirely. Always-on by default. */
function phaseTelemetryEnabled(): boolean {
  return process.env["SCRYBE_PHASE_TELEMETRY"] !== "0";
}

export function phaseLogPath(): string {
  return process.env["SCRYBE_PHASE_LOG_PATH"] ?? join(config.dataDir, "phase-log.jsonl");
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type PhaseWork = Record<string, number | string | boolean | null>;

export type PhaseOutcome = "ok" | "error" | "cancelled";

/** Identity carried on every record of one indexing job, so records can be joined. */
export interface PhaseJobContext {
  projectId: string;
  sourceId: string;
  /** Daemon job id when the index runs under the job runner; null for direct CLI calls. */
  jobId: string | null;
  branch: string;
  mode: string;
}

export interface PhaseHandle {
  /**
   * Fold a fresh RSS reading into this phase's peak. Cheap
   * (`process.memoryUsage.rss()`); safe to call from a per-file / per-batch
   * loop, but not from a per-chunk one.
   */
  sample(): void;
  /** Merge phase-specific work counters into the record emitted at phase end. */
  setWork(work: PhaseWork): void;
}

export interface SegmentedPhase extends PhaseHandle {
  /** Add to the current segment's running counters (reset at each segment boundary). */
  addWork(delta: Record<string, number>): void;
  /**
   * Flush an interim record if the current segment has run longer than
   * SCRYBE_PHASE_SEGMENT_MS. Call at a natural boundary (end of a batch), never
   * mid-batch — the record's counters describe completed work only.
   */
  maybeRoll(): void;
  /** Emit the final record for this phase and stop the poll timer. Idempotent. */
  end(outcome?: PhaseOutcome): void;
}

// ─── Emit ──────────────────────────────────────────────────────────────────

function emitPhaseRecord(record: Record<string, unknown>): void {
  if (!phaseTelemetryEnabled()) return;
  const path = phaseLogPath();
  rotateIfNeeded(path, PHASE_LOG_MAX_BYTES, PHASE_LOG_BACKUPS);
  // diagEmitTo owns the `ts` + `pid` stamp — there is exactly one pid constant
  // in the codebase and it lives in events.ts.
  diagEmitTo(path, record);
}

function buildRecord(
  ctx: PhaseJobContext,
  phase: string,
  seq: number,
  final: boolean,
  startRssBytes: number,
  peakRssBytes: number,
  endRssBytes: number,
  startedAt: number,
  outcome: PhaseOutcome,
  work: PhaseWork,
): Record<string, unknown> {
  return {
    event: "indexer.phase",
    level: "info",
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    jobId: ctx.jobId,
    branch: ctx.branch,
    mode: ctx.mode,
    phase,
    seq,
    final,
    outcome,
    startRssBytes,
    peakRssBytes,
    endRssBytes,
    durationMs: Date.now() - startedAt,
    work,
  };
}

function outcomeForError(err: unknown): PhaseOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return message === "INDEX_CANCELLED" ? "cancelled" : "error";
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run `fn` as one instrumented phase. The record is emitted in a `finally`, so
 * it lands whether the phase returns, throws, or is cancelled — the only way to
 * lose it is the process dying inside the phase, which is precisely the signal
 * ("last record on disk names the phase that was running when we were killed").
 */
export async function withPhase<T>(
  ctx: PhaseJobContext,
  phase: string,
  fn: (handle: PhaseHandle) => Promise<T>,
): Promise<T> {
  const startRss = process.memoryUsage.rss();
  const tracker = createSpanRssTracker(startRss);
  const startedAt = Date.now();
  let work: PhaseWork = {};
  let outcome: PhaseOutcome = "ok";

  const handle: PhaseHandle = {
    sample() { tracker.sampleRss(); },
    setWork(w) { work = { ...work, ...w }; },
  };

  const timer = PHASE_RSS_POLL_MS > 0
    ? setInterval(() => tracker.sampleRss(), PHASE_RSS_POLL_MS)
    : null;
  // Must never hold the event loop open on its own — the daemon exits when all
  // other refs are released.
  timer?.unref();

  try {
    return await fn(handle);
  } catch (err) {
    outcome = outcomeForError(err);
    throw err;
  } finally {
    if (timer) clearInterval(timer);
    const endRss = tracker.sampleRss();
    emitPhaseRecord(
      buildRecord(ctx, phase, 0, true, startRss, tracker.peakRssBytes(), endRss, startedAt, outcome, work),
    );
  }
}

/**
 * Start a phase that emits interim records on a time cadence instead of only
 * at the end.
 *
 * Used for the streaming chunk/embed/upsert loop, which is where a job spends
 * essentially all of its time and allocates essentially all of its memory. A
 * single record at loop end would reproduce the exact blind spot this plan
 * removes; segments make growth locatable inside the loop and survive a kill.
 *
 * The caller MUST call `end()` on every exit path (use try/finally) — that is
 * what clears the poll timer.
 */
export function startSegmentedPhase(ctx: PhaseJobContext, phase: string): SegmentedPhase {
  let seq = 0;
  let ended = false;
  let segmentStartRss = process.memoryUsage.rss();
  let segmentStartedAt = Date.now();
  let tracker = createSpanRssTracker(segmentStartRss);
  let segmentWork: Record<string, number> = {};
  let staticWork: PhaseWork = {};

  const timer = PHASE_RSS_POLL_MS > 0
    ? setInterval(() => tracker.sampleRss(), PHASE_RSS_POLL_MS)
    : null;
  timer?.unref();

  function flush(final: boolean, outcome: PhaseOutcome): void {
    const endRss = tracker.sampleRss();
    emitPhaseRecord(
      buildRecord(
        ctx, phase, seq, final,
        segmentStartRss, tracker.peakRssBytes(), endRss, segmentStartedAt, outcome,
        { ...staticWork, ...segmentWork },
      ),
    );
    seq++;
    // Each segment gets a fresh tracker so its peak is its own, not the whole
    // phase's running max — otherwise every segment after the first would
    // report the same inherited high-water mark.
    segmentStartRss = endRss;
    segmentStartedAt = Date.now();
    tracker = createSpanRssTracker(segmentStartRss);
    segmentWork = {};
  }

  return {
    sample() { tracker.sampleRss(); },
    setWork(w) { staticWork = { ...staticWork, ...w }; },
    addWork(delta) {
      for (const [k, v] of Object.entries(delta)) {
        segmentWork[k] = (segmentWork[k] ?? 0) + v;
      }
    },
    maybeRoll() {
      if (ended) return;
      if (PHASE_SEGMENT_MS === 0) return;
      if (Date.now() - segmentStartedAt < PHASE_SEGMENT_MS) return;
      flush(false, "ok");
    },
    end(outcome: PhaseOutcome = "ok") {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      flush(true, outcome);
    },
  };
}

/**
 * Record what a job was told to do, emitted twice per job:
 *
 *   - `started` — before the scan, so a job that dies during the scan is still
 *     distinguishable from a job that never ran. Counts are unknown here.
 *   - `planned` — right after the hash diff, carrying what the scan found and
 *     what the job decided to process.
 *
 * "Processed nothing but allocated GB" is the single most interesting case in
 * this data, and without `started` it is indistinguishable from "record never
 * written".
 */
export function emitJobIntent(
  ctx: PhaseJobContext,
  stage: "started" | "planned",
  detail: PhaseWork = {},
): void {
  emitPhaseRecord({
    event: "indexer.job.intent",
    level: "info",
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    jobId: ctx.jobId,
    branch: ctx.branch,
    mode: ctx.mode,
    stage,
    rssBytes: process.memoryUsage.rss(),
    ...detail,
  });
}
