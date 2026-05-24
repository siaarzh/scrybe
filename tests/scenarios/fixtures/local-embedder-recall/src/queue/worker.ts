/**
 * Background job worker with concurrency control and retry logic.
 * Workers pull jobs from a shared queue and execute handler functions.
 */

export type JobStatus = "pending" | "running" | "completed" | "failed" | "retrying";

export interface Job<T = unknown> {
  id: string;
  type: string;
  payload: T;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  runAt: number;         // earliest time the job may start (for delayed jobs)
  lastError?: string;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  maxRetries: number;
  backoffBaseMs: number;
}

const DEFAULT_CONFIG: WorkerConfig = {
  concurrency: 5,
  pollIntervalMs: 1_000,
  maxRetries: 3,
  backoffBaseMs: 1_000,
};

/** Compute exponential backoff delay for a given attempt number. */
export function backoffDelay(attempt: number, baseMs: number): number {
  return baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * baseMs * 0.1);
}

/** In-memory job queue for testing. Production uses a DB-backed queue. */
export class InMemoryJobQueue {
  private _jobs: Job[] = [];

  enqueue<T>(type: string, payload: T, opts: { priority?: number; delayMs?: number; maxAttempts?: number } = {}): Job<T> {
    const job: Job<T> = {
      id: Math.random().toString(36).slice(2),
      type,
      payload,
      priority: opts.priority ?? 0,
      status: "pending",
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? DEFAULT_CONFIG.maxRetries + 1,
      createdAt: Date.now(),
      runAt: Date.now() + (opts.delayMs ?? 0),
    };
    this._jobs.push(job as unknown as Job);
    return job;
  }

  /** Claim the next runnable job. Returns null if none available. */
  claimNext(): Job | null {
    const now = Date.now();
    const idx = this._jobs
      .map((j, i) => [i, j] as const)
      .filter(([, j]) => j.status === "pending" && j.runAt <= now)
      .sort(([, a], [, b]) => b.priority - a.priority || a.createdAt - b.createdAt)[0]?.[0];

    if (idx === undefined) return null;
    const job = this._jobs[idx]!;
    job.status = "running";
    job.attempts++;
    return job;
  }

  markCompleted(id: string): void {
    const job = this._jobs.find((j) => j.id === id);
    if (job) job.status = "completed";
  }

  markFailed(id: string, error: string, retry: boolean): void {
    const job = this._jobs.find((j) => j.id === id);
    if (!job) return;
    job.lastError = error;
    if (retry && job.attempts < job.maxAttempts) {
      job.status = "retrying";
      job.runAt = Date.now() + backoffDelay(job.attempts, DEFAULT_CONFIG.backoffBaseMs);
      // reset to pending so it can be claimed again
      setTimeout(() => { if (job.status === "retrying") job.status = "pending"; }, job.runAt - Date.now());
    } else {
      job.status = "failed";
    }
  }
}
