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
import { config } from "../config.js";
import type { IndexMode } from "../types.js";
import type { Tool, JobResult } from "./types.js";

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
    if (!status) throw new Error(`Job '${job_id}' not found (jobs are lost on server restart)`);
    if (status.status === "done" && status.project_id === "*") {
      const projects = listProjects().map((p) => ({
        project_id: p.id,
        sources: p.sources.map((s) => ({ source_id: s.source_id, last_indexed: s.last_indexed })),
      }));
      return { ...status, projects };
    }
    return status;
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
        status: { type: "string", enum: ["running", "done", "failed", "cancelled"], description: "Filter by status (omit for all jobs)" },
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
      const taskSummary = job.tasks.map((t: any) => `${t.source_id}:${t.status}`).join(", ");
      return `[${job.job_id}] ${job.project_id} | ${job.status} | ${elapsed} | ${taskSummary || job.current_project || ""}`;
    }).join("\n");
  },
};
