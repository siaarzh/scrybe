/**
 * Durable job store — SQLite-backed job lifecycle state.
 * Lives in branch-tags.db alongside branch_tags.
 * Provides cross-process visibility: both daemon and MCP see the same rows.
 * In-memory AbortControllers and per-source task detail stay in jobs.ts.
 */
import { getDB } from "./branch-state.js";
import type { IndexMode, JobState } from "./types.js";

export type JobOrigin = "daemon" | "mcp" | "cli";
export type PersistentJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobRow {
  job_id: string;
  project_id: string;
  source_id: string | null;
  branch: string | null;
  mode: IndexMode;
  status: PersistentJobStatus;
  phase: string | null;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_message: string | null;
  origin: JobOrigin;
}

type SQLVal = null | number | bigint | string | Uint8Array;

export function insertJob(row: JobRow): void {
  getDB().prepare(`
    INSERT INTO jobs
      (job_id, project_id, source_id, branch, mode, status, phase,
       queued_at, started_at, finished_at, error_message, origin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.job_id,
    row.project_id,
    row.source_id ?? null,
    row.branch ?? null,
    row.mode,
    row.status,
    row.phase ?? null,
    row.queued_at,
    row.started_at ?? null,
    row.finished_at ?? null,
    row.error_message ?? null,
    row.origin,
  );
}

export function updateJobStatus(
  jobId: string,
  updates: Partial<Pick<JobRow, "status" | "phase" | "started_at" | "finished_at" | "error_message">>,
): void {
  const db = getDB();
  const sets: string[] = [];
  const vals: SQLVal[] = [];

  for (const [k, v] of Object.entries(updates)) {
    sets.push(`${k}=?`);
    vals.push((v ?? null) as SQLVal);
  }
  if (sets.length === 0) return;

  vals.push(jobId);
  db.prepare(`UPDATE jobs SET ${sets.join(",")} WHERE job_id=?`).run(...vals);
}

export function getJobRow(jobId: string): JobRow | null {
  const row = getDB().prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId);
  return (row as unknown as JobRow | undefined) ?? null;
}

export function listJobRows(opts: {
  status?: string;
  projectId?: string;
  limit?: number;
} = {}): JobRow[] {
  const where: string[] = [];
  const vals: SQLVal[] = [];

  if (opts.status) { where.push("status=?"); vals.push(opts.status); }
  if (opts.projectId) { where.push("project_id=?"); vals.push(opts.projectId); }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  vals.push(opts.limit ?? 200);

  return getDB()
    .prepare(`SELECT * FROM jobs ${clause} ORDER BY queued_at DESC LIMIT ?`)
    .all(...vals) as unknown as JobRow[];
}

export function getQueueStatus(projectId?: string): { running: JobRow[]; queued: JobRow[] } {
  const db = getDB();
  const filter = projectId ? "AND project_id=?" : "";
  const vals: SQLVal[] = projectId ? [projectId] : [];

  const running = db
    .prepare(`SELECT * FROM jobs WHERE status='running' ${filter} ORDER BY started_at`)
    .all(...vals) as unknown as JobRow[];
  const queued = db
    .prepare(`SELECT * FROM jobs WHERE status='queued' ${filter} ORDER BY queued_at`)
    .all(...vals) as unknown as JobRow[];

  return { running, queued };
}

/** Retain last 1000 terminal jobs OR last 7 days, whichever is larger. */
export function pruneOldJobs(): void {
  const db = getDB();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.prepare(`
    DELETE FROM jobs
    WHERE status IN ('done','failed','cancelled')
      AND finished_at < ?
      AND job_id NOT IN (
        SELECT job_id FROM jobs
        WHERE status IN ('done','failed','cancelled')
        ORDER BY queued_at DESC LIMIT 1000
      )
  `).run(sevenDaysAgo);
}

/** Convert a SQLite row to JobState (tasks will be empty — use in-memory map for active jobs). */
export function jobRowToState(row: JobRow): JobState {
  return {
    job_id: row.job_id,
    project_id: row.project_id,
    source_id: row.source_id ?? undefined,
    mode: row.mode,
    status: row.status as JobState["status"],
    tasks: [],
    started_at: row.started_at ?? row.queued_at,
    finished_at: row.finished_at ?? null,
    error: row.error_message ?? null,
  };
}
