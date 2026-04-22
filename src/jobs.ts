import { randomBytes } from "crypto";
import { indexProject, indexSource } from "./indexer.js";
import { listProjects, getProject } from "./registry.js";
import type { IndexMode, JobState, SourceTask } from "./types.js";

type StoredJob = JobState & {
  controller: AbortController;
  taskControllers: Map<string, AbortController>;
  branch?: string;
};

const _jobs = new Map<string, StoredJob>();

function classifyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  if (status === 429 || /429/.test(message)) {
    return (
      "Embedding API rate limit exceeded. Wait a minute and retry reindex, " +
      "or check your embedding provider's rate limit tier " +
      "(Voyage AI requires a payment method on file to unlock standard limits)."
    );
  }
  return message;
}

function makePendingTask(sourceId: string, mode: IndexMode): SourceTask {
  return {
    source_id: sourceId,
    mode,
    status: "pending",
    phase: null,
    files_scanned: 0,
    chunks_indexed: 0,
    started_at: null,
    finished_at: null,
    error: null,
  };
}

function findRunningJobForProject(projectId: string): string | undefined {
  for (const [jobId, job] of _jobs) {
    if (job.project_id === projectId && job.status === "running") {
      return jobId;
    }
  }
  return undefined;
}

function finalizeJobStatus(job: StoredJob): void {
  const tasks = job.tasks;
  const anyFailed = tasks.some((t) => t.status === "failed");
  const anyCancelled = tasks.some((t) => t.status === "cancelled");
  if (anyFailed) {
    job.status = "failed";
  } else if (anyCancelled) {
    job.status = "cancelled";
  } else {
    job.status = "done";
  }
  job.finished_at = Date.now();
}

async function runTasks(jobId: string): Promise<void> {
  const job = _jobs.get(jobId);
  if (!job) return;

  for (const task of job.tasks) {
    // Check shared abort signal before starting each task
    if (job.controller.signal.aborted) {
      // Mark this task and all remaining as cancelled
      for (const t of job.tasks) {
        if (t.status === "pending" || t.status === "running") {
          t.status = "cancelled";
          t.finished_at = Date.now();
        }
      }
      break;
    }

    if (task.status !== "pending") continue;

    const taskController = job.taskControllers.get(task.source_id)!;

    // Forward shared abort to task abort
    job.controller.signal.addEventListener("abort", () => taskController.abort(), { once: true });

    task.status = "running";
    task.started_at = Date.now();
    task.phase = "scanning";

    try {
      const result = await indexSource(job.project_id, task.source_id, task.mode, {
        signal: taskController.signal,
        branch: job.branch,
        onScanProgress(n) {
          task.files_scanned = n;
          task.phase = "scanning";
        },
        onEmbedProgress(n) {
          task.chunks_indexed = n;
          task.phase = "embedding";
        },
      });
      task.status = "done";
      task.phase = "done";
      task.files_scanned = result.files_scanned;
      task.chunks_indexed = result.chunks_indexed;
      task.finished_at = Date.now();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "INDEX_CANCELLED") {
        task.status = "cancelled";
        task.finished_at = Date.now();
      } else {
        task.status = "failed";
        task.error = classifyErrorMessage(err);
        task.finished_at = Date.now();
      }
    }
  }

  const j = _jobs.get(jobId);
  if (j && j.status === "running") {
    finalizeJobStatus(j);
  }
}

/**
 * Submit a background job to reindex one or more sources in a project.
 * - mode "full" requires explicit sourceIds
 * - If a running job for this project exists, returns { error, job_id } instead of throwing
 */
