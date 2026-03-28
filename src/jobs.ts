import { randomBytes } from "crypto";
import { indexProject } from "./indexer.js";
import type { IndexMode, JobState } from "./types.js";

const _jobs = new Map<string, JobState & { controller: AbortController }>();

function newJobId(): string {
  return randomBytes(4).toString("hex");
}

export function submitJob(projectId: string, mode: IndexMode): string {
  const jobId = newJobId();
  const controller = new AbortController();

  const state: JobState & { controller: AbortController } = {
    job_id: jobId,
    project_id: projectId,
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
  _jobs.set(jobId, state);

  // Run async, don't await
  indexProject(projectId, mode, {
    signal: controller.signal,
    onScanProgress(filesScanned) {
      const job = _jobs.get(jobId);
      if (job) {
        job.files_scanned = filesScanned;
        job.phase = "scanning";
      }
    },
    onEmbedProgress(chunksIndexed) {
      const job = _jobs.get(jobId);
      if (job) {
        job.chunks_indexed = chunksIndexed;
        job.phase = "embedding";
      }
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
      if (!job) return;
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
    });

  return jobId;
}

export function getJobStatus(jobId: string): Omit<JobState, never> | null {
  const job = _jobs.get(jobId);
  if (!job) return null;
  // Return a copy without the controller
  const { controller: _c, ...state } = job;
  return state;
}

export function cancelJob(jobId: string): boolean {
  const job = _jobs.get(jobId);
  if (!job || job.status !== "running") return false;
  job.controller.abort();
  return true;
}
