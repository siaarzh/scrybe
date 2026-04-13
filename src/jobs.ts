import { randomBytes } from "crypto";
import { indexProject, indexSource } from "./indexer.js";
import { listProjects } from "./registry.js";
import type { IndexMode, JobState } from "./types.js";

const _jobs = new Map<string, JobState & { controller: AbortController }>();

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

/** Submit a background job to incrementally reindex all registered projects. */
export function submitAllJob(): string {
  const state = makeState("*", "incremental");
  const jobId = state.job_id;
  _jobs.set(jobId, state);

  (async () => {
    const projects = listProjects();
    let totalChunks = 0;
    let totalFiles = 0;
    const failed: { project: string; error: string }[] = [];

    for (const p of projects) {
      const job = _jobs.get(jobId);
      if (!job || job.status !== "running") break;

      job.current_project = p.id;
      job.phase = "scanning";

      try {
        const results = await indexProject(p.id, "incremental", {
          signal: state.controller.signal,
          onScanProgress(filesScanned) {
            const j = _jobs.get(jobId);
            if (j) { j.files_scanned = totalFiles + filesScanned; j.phase = "scanning"; }
          },
          onEmbedProgress(chunksIndexed) {
            const j = _jobs.get(jobId);
            if (j) { j.chunks_indexed = totalChunks + chunksIndexed; j.phase = "embedding"; }
          },
        });
        totalChunks += results.reduce((sum, r) => sum + r.chunks_indexed, 0);
        totalFiles += results.reduce((sum, r) => sum + r.files_scanned, 0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cancel = abort everything, don't continue
        if (msg === "INDEX_CANCELLED") {
          const j = _jobs.get(jobId);
          if (j) handleError(j, err);
          return;
        }
        failed.push({ project: p.id, error: msg });
      }
    }

    const job = _jobs.get(jobId);
    if (job && job.status === "running") {
      job.status = "done";
      job.phase = "done";
      job.chunks_indexed = totalChunks;
      job.files_scanned = totalFiles;
      job.current_project = undefined;
      job.finished_at = Date.now();
      if (failed.length > 0) {
        job.error = `${failed.length} project(s) failed: ${failed.map(f => `${f.project}: ${f.error}`).join("; ")}`;
      }
    }
  })().catch((err: unknown) => {
    const job = _jobs.get(jobId);
    if (job) handleError(job, err);
  });

  return jobId;
}

export function getJobStatus(jobId: string): JobState | null {
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
