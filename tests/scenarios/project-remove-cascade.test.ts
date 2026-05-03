/**
 * Plan 33 — A1: scrybe project remove cancels pending/running jobs.
 *
 * Register a project, seed queued/running job rows into SQLite for that project,
 * then run `scrybe project remove`. Verify the jobs are cancelled with
 * error_message = "project removed".
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";

const NODE = process.execPath;

let env: ScenarioEnv | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
});

/** Seed a job row into branch-tags.db. The table is initialized by scrybe CLI before this runs. */
function seedJobRow(dataDir: string, jobId: string, projectId: string, status: "queued" | "running"): void {
  const script = `
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const db = new DatabaseSync(join(process.env.SCRYBE_DATA_DIR, "branch-tags.db"));
// Ensure jobs table exists (created by getDB() but seed script must be self-contained)
db.exec(\`CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id TEXT,
  branch TEXT,
  mode TEXT NOT NULL DEFAULT 'incremental',
  status TEXT NOT NULL,
  phase TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error_message TEXT,
  origin TEXT NOT NULL DEFAULT 'daemon',
  type TEXT NOT NULL DEFAULT 'reindex',
  result TEXT
)\`);
db.prepare("INSERT OR IGNORE INTO jobs (job_id, project_id, mode, status, queued_at, origin, type) VALUES (?,?,?,?,?,?,?)").run(
  "${jobId}", "${projectId}", "incremental", "${status}", Date.now(), "daemon", "gc"
);
`;
  const r = spawnSync(NODE, ["--input-type=module", "--eval", script], {
    env: { ...process.env as Record<string, string>, SCRYBE_DATA_DIR: dataDir },
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) throw new Error(`seedJobRow failed: ${r.stderr}`);
}

/** Read a job's status + error_message from SQLite. */
function readJobRow(dataDir: string, jobId: string): { status: string; error_message: string | null } | null {
  const script = `
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const db = new DatabaseSync(join(process.env.SCRYBE_DATA_DIR, "branch-tags.db"));
const row = db.prepare("SELECT status, error_message FROM jobs WHERE job_id=?").get("${jobId}");
process.stdout.write(JSON.stringify(row ?? null));
`;
  const r = spawnSync(NODE, ["--input-type=module", "--eval", script], {
    env: { ...process.env as Record<string, string>, SCRYBE_DATA_DIR: dataDir },
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout) as { status: string; error_message: string | null } | null; } catch { return null; }
}

describe("A1 — project remove cascade-cancels jobs", () => {
  it("cancels a queued job when project is removed", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    // Add project to trigger DB initialisation (creates branch-tags.db + jobs table)
    runScrybe(["project", "add", "--id", "cascade-test"], env);

    seedJobRow(env.dataDir, "job-q-001", "cascade-test", "queued");

    const r = runScrybe(["project", "remove", "cascade-test"], env);
    expect(r.exit).toBe(0);

    const row = readJobRow(env.dataDir, "job-q-001");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("cancelled");
    expect(row?.error_message).toBe("project removed");
  });

  it("cancels a running job when project is removed", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    runScrybe(["project", "add", "--id", "cascade-running"], env);
    seedJobRow(env.dataDir, "job-r-001", "cascade-running", "running");

    const r = runScrybe(["project", "remove", "cascade-running"], env);
    expect(r.exit).toBe(0);

    const row = readJobRow(env.dataDir, "job-r-001");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("cancelled");
    expect(row?.error_message).toBe("project removed");
  });

  it("does not cancel jobs for other projects", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    runScrybe(["project", "add", "--id", "proj-to-remove"], env);
    runScrybe(["project", "add", "--id", "proj-to-keep"], env);

    seedJobRow(env.dataDir, "job-remove-001", "proj-to-remove", "queued");
    seedJobRow(env.dataDir, "job-keep-001", "proj-to-keep", "queued");

    runScrybe(["project", "remove", "proj-to-remove"], env);

    expect(readJobRow(env.dataDir, "job-keep-001")?.status).toBe("queued");
    expect(readJobRow(env.dataDir, "job-remove-001")?.status).toBe("cancelled");
  });

  it("exits 0 when project has no pending jobs", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    runScrybe(["project", "add", "--id", "proj-no-jobs"], env);

    const r = runScrybe(["project", "remove", "proj-no-jobs"], env);
    expect(r.exit).toBe(0);
  });
});
