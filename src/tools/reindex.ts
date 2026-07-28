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
import { ensureRunning, DaemonClient, daemonWriteUnavailableError } from "../daemon/client.js";
import { deleteBranch, getChunkIdsForBranch } from "../branch-state.js";
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
  { project_id: string; mode?: string; source_ids?: string[]; branch?: string; content_ref?: string },
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
        content_ref: { type: "string", description: "Git ref to read content from (e.g. 'origin/dev'). When set, content is read from this ref while 'branch' remains the stored label. Defaults to 'branch'." },
      },
      required: ["project_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  handler: async ({ project_id, mode, source_ids, branch, content_ref }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const m: IndexMode = mode === "full" ? "full" : "incremental";
    if (m === "full" && !source_ids?.length) {
      throw new Error("source_ids is required for mode: full");
    }
    if (!getProject(project_id)) throw new Error(`Project '${project_id}' not found`);

    // Route through daemon when available (prevents cross-process write races)
    const daemon = await ensureRunning();
    if (daemon.ok && !daemon.draining) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        const resp = await client.submitReindex({ projectId: project_id, sourceId: source_ids?.[0], branch, mode: m, contentRef: content_ref });
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
    const unavailable = daemonWriteUnavailableError(daemon);
    if (unavailable) throw unavailable;
    const jobResult = submitJob(project_id, m, source_ids, branch, undefined, content_ref);
    if (typeof jobResult === "object" && "error" in jobResult) {
      throw new Error(`A reindex job is already running for this project (job: ${jobResult.job_id})`);
    }
    return { job_id: jobResult, status: "started", project_id, mode: m };
  },
};

export const reindexSourceTool: Tool<
  { project_id: string; source_id: string; mode?: string; branch?: string; content_ref?: string },
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
        content_ref: { type: "string", description: "Git ref to read content from (e.g. 'origin/dev'). When set, content is read from this ref while 'branch' remains the stored label. Defaults to 'branch'." },
      },
      required: ["project_id", "source_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  handler: async ({ project_id, source_id, mode, branch, content_ref }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const m: IndexMode = mode === "full" ? "full" : "incremental";
    if (!getProject(project_id)) throw new Error(`Project '${project_id}' not found`);

    // Route through daemon when available
    const daemon = await ensureRunning();
    if (daemon.ok && !daemon.draining) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        const resp = await client.submitReindex({ projectId: project_id, sourceId: source_id, branch, mode: m, contentRef: content_ref });
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

    const unavailable = daemonWriteUnavailableError(daemon);
    if (unavailable) throw unavailable;
    const sourceJobResult = submitSourceJob(project_id, source_id, m, branch, undefined, content_ref);
    if (typeof sourceJobResult === "object" && "error" in sourceJobResult) {
      throw new Error(`A reindex job is already running for this project (job: ${sourceJobResult.job_id})`);
    }
    return { job_id: sourceJobResult, status: "started", project_id, source_id, mode: m };
  },
};

// ─── index_ephemeral ────────────────────────────────────────────────────────
// Plan 99 Slice 3: index an open MR's remote branch under a throwaway
// "_ephemeral/" label so it can be searched without disturbing the project's
// normal indexed branches. scrybe never fetches — the caller (or an
// orchestrating agent) must fetch the ref first; the existing indexer guard
// ("... not found locally — fetch the ref first") surfaces if it hasn't been.

export const EPHEMERAL_PREFIX = "_ephemeral/";

/**
 * Derive the ephemeral label + content ref from the caller's `branch` input
 * (and optional `label` override).
 *
 * Rule (kept simple and predictable — see docs/mcp-reference.md):
 *   - If `branch` already looks like a full ref (starts with "refs/" or
 *     "origin/"), it is used as the contentRef verbatim, and the label is
 *     derived from its last path segment (e.g. "refs/scrybe-ephemeral/mr-42"
 *     -> "mr-42", "origin/feature-x" -> "feature-x").
 *   - Otherwise `branch` is treated as a plain branch name that has already
 *     been fetched; contentRef defaults to "origin/<branch>" and the label
 *     defaults to "mr-<branch>".
 *   - In both cases the label is always forced under the "_ephemeral/"
 *     prefix (caller-supplied `label` included) so teardown (drop_ephemeral)
 *     and the daemon startup sweep can find it.
 */
