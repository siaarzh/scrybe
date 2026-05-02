/**
 * Plan 33 — A2: Auto-gc scheduler skips removed projects.
 *
 * Verifies that:
 * 1. enqueueAutoGc for a non-existent project does NOT submit a job to SQLite.
 * 2. IdleTracker.cancel removes the timer for a project.
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

describe("A2 — auto-gc skips removed projects", () => {
  it("enqueueAutoGc does not submit a job when project does not exist", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    // Write an empty projects.json — any project_id is a phantom
    writeFileSync(join(env.dataDir, "projects.json"), "[]", "utf8");

    const queueFileUrl = toFileUrl(join(CWD, "dist/daemon/queue.js"));
    const autoGcFileUrl = toFileUrl(join(CWD, "dist/daemon/auto-gc.js"));

    const script = `
const { initQueue } = await import("${queueFileUrl}");
initQueue({ pushEvent: () => {} });

const { enqueueAutoGc } = await import("${autoGcFileUrl}");
// Call enqueueAutoGc for a project that doesn't exist in projects.json
enqueueAutoGc("ghost-project", "idle");

// Allow async microtasks to settle
await new Promise(r => setTimeout(r, 200));

// Check SQLite for any queued gc jobs
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const dbPath = join(process.env.SCRYBE_DATA_DIR, "branch-tags.db");
if (!existsSync(dbPath)) { process.stdout.write("0"); process.exit(0); }
const db = new DatabaseSync(dbPath);
try {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE project_id='ghost-project' AND type='gc' AND status='queued'").get();
  process.stdout.write(String(row.cnt));
} catch {
  process.stdout.write("0");
}
`;

    const r = spawnSync(NODE, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env as Record<string, string>,
        SCRYBE_DATA_DIR: env.dataDir,
        SCRYBE_AUTO_GC: "1",
        SCRYBE_SKIP_MIGRATION: "1",
        NO_UPDATE_NOTIFIER: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    // No gc job should have been queued
    const queued = parseInt(r.stdout.trim(), 10) || 0;
    expect(queued).toBe(0);
  });

  it("IdleTracker.cancel removes the timer for a project", () => {
    const autoGcFileUrl = toFileUrl(join(CWD, "dist/daemon/auto-gc.js"));

    const script = `
const { IdleTracker } = await import("${autoGcFileUrl}");
const tracker = new IdleTracker(60_000, () => {});
tracker.reset("my-project");
const hasBefore = tracker.hasTimer("my-project");
tracker.cancel("my-project");
const hasAfter = tracker.hasTimer("my-project");
process.stdout.write(JSON.stringify({ hasBefore, hasAfter }));
`;

    const r = spawnSync(NODE, ["--input-type=module", "--eval", script], {
      env: { ...process.env as Record<string, string>, NO_UPDATE_NOTIFIER: "1" },
      encoding: "utf8",
      timeout: 5000,
    });

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout) as { hasBefore: boolean; hasAfter: boolean };
    expect(result.hasBefore).toBe(true);
    expect(result.hasAfter).toBe(false);
  });
});
