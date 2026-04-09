import { randomBytes } from "crypto";
import { indexProject, indexSource } from "./indexer.js";
import type { IndexMode, JobState } from "./types.js";

const _jobs = new Map<string, JobState & { controller: AbortController }>();

function newJobId(): string {
  return randomBytes(4).toString("hex");
}

function makeState(
  projectId: string,
  mode: IndexMode,
  sourceId?: string
): JobState & { controller: AbortController } {
  const controller = new AbortController();
  return {
    job_id: randomBytes(4).toString("hex"),
    project_id: projectId,
    source_id: sourceId,
    mode,
    status: "running",
    phase: "scanning",
    files_scanned: 0,
    chunks_indexed: 0,
    started_at: Date.now(),
    finished_at: null,
    error: null,
    controller,
  };
}

function handleError(job: JobState & { controller: AbortController }, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "INDEX_CANCELLED") {
    job.status = "cancelled";
  } else {
    job.status = "failed";
    const status = (err as { status?: number })?.status;
    if (status === 429 || /429/.test(message)) {
      job.error =
        "Embedding API rate limit exceeded. Wait a minute and retry reindex, " +
        "or check your embedding provider's rate limit tier " +
        "(Voyage AI requires a payment method on file to unlock standard limits).";
    } else {
      job.error = message;
    }
  }
  job.finished_at = Date.now();
}

/** Submit a background job to reindex all sources in a project. */
export function submitJob(projectId: string, mode: IndexMode): string {
  const state = makeState(projectId, mode);
  const jobId = state.job_id;
  _jobs.set(jobId, state);

  // Run async, don't await
  indexProject(projectId, mode, {
    signal: state.controller.signal,
    onScanProgress(filesScanned) {
      const job = _jobs.get(jobId);
      if (job) { job.files_scanned = filesScanned; job.phase = "scanning"; }
    },
    onEmbedProgress(chunksIndexed) {
      const job = _jobs.get(jobId);
      if (job) { job.chunks_indexed = chunksIndexed; job.phase = "embedding"; }
    },
  })
    .then((results) => {
      const job = _jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.phase = "done";
        job.chunks_indexed = results.reduce((sum, r) => sum + r.chunks_indexed, 0);
        job.files_scanned = results.reduce((sum, r) => sum + r.files_scanned, 0);
        job.finished_at = Date.now();
      }
    })
    .catch((err: unknown) => {
      const job = _jobs.get(jobId);
      if (job) handleError(job, err);
    });

  return jobId;
}

/** Submit a background job to reindex a single source. */
export function submitSourceJob(projectId: string, sourceId: string, mode: IndexMode): string {
  const state = makeState(projectId, mode, sourceId);
  const jobId = state.job_id;
  _jobs.set(jobId, state);

  indexSource(projectId, sourceId, mode, {
    signal: state.controller.signal,
    onScanProgress(filesScanned) {
      const job = _jobs.get(jobId);
      if (job) { job.files_scanned = filesScanned; job.phase = "scanning"; }
    },
    onEmbedProgress(chunksIndexed) {
      const job = _jobs.get(jobId);
      if (job) { job.chunks_indexed = chunksIndexed; job.phase = "embedding"; }
    },
  })
    .then((result) => {
      const job = _jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.phase = "done";
        job.chunks_indexed = result.chunks_indexed;
        job.files_scanned = result.files_scanned;
        job.finished_at = Date.now();
      }
    })
    .catch((err: unknown) => {
      const job = _jobs.get(jobId);
      if (job) handleError(job, err);
    });

  return jobId;
}

export function getJobStatus(jobId: string): Omit<JobState, never> | null {
  const job = _jobs.get(jobId);
  if (!job) return null;
  const { controller: _c, ...state } = job;
  return state;
}

export function cancelJob(jobId: string): boolean {
  const job = _jobs.get(jobId);
  if (!job || job.status !== "running") return false;
  job.controller.abort();
  return true;
}