export function submitJob(
  projectId: string,
  mode: IndexMode,
  sourceIds?: string[],
  branch?: string
): string | { error: "already_running"; job_id: string } {
  if (mode === "full" && !sourceIds?.length) {
    throw new Error("full reindex requires explicit source_ids");
  }

  const existingJobId = findRunningJobForProject(projectId);
  if (existingJobId) {
    return { error: "already_running", job_id: existingJobId };
  }

  // Determine sources to run
  let sources: string[];
  if (sourceIds?.length) {
    sources = sourceIds;
  } else {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project '${projectId}' not found`);
    sources = project.sources.map((s) => s.source_id);
  }

  const controller = new AbortController();
  const taskControllers = new Map<string, AbortController>();
  for (const sid of sources) {
    taskControllers.set(sid, new AbortController());
  }

  const tasks: SourceTask[] = sources.map((sid) => makePendingTask(sid, mode));

  const job: StoredJob = {
    job_id: randomBytes(4).toString("hex"),
    project_id: projectId,
    mode,
    status: "running",
    tasks,
    started_at: Date.now(),
    finished_at: null,
    error: null,
    controller,
    taskControllers,
    ...(branch && { branch }),
  };

  _jobs.set(job.job_id, job);

  // Fire-and-forget
  runTasks(job.job_id).catch((err: unknown) => {
    const j = _jobs.get(job.job_id);
    if (j && j.status === "running") {
      j.status = "failed";
      j.error = classifyErrorMessage(err);
      j.finished_at = Date.now();
    }
  });

  return job.job_id;
}

/** Submit a background job to reindex a single source. */
export function submitSourceJob(
  projectId: string,
  sourceId: string,
  mode: IndexMode,
  branch?: string
): string | { error: "already_running"; job_id: string } {
  const existingJobId = findRunningJobForProject(projectId);
  if (existingJobId) {
    return { error: "already_running", job_id: existingJobId };
  }

  const controller = new AbortController();
  const taskControllers = new Map<string, AbortController>();
  taskControllers.set(sourceId, new AbortController());

  const job: StoredJob = {
    job_id: randomBytes(4).toString("hex"),
    project_id: projectId,
    source_id: sourceId,
    mode,
    status: "running",
    tasks: [makePendingTask(sourceId, mode)],
    started_at: Date.now(),
    finished_at: null,
    error: null,
    controller,
    taskControllers,
    ...(branch && { branch }),
  };

  _jobs.set(job.job_id, job);

  runTasks(job.job_id).catch((err: unknown) => {
    const j = _jobs.get(job.job_id);
    if (j && j.status === "running") {
      j.status = "failed";
      j.error = classifyErrorMessage(err);
      j.finished_at = Date.now();
    }
  });

  return job.job_id;
}

/** Submit a background job to incrementally reindex all registered projects. */
export function submitAllJob(): string {
  const controller = new AbortController();

  const job: StoredJob = {
    job_id: randomBytes(4).toString("hex"),
    project_id: "*",
    mode: "incremental",
    status: "running",
    tasks: [],
    started_at: Date.now(),
    finished_at: null,
    error: null,
    current_project: undefined,
    controller,
    taskControllers: new Map(),
  };

  _jobs.set(job.job_id, job);

  (async () => {
    const projects = listProjects();
    const failed: { project: string; error: string }[] = [];

    for (const p of projects) {
      const j = _jobs.get(job.job_id);
      if (!j || j.status !== "running") break;

      j.current_project = p.id;

      try {
        await indexProject(p.id, "incremental", {
          signal: controller.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cancel = abort everything
        if (msg === "INDEX_CANCELLED") {
          const jj = _jobs.get(job.job_id);
          if (jj) {
            jj.status = "cancelled";
            jj.finished_at = Date.now();
          }
          return;
        }
        failed.push({ project: p.id, error: msg });
      }
    }

    const j = _jobs.get(job.job_id);
    if (j && j.status === "running") {
      j.status = failed.length > 0 ? "failed" : "done";
      j.current_project = undefined;
      j.finished_at = Date.now();
      if (failed.length > 0) {
        j.error = `${failed.length} project(s) failed: ${failed.map((f) => `${f.project}: ${f.error}`).join("; ")}`;
      }
    }
  })().catch((err: unknown) => {
    const j = _jobs.get(job.job_id);
    if (j && j.status === "running") {
      j.status = "failed";
      j.error = classifyErrorMessage(err);
      j.finished_at = Date.now();
    }
  });

  return job.job_id;
}

export function getJobStatus(jobId: string): JobState | null {
  const job = _jobs.get(jobId);
  if (!job) return null;
  // Strip internal controller fields
  const { controller: _c, taskControllers: _tc, ...state } = job;
  return state;
}

export function cancelJob(jobId: string, sourceId?: string): boolean {
  const job = _jobs.get(jobId);
  if (!job || job.status !== "running") return false;

  if (sourceId) {
    const task = job.tasks.find((t) => t.source_id === sourceId);
    if (!task || (task.status !== "pending" && task.status !== "running")) return false;
    const tc = job.taskControllers.get(sourceId);
    if (tc) tc.abort();
    task.status = "cancelled";
    task.finished_at = Date.now();
    return true;
  }

  // Cancel entire job
  job.controller.abort();
  return true;
}

/** Abort all currently running jobs. Used by SIGTERM/SIGINT handlers. */
export function cancelAllJobs(): void {
  for (const job of _jobs.values()) {
    if (job.status === "running") {
      job.controller.abort();
      for (const tc of job.taskControllers.values()) {
        tc.abort();
      }
    }
  }
}

/** List all jobs, optionally filtered by status. Sorted by started_at descending. */
export function listJobs(statusFilter?: string): JobState[] {
  const all: JobState[] = [];
  for (const job of _jobs.values()) {
    const { controller: _c, taskControllers: _tc, ...state } = job;
    all.push(state);
  }
  const filtered = statusFilter ? all.filter((j) => j.status === statusFilter) : all;
  return filtered.sort((a, b) => b.started_at - a.started_at);
}
