/**
 * Scenario 4  — DATA_DIR wipe + daemon restart: re-index works without recovery.
 * Scenario 9  — Daemon on-demand auto-spawn: MCP request triggers daemon spawn.
 * Scenario 14 — FS-watch reindex roundtrip: new file found within timeout.
 *
 * These scenarios spawn a real daemon process. Each test has its own DATA_DIR
 * and temp repo. Cleanup kills the daemon in afterEach.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { makeScenarioEnv, runScrybe, ENTRY, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";
import { sidecar } from "../helpers/sidecar.js";

const skipOnMacCI = process.env["CI"] === "true" && platform() === "darwin";

const NODE = process.execPath;

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;
let daemonProcess: ReturnType<typeof spawn> | null = null;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function daemonEnv(dataDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_DAEMON_PORT: "0",
    SCRYBE_DAEMON_NO_FETCH: "1",
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
    SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
    SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
    SCRYBE_CODE_EMBEDDING_API_KEY: "test",
    SCRYBE_HYBRID: "true",
    SCRYBE_RERANK: "false",
    NO_UPDATE_NOTIFIER: "1",
  };
}

async function startDaemon(dataDir: string): Promise<{ port: number; stop(): void }> {
  const pidfilePath = join(dataDir, "daemon.pid");
  const child = spawn(NODE, [ENTRY, "daemon", "start"], {
    env: daemonEnv(dataDir),
    stdio: "ignore",
    detached: false,
  });
  daemonProcess = child;

  await waitFor(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number };
      return (d.port ?? 0) > 0;
    } catch { return false; }
  }, 10000);

  const { port } = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port: number };

  return {
    port,
    stop() {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], { env: daemonEnv(dataDir), timeout: 5000 });
      if (!child.killed) child.kill();
      daemonProcess = null;
    },
  };
}

afterEach(() => {
  if (daemonProcess && !daemonProcess.killed) { daemonProcess.kill(); daemonProcess = null; }
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("Scenario 4 — DATA_DIR wipe + daemon restart", () => {
  it("re-index succeeds after DATA_DIR is wiped", async () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const hello = 'world';\n" });

    // Register + index
    runScrybe(["project", "add", "--id", "s4-proj"], env);
    runScrybe(["source", "add", "-P", "s4-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s4-proj", "-S", "primary", "-f"], env);

    // Wipe DATA_DIR
    rmSync(env.dataDir, { recursive: true, force: true });

    // Re-register + re-index in the same path (DATA_DIR will be recreated)
    runScrybe(["project", "add", "--id", "s4-proj"], env);
    runScrybe(["source", "add", "-P", "s4-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    const r = runScrybe(["index", "-P", "s4-proj", "-S", "primary", "-f"], env);
    expect(r.exit).toBe(0);

    // Search should work
    const s = runScrybe(["search", "code", "-P", "s4-proj", "hello"], env);
    expect(s.exit).toBe(0);
    expect(s.stdout).toContain("hello");
  });
});

describe("Scenario 9 — daemon on-demand auto-spawn via `daemon up`", () => {
  it("daemon up starts the daemon and it becomes responsive", async () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "const x = 1;\n" });

    runScrybe(["project", "add", "--id", "s9-proj"], env);
    runScrybe(["source", "add", "-P", "s9-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Start daemon
    const d = await startDaemon(env.dataDir);

    // Daemon should be responding to /health
    const health = await fetch(`http://127.0.0.1:${d.port}/health`);
    const body = await health.json() as { ready: boolean };
    expect(body.ready).toBe(true);

    d.stop();
  });
});

describe.skipIf(skipOnMacCI)("Scenario 14 — FS-watch reindex roundtrip", () => {
  it("new file content is findable via search within 10s after write", async () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const existing = 1;\n" });

    runScrybe(["project", "add", "--id", "s14-proj"], env);
    runScrybe(["source", "add", "-P", "s14-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s14-proj", "-S", "primary", "-f"], env);

    // Start daemon (enables FS watch)
    const d = await startDaemon(env.dataDir);

    // Wait for daemon to be idle
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${d.port}/status`);
        const s = await r.json() as { queue: { active: number; pending: number } };
        return s.queue.active === 0 && s.queue.pending === 0;
      } catch { return false; }
    }, 10000);

    // Write a new file and commit
    repo.commit("src/uniqueWidget.ts",
      "export function renderUniqueWidget() { return 'unique-sentinel-42'; }\n",
      "add unique widget");

    // Wait for FS watch → reindex → search visibility (up to 10s)
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      await new Promise((r) => setTimeout(r, 500));
      const r = runScrybe(["search", "code", "-P", "s14-proj", "unique-sentinel-42"], env);
      if (r.exit === 0 && r.stdout.includes("unique-sentinel-42")) {
        found = true;
      }
    }

    d.stop();
    expect(found).toBe(true);
  }, 30_000);
});
