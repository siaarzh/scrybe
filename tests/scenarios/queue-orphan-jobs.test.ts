/**
 * Plan 33 — A3: Queue dispatcher fails-fast on phantom project_id.
 *
 * Writes a projects.json that does NOT contain the project, then submits
 * a job for that project via submitToQueue. Verifies the job is marked
 * failed with error_message = "project no longer exists".
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { makeScenarioEnv, type ScenarioEnv } from "./helpers/spawn.js";

const NODE = process.execPath;
const CWD = process.cwd();

let env: ScenarioEnv | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
});

/** Convert a Windows/Unix path to a file:// URL string for dynamic import() on all platforms. */
function toFileUrl(p: string): string {
  return pathToFileURL(p).href;
}

describe("A3 — queue dispatcher fails-fast on phantom project", () => {
  it("marks a queued job failed when its project no longer exists", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    // Write an empty projects.json — so "ghost-project-xyz" is a phantom
    writeFileSync(join(env.dataDir, "projects.json"), "[]", "utf8");

    const queueFileUrl = toFileUrl(join(CWD, "dist/daemon/queue.js"));

    const script = `
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Initialize queue with a no-op pushEvent
const { initQueue, submitToQueue } = await import("${queueFileUrl}");
initQueue({ pushEvent: () => {} });

// Submit a job for a non-existent project
const result = submitToQueue({
  projectId: "ghost-project-xyz",
  type: "gc",
  mode: "incremental",
  gcOptions: { mode: "grace" },
});

// drain() is synchronous — give a tick for any async side effects
await new Promise(r => setTimeout(r, 300));

// Read the job's status from SQLite
const db = new DatabaseSync(join(process.env.SCRYBE_DATA_DIR, "branch-tags.db"));
const row = db.prepare("SELECT status, error_message FROM jobs WHERE job_id=?").get(result.jobId);
process.stdout.write(JSON.stringify({ jobId: result.jobId, row: row ?? null }));
`;

    const r = spawnSync(NODE, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env as Record<string, string>,
        SCRYBE_DATA_DIR: env.dataDir,
        SCRYBE_SKIP_MIGRATION: "1",
        NO_UPDATE_NOTIFIER: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    if (r.status !== 0) {
      console.error("Script stderr:", r.stderr);
    }
    expect(r.status).toBe(0);

    const output = JSON.parse(r.stdout) as { jobId: string; row: { status: string; error_message: string } | null };
    expect(output.row).not.toBeNull();
    expect(output.row?.status).toBe("failed");
    expect(output.row?.error_message).toBe("project no longer exists");
  });
});
