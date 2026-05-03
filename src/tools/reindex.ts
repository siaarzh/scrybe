import type { Command } from "commander";
import {
  listProjects,
  getProject,
} from "../registry.js";
import {
  submitJob,
  submitSourceJob,
  submitAllJob,
  getJobStatus,
  cancelJob,
  listJobs,
} from "../jobs.js";
import { getQueueStatus } from "../jobs-store.js";
import { ensureRunning, DaemonClient } from "../daemon/client.js";
import { config } from "../config.js";
import type { IndexMode } from "../types.js";
import type { Tool } from "./types.js";

function requireEmbedding(): string | null {
  return config.embeddingConfigError ?? null;
}

export const reindexAllTool: Tool<
  Record<string, never>,
  { job_id: string; status: string; project_count: number; mode: string }
> = {
  spec: {
    name: "reindex_all",
    description: "Incrementally reindex all registered projects (all sources) in the background. Returns a job_id to poll with reindex_status.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  handler: async () => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const jobId = submitAllJob();
    return { job_id: jobId, status: "started", project_count: listProjects().length, mode: "incremental" };
  },
};

export const reindexProjectTool: Tool<
  { project_id: string; mode?: string; source_ids?: string[]; branch?: string },
  { job_id: string; status: string; project_id: string; mode: string }
> = {
  spec: {
    name: "reindex_project",
    description: "Trigger background reindexing of all sources in a project. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        mode: { type: "string", enum: ["full", "incremental"], default: "incremental" },
        source_ids: { type: "array", items: { type: "string" }, description: "Sources to reindex. Required when mode is 'full'." },
        branch: { type: "string", description: "Branch to index for code sources (default: current HEAD)" },
      },
      required: ["project_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  handler: async ({ project_id, mode, source_ids, branch }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const m: IndexMode = mode === "full" ? "full" : "incremental";
    if (m === "full" && !source_ids?.length) {
      throw new Error("source_ids is required for mode: full");
    }
    if (!getProject(project_id)) throw new Error(`Project '${project_id}' not found`);

    // Route through daemon when available (prevents cross-process write races)
    const daemon = await ensureRunning();
    if (daemon.ok) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        const resp = await client.submitReindex({ projectId: project_id, sourceId: source_ids?.[0], branch, mode: m });
        const job = resp.jobs[0];
        if (!job) throw new Error("Daemon returned no job");
        return {
          job_id: job.jobId,
          status: job.status ?? "started",
          project_id,
          mode: m,
          ...(job.queuePosition != null && { queue_position: job.queuePosition }),
          ...(job.duplicateOfPending && { duplicate_of_pending: true }),
        };
      }
    }

    // In-process fallback (container / opted-out / daemon unavailable)
    if (!daemon.ok && (daemon.reason === "spawn-failed" || daemon.reason === "health-timeout")) {
      throw Object.assign(new Error(
        "The scrybe daemon failed to start. Reindex requires the daemon to coordinate writes.\n" +
        "Diagnose: scrybe doctor  |  Single-shot: SCRYBE_NO_AUTO_DAEMON=1 scrybe index ..."
      ), { error_type: "daemon_unavailable" });
    }
    const jobResult = submitJob(project_id, m, source_ids, branch);
    if (typeof jobResult === "object" && "error" in jobResult) {
      throw new Error(`A reindex job is already running for this project (job: ${jobResult.job_id})`);
    }
    return { job_id: jobResult, status: "started", project_id, mode: m };
  },
};

export const reindexSourceTool: Tool<
  { project_id: string; source_id: string; mode?: string; branch?: string },
  { job_id: string; status: string; project_id: string; source_id: string; mode: string }
> = {
  spec: {
    name: "reindex_source",
    description: "Trigger background reindexing of a single source. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
        mode: { type: "string", enum: ["full", "incremental"], default: "incremental" },
        branch: { type: "string", description: "Branch to index for code sources (default: current HEAD)" },
      },
      required: ["project_id", "source_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  handler: async ({ project_id, source_id, mode, branch }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const m: IndexMode = mode === "full" ? "full" : "incremental";
    if (!getProject(project_id)) throw new Error(`Project '${project_id}' not found`);

    // Route through daemon when available
    const daemon = await ensureRunning();
    if (daemon.ok) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        const resp = await client.submitReindex({ projectId: project_id, sourceId: source_id, branch, mode: m });
        const job = resp.jobs[0];
        if (!job) throw new Error("Daemon returned no job");
        return {
          job_id: job.jobId,
          status: job.status ?? "started",
          project_id,
          source_id,
          mode: m,
          ...(job.queuePosition != null && { queue_position: job.queuePosition }),
          ...(job.duplicateOfPending && { duplicate_of_pending: true }),
        };
      }
    }

    if (!daemon.ok && (daemon.reason === "spawn-failed" || daemon.reason === "health-timeout")) {
      throw Object.assign(new Error(
        "The scrybe daemon failed to start. Reindex requires the daemon to coordinate writes.\n" +
        "Diagnose: scrybe doctor  |  Single-shot: SCRYBE_NO_AUTO_DAEMON=1 scrybe index ..."
      ), { error_type: "daemon_unavailable" });
    }
    const sourceJobResult = submitSourceJob(project_id, source_id, m, branch);
    if (typeof sourceJobResult === "object" && "error" in sourceJobResult) {
      throw new Error(`A reindex job is already running for this project (job: ${sourceJobResult.job_id})`);
    }
    return { job_id: sourceJobResult, status: "started", project_id, source_id, mode: m };
  },
};

