/**
 * Dead-letter queue (DLQ) for permanently failed jobs.
 * Failed jobs are moved here for inspection, alerting, and optional redriving.
 */
import type { Job } from "./worker.js";

export interface DeadLetterEntry {
  originalJobId: string;
  jobType: string;
  payload: unknown;
  failureReason: string;
  attempts: number;
  movedAt: number;
  redrivable: boolean;
}

const _dlq: DeadLetterEntry[] = [];

/**
 * Move a permanently failed job to the dead-letter queue.
 * Called when a job exceeds its maxAttempts.
 */
export function moveToDeadLetter(job: Job, failureReason: string): DeadLetterEntry {
  const entry: DeadLetterEntry = {
    originalJobId: job.id,
    jobType: job.type,
    payload: job.payload,
    failureReason,
    attempts: job.attempts,
    movedAt: Date.now(),
    redrivable: true,
  };
  _dlq.push(entry);
  return entry;
}

/**
 * List entries in the DLQ with optional filtering by job type.
 */
export function listDeadLetterEntries(
  opts: { jobType?: string; limit?: number } = {}
): DeadLetterEntry[] {
  let results = opts.jobType
    ? _dlq.filter((e) => e.jobType === opts.jobType)
    : [..._dlq];
  if (opts.limit) results = results.slice(-opts.limit);
  return results;
}

/**
 * Redrive a dead-letter entry back to the main queue.
 * Returns the re-enqueued job ID, or null if the entry is not redrivable.
 */
export function redrive(
  originalJobId: string,
  enqueue: (type: string, payload: unknown) => string
): string | null {
  const entry = _dlq.find((e) => e.originalJobId === originalJobId);
  if (!entry || !entry.redrivable) return null;

  entry.redrivable = false;   // prevent double-redrive
  return enqueue(entry.jobType, entry.payload);
}

/** Purge old DLQ entries older than the given threshold. Returns count removed. */
export function purgeDeadLetterOlderThan(thresholdMs: number): number {
  const cutoff = Date.now() - thresholdMs;
  const before = _dlq.length;
  _dlq.splice(0, _dlq.length, ..._dlq.filter((e) => e.movedAt >= cutoff));
  return before - _dlq.length;
}

/** Compute DLQ statistics by job type. */
export function deadLetterStats(): Record<string, { count: number; oldest: number }> {
  const stats: Record<string, { count: number; oldest: number }> = {};
  for (const entry of _dlq) {
    const s = stats[entry.jobType] ?? { count: 0, oldest: Infinity };
    s.count++;
    s.oldest = Math.min(s.oldest, entry.movedAt);
    stats[entry.jobType] = s;
  }
  return stats;
}
