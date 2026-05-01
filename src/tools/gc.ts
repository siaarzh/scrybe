/**
 * MCP gc tool — mirrors manual `scrybe gc` semantics.
 * Routes through daemon queue when available; falls back to direct execution.
 * Cancels pending auto-gc jobs in scope and resets idle timers.
 */
import { getProject, listProjects } from "../registry.js";
import type { Tool } from "./types.js";
import { DaemonClient, ensureRunning } from "../daemon/client.js";

export const gcTool: Tool<
  { project_id?: string; source_id?: string },
  {
    jobs?: Array<{ job_id: string; project_id: string; status: string }>;
    message: string;
  }
> = {
  spec: {
    name: "gc",
    description:
      "Run garbage collection: remove orphan chunks and compact LanceDB tables. " +
      "Routes through the daemon queue when available (prevents write races with active reindex jobs). " +
      "Cancels any pending auto-gc jobs in the same scope. " +
      "Pass project_id to limit scope; omit for all projects.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Limit gc to a specific project (omit for all projects)" },
        source_id: { type: "string", description: "Limit gc to a specific source within the project" },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler: async ({ project_id, source_id }) => {
    // Validate inputs
    if (project_id && !getProject(project_id)) {
      throw new Error(`Project '${project_id}' not found`);
    }

    const scope = project_id
      ? [project_id]
      : listProjects().map((p) => p.id);

    if (scope.length === 0) {
      return { message: "No projects registered." };
    }

    // Try to route through daemon queue via HTTP (cross-process safe)
    const daemon = await ensureRunning();
    if (daemon.ok) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        try {
          const result = await client.submitGc({ scope, mode: "purge" });
          const cancelledHint = result.cancelledPending > 0
            ? ` (${result.cancelledPending} pending auto-gc job(s) preempted)`
            : "";
          return {
            jobs: result.jobs.map((j) => ({
              job_id: j.jobId,
              project_id: j.projectId,
              status: j.status ?? "queued",
            })),
            message: `${result.jobs.length} gc job(s) queued${cancelledHint}. Poll with reindex_status or run 'scrybe job list'.`,
          };
        } catch {
          // Fall through to direct execution
        }
      }
    }

    // In-process fallback — run gc directly
    const results: Array<{ project_id: string; orphans_deleted: number; bytes_freed: number }> = [];
    for (const projectId of scope) {
      try {
        const { runGcJobHandler } = await import("../daemon/gc-handler.js");
        const result = await runGcJobHandler({
          projectId,
          sourceId: source_id,
          mode: "purge",
        });
        results.push({
          project_id: projectId,
          orphans_deleted: result.orphans_deleted,
          bytes_freed: result.bytes_freed,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`GC failed for project '${projectId}': ${message}`);
      }
    }

    const totalOrphans = results.reduce((s, r) => s + r.orphans_deleted, 0);
    const totalBytes = results.reduce((s, r) => s + r.bytes_freed, 0);
    return {
      message: `GC complete. ${totalOrphans} orphan(s) deleted, ${(totalBytes / 1024 / 1024).toFixed(1)} MB reclaimed across ${results.length} project(s).`,
    };
  },
};