export function planEphemeralIndex(branch: string, labelOverride?: string): { label: string; contentRef: string } {
  const isFullRef = branch.startsWith("refs/") || branch.startsWith("origin/");
  const contentRef = isFullRef ? branch : `origin/${branch}`;

  let base: string;
  if (labelOverride) {
    base = labelOverride;
  } else if (isFullRef) {
    const shortName = branch.split("/").filter(Boolean).pop() || branch;
    base = `mr-${shortName}`;
  } else {
    base = `mr-${branch}`;
  }

  const label = base.startsWith(EPHEMERAL_PREFIX) ? base : `${EPHEMERAL_PREFIX}${base}`;
  return { label, contentRef };
}

async function pollInProcessJob(jobId: string, timeoutMs = 10 * 60_000): Promise<ReturnType<typeof getJobStatus>> {
  const deadline = Date.now() + timeoutMs;
  let status = getJobStatus(jobId);
  while (Date.now() < deadline) {
    status = getJobStatus(jobId);
    if (status && (status.status === "done" || status.status === "failed" || status.status === "cancelled")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return status;
}

async function pollDaemonJob(client: DaemonClient, jobId: string, timeoutMs = 10 * 60_000): Promise<{ status: string; error_message?: string | null; started_at?: number | null; finished_at?: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let row = await client.jobStatus(jobId) as { status: string; error_message?: string | null; started_at?: number | null; finished_at?: number | null } | null;
  while (Date.now() < deadline) {
    row = await client.jobStatus(jobId) as typeof row;
    if (row && (row.status === "done" || row.status === "failed" || row.status === "cancelled")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return row ?? { status: "failed", error_message: `Job '${jobId}' status unavailable` };
}

export const indexEphemeralTool: Tool<
  { project_id: string; branch: string; source_id?: string; label?: string },
  { label: string; chunks_new: number; chunks_reused: number; duration_ms: number }
> = {
  spec: {
    name: "index_ephemeral",
    cliName: "index-ephemeral",
    description:
      "Index an open MR's remote branch under a throwaway '_ephemeral/' label, for searching a PR's content without " +
      "disturbing the project's normally indexed branches. scrybe does NOT fetch — fetch the ref yourself first " +
      "(e.g. 'git fetch origin <branch>'), then call this tool; it errors clearly if the ref isn't resolvable locally. " +
      "Label rule: defaults to '_ephemeral/mr-<branch>' (override with 'label', still forced under the '_ephemeral/' " +
      "prefix). If 'branch' is already a full ref (starts with 'refs/' or 'origin/'), it is used as the content source " +
      "directly and the label is derived from its last path segment. Never creates a pinned_branches entry and is " +
      "invisible to the fetch-poller and 'branch pin' — call drop_ephemeral to remove it once the MR closes.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        branch: { type: "string", description: "Already-fetched MR branch name, or a full ref (e.g. 'refs/scrybe-ephemeral/mr-42', 'origin/feature-x')" },
        source_id: { type: "string", description: "Source identifier (default: primary)" },
        label: { type: "string", description: "Override the ephemeral label (still forced under '_ephemeral/')" },
      },
      required: ["project_id", "branch"],
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    cliArgs: (cmd) => cmd
      .requiredOption("-P, --project-id <id>", "Project identifier")
      .requiredOption("--branch <name>", "Already-fetched MR branch, or a full ref")
      .option("-S, --source-id <id>", "Source identifier", "primary")
      .option("--label <label>", "Override the ephemeral label (still forced under _ephemeral/)")
      .addHelpText("after", "\nExample:\n  scrybe index-ephemeral -P myrepo --branch mr-42-feature"),
  },
  handler: async ({ project_id, branch, source_id, label }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    if (!getProject(project_id)) throw new Error(`Project '${project_id}' not found`);
    const resolvedSourceId = source_id ?? "primary";
    const { label: ephemeralLabel, contentRef } = planEphemeralIndex(branch, label);

    const start = Date.now();

    // Route through daemon when available (prevents cross-process write races) —
    // same Slice-2 plumbing reindex_source uses (label via `branch`, content via `contentRef`).
    const daemon = await ensureRunning();
    if (daemon.ok && !daemon.draining) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        const resp = await client.submitReindex({ projectId: project_id, sourceId: resolvedSourceId, branch: ephemeralLabel, mode: "incremental", contentRef });
        const job = resp.jobs[0];
        if (!job) throw new Error("Daemon returned no job");
        const finalRow = await pollDaemonJob(client, job.jobId);
        if (finalRow.status === "failed") throw new Error(finalRow.error_message ?? `index_ephemeral failed for label '${ephemeralLabel}'`);
        const durationMs = (finalRow.started_at != null && finalRow.finished_at != null)
          ? finalRow.finished_at - finalRow.started_at
          : Date.now() - start;
        // Cross-process daemon path: per-task chunk counts aren't persisted to SQLite today
        // (jobs.ts only stores `result` JSON for gc jobs) — report 0s rather than fabricate numbers.
        return { label: ephemeralLabel, chunks_new: 0, chunks_reused: 0, duration_ms: durationMs };
      }
    }

    const unavailable = daemonWriteUnavailableError(daemon, "index_ephemeral");
    if (unavailable) throw unavailable;

    const jobResult = submitSourceJob(project_id, resolvedSourceId, "incremental", ephemeralLabel, undefined, contentRef);
    if (typeof jobResult === "object" && "error" in jobResult) {
      throw new Error(`A reindex job is already running for this project (job: ${jobResult.job_id})`);
    }
    const finalState = await pollInProcessJob(jobResult);
    if (!finalState) throw new Error(`Job '${jobResult}' status unavailable`);
    if (finalState.status === "failed" || finalState.status === "cancelled") {
      throw new Error(finalState.error ?? `index_ephemeral failed for label '${ephemeralLabel}'`);
    }
    if (finalState.status !== "done") {
      throw new Error(`index_ephemeral timed out waiting for label '${ephemeralLabel}' (last status: ${finalState.status})`);
    }

    const task = finalState.tasks.find((t) => t.source_id === resolvedSourceId) ?? finalState.tasks[0];
    // chunks_prepared at the job/task layer counts the whole scanned batch (embedded +
    // already-existing chunks merely tagged onto this branch) — it does not itself
    // distinguish "new" from "reused". We don't have a finer-grained counter at this
    // layer, so chunks_new reflects that combined total and chunks_reused is reported
    // as 0 rather than a fabricated split (see index_ephemeral docs).
    const chunksNew = task?.chunks_prepared ?? 0;
    const durationMs = finalState.finished_at != null ? finalState.finished_at - finalState.started_at : Date.now() - start;

    return { label: ephemeralLabel, chunks_new: chunksNew, chunks_reused: 0, duration_ms: durationMs };
  },
};

// ─── drop_ephemeral ─────────────────────────────────────────────────────────
// Plan 99 Slice 4: teardown counterpart to index_ephemeral. Removes the
// label's branch_tags/branch_state/hashes via the (previously dead-code)
// `deleteBranch`, then runs a source-scoped gc so the now-orphaned chunks are
// actually reclaimed rather than left dangling in LanceDB.

async function pollGcJob(
  client: DaemonClient,
  jobId: string,
  timeoutMs = 5 * 60_000
): Promise<{ status: string; result?: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  let row = await client.jobStatus(jobId) as { status: string; result?: string | null } | null;
  while (Date.now() < deadline) {
    row = await client.jobStatus(jobId) as typeof row;
    if (row && (row.status === "done" || row.status === "failed" || row.status === "cancelled")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return row;
}

export const dropEphemeralTool: Tool<
  { project_id: string; label: string; source_id?: string },
  { label: string; dropped: boolean; orphans_deleted: number; bytes_freed: number }
> = {
  spec: {
    name: "drop_ephemeral",
    cliName: "drop-ephemeral",
    description:
      "Remove an '_ephemeral/' label created by index_ephemeral: deletes its branch_tags/branch_state/hashes " +
      "(via deleteBranch) then runs a source-scoped gc to reclaim the now-orphaned chunks (chunks still shared " +
      "with another indexed branch survive). Refuses to drop any label that isn't under the '_ephemeral/' prefix " +
      "— this verb must never remove a real branch like 'dev' or 'master'. Idempotent: dropping an already-gone " +
      "label is a no-op success.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        label: { type: "string", description: "The '_ephemeral/...' label to drop (as returned by index_ephemeral)" },
        source_id: { type: "string", description: "Source identifier (default: primary)" },
      },
      required: ["project_id", "label"],
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    cliArgs: (cmd) => cmd
      .requiredOption("-P, --project-id <id>", "Project identifier")
      .requiredOption("--label <label>", "The '_ephemeral/...' label to drop")
      .option("-S, --source-id <id>", "Source identifier", "primary")
      .addHelpText("after", "\nExample:\n  scrybe drop-ephemeral -P myrepo --label _ephemeral/mr-42"),
  },
  handler: async ({ project_id, label, source_id }) => {
    if (!getProject(project_id)) throw new Error(`Project '${project_id}' not found`);
    if (!label.startsWith(EPHEMERAL_PREFIX)) {
      throw new Error(
        `drop_ephemeral refuses to drop '${label}' — only labels under '${EPHEMERAL_PREFIX}' can be dropped ` +
        "(safety: this verb must never remove a real branch like 'dev' or 'master')."
      );
    }
    const resolvedSourceId = source_id ?? "primary";

    const existed = getChunkIdsForBranch(project_id, resolvedSourceId, label).size > 0;
    // Metadata delete only — cheap SQLite writes, no write race with an active
    // reindex job's own writes (same convention as wipeSource, called directly
    // in-process by removeSource without daemon routing).
    deleteBranch(project_id, resolvedSourceId, label);

    // Source-scoped gc to actually reclaim the label's now-orphaned chunks.
    const daemon = await ensureRunning();
    // A DRAINING daemon still owns the data dir and is still writing, so the
    // in-process fallback below would be a second writer on the same LanceDB
    // tables. Refuse only in that case: when there is no live daemon at all
    // (container, opted-out, or a daemon that could not start) nothing else is
    // writing and the fallback is both safe and this tool's documented
    // behaviour.
    if (daemon.ok && daemon.draining) {
      throw daemonWriteUnavailableError(daemon, "Dropping an ephemeral branch")!;
    }
    if (daemon.ok) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        try {
          const submitted = await client.submitGc({ scope: [project_id], sourceId: resolvedSourceId, mode: "purge" });
          const job = submitted.jobs[0];
          if (job) {
            const finalRow = await pollGcJob(client, job.jobId);
            if (finalRow?.status === "done" && finalRow.result) {
              const parsed = JSON.parse(finalRow.result) as { orphans_deleted: number; bytes_freed: number };
              return { label, dropped: existed, orphans_deleted: parsed.orphans_deleted, bytes_freed: parsed.bytes_freed };
            }
          }
          return { label, dropped: existed, orphans_deleted: 0, bytes_freed: 0 };
        } catch {
          // Fall through to in-process gc
        }
      }
    }

    const { runGcJobHandler } = await import("../daemon/gc-handler.js");
    const gcResult = await runGcJobHandler({ projectId: project_id, sourceId: resolvedSourceId, mode: "purge" });
    return { label, dropped: existed, orphans_deleted: gcResult.orphans_deleted, bytes_freed: gcResult.bytes_freed };
  },
  cliOpts: ([opts]) => ({
    project_id: String(opts.projectId),
    label: String(opts.label),
    source_id: String(opts.sourceId ?? "primary"),
  }),
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
        status: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled", "interrupted"], description: "Filter by status (omit for all jobs)" },
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
  { running: unknown[]; queued: unknown[]; awaiting_migration?: unknown[] }
> = {
  spec: {
    name: "queue_status",
    description:
      "Check what is currently running or queued in the reindex queue. " +
      "Before triggering a reindex, call this to see if the daemon already has a pending or in-flight job for the project — polling reindex_status on the existing job is cheaper than submitting a duplicate. " +
      "The awaiting_migration array lists large local-embedder sources that need a manual full reindex after an embedding-config upgrade.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter to a specific project (omit for all)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ project_id }) => {
    // Prefer daemon's view (includes jobs from all processes and awaiting_migration state)
    const client = DaemonClient.fromPidfile();
    if (client) {
      try {
        return await client.queueStatus(project_id);
      } catch { /* daemon not running */ }
    }
    // In-process fallback (daemon not running — awaiting_migration not available out-of-process)
    try {
      return { ...getQueueStatus(project_id), awaiting_migration: [] };
    } catch {
      return { running: [], queued: [], awaiting_migration: [] };
    }
  },
};