export const reindexStatusTool: Tool<
  { job_id: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
> = {
  spec: {
    name: "reindex_status",
    description: "Get the status of a background reindex job",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ job_id }) => {
    const status = getJobStatus(job_id);
    if (status) {
      if (status.status === "done" && status.project_id === "*") {
        const projects = listProjects().map((p) => ({
          project_id: p.id,
          sources: p.sources.map((s) => ({ source_id: s.source_id, last_indexed: s.last_indexed })),
        }));
        return { ...status, projects };
      }
      return status;
    }

    // Try daemon's SQLite (cross-process jobs)
    const client = DaemonClient.fromPidfile();
    if (client) {
      try {
        const row = await client.jobStatus(job_id);
        if (row) return row;
      } catch { /* daemon may not be running */ }
    }

    throw new Error(`Job '${job_id}' not found`);
  },
};

export const cancelReindexTool: Tool<
  { job_id: string; source_id?: string },
  { job_id: string; cancelled: boolean }
> = {
  spec: {
    name: "cancel_reindex",
    description: "Cancel a running reindex job",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        source_id: { type: "string", description: "Cancel only this source (omit to cancel entire job)" },
      },
      required: ["job_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: false },
  },
  handler: async ({ job_id, source_id }) => {
    const cancelled = cancelJob(job_id, source_id);
    return { job_id, cancelled };
  },
};

export const listJobsTool: Tool<
  { status?: string },
  { jobs: ReturnType<typeof listJobs>; count: number }
> = {
  spec: {
    name: "list_jobs",
    cliName: "job list",
    description: "List background reindex jobs. Like 'docker ps' — shows all jobs or filter by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"], description: "Filter by status (omit for all jobs)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .option("--running", "Show only running jobs", false)
      .addHelpText("after", "\nExample:\n  scrybe job list"),
  },
  handler: async ({ status }) => {
    const jobs = listJobs(status);
    return { jobs, count: jobs.length };
  },
  cliOpts: ([opts]) => ({ status: opts.running ? "running" : undefined }),
  formatCli: ({ jobs }) => {
    if (jobs.length === 0) return "No jobs found.";
    return jobs.map((job) => {
      const elapsed = job.finished_at
        ? `${((job.finished_at - job.started_at) / 1000).toFixed(1)}s`
        : `${((Date.now() - job.started_at) / 1000).toFixed(1)}s (running)`;
      const jobType = (job as any).type ?? "reindex";
      const taskSummary = job.tasks.map((t: any) => `${t.source_id}:${t.status}`).join(", ");
      // For gc jobs, show result summary if available
      let detail = taskSummary || (job as any).current_project || "";
      if (jobType === "gc" && (job as any).result) {
        try {
          const r = JSON.parse((job as any).result as string) as { orphans_deleted: number; bytes_freed: number };
          detail = r.orphans_deleted > 0
            ? `${r.orphans_deleted} orphan${r.orphans_deleted === 1 ? "" : "s"}, ${(r.bytes_freed / 1024 / 1024).toFixed(1)} MB`
            : "0 orphans";
        } catch { /* ignore */ }
      }
      return `[${job.job_id}] ${job.project_id} | ${jobType} | ${job.status} | ${elapsed}${detail ? ` | ${detail}` : ""}`;
    }).join("\n");
  },
};

export const queueStatusTool: Tool<
  { project_id?: string },
  { running: unknown[]; queued: unknown[] }
> = {
  spec: {
    name: "queue_status",
    description:
      "Check what is currently running or queued in the reindex queue. " +
      "Before triggering a reindex, call this to see if the daemon already has a pending or in-flight job for the project — polling reindex_status on the existing job is cheaper than submitting a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter to a specific project (omit for all)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ project_id }) => {
    // Prefer daemon's view (includes jobs from all processes)
    const client = DaemonClient.fromPidfile();
    if (client) {
      try {
        return await client.queueStatus(project_id);
      } catch { /* daemon not running */ }
    }
    // In-process fallback
    try {
      return getQueueStatus(project_id);
    } catch {
      return { running: [], queued: [] };
    }
  },
};
