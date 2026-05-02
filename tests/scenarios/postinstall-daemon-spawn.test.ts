/**
 * Plan 33 — B happy path: post-install.js spawns the daemon.
 *
 * Invokes `node npm-hooks/post-install.js` with an isolated DATA_DIR.
 * Verifies the daemon is up at the expected port within a timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, type ScenarioEnv } from "./helpers/spawn.js";
import { sidecar } from "../helpers/sidecar.js";

const NODE = process.execPath;
const POST_INSTALL = join(process.cwd(), "npm-hooks/post-install.js");

let env: ScenarioEnv | null = null;
// Track any daemon spawned by post-install so we can clean up
let spawnedDaemonPid: number | null = null;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return true; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killDaemon(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

afterEach(async () => {
  if (spawnedDaemonPid && isPidAlive(spawnedDaemonPid)) {
    killDaemon(spawnedDaemonPid);
    // Wait for it to exit
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isPidAlive(spawnedDaemonPid)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    spawnedDaemonPid = null;
  }
  env?.cleanup(); env = null;
});

function runPostInstall(dataDir: string): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [POST_INSTALL], {
    env: {
      ...(process.env as Record<string, string>),
      SCRYBE_DATA_DIR: dataDir,
      SCRYBE_DAEMON_PORT: "0",
      SCRYBE_SKIP_MIGRATION: "1",
      SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
      SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
      SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
      SCRYBE_CODE_EMBEDDING_API_KEY: "test",
      NO_UPDATE_NOTIFIER: "1",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    exit: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("Plan 33 B — postinstall spawns daemon", () => {
  it("exits 0 and daemon starts (pidfile appears within 10s)", async () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    const result = runPostInstall(env.dataDir);
    // Script must always exit 0
    expect(result.exit).toBe(0);

    // Daemon should create pidfile within 10s
    const pidfilePath = join(env.dataDir, "daemon.pid");
    const appeared = await waitFor(() => {
      if (!existsSync(pidfilePath)) return false;
      try {
        const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number; pid?: number };
        return (d.port ?? 0) > 0 && (d.pid ?? 0) > 0;
      } catch { return false; }
    }, 10_000);

    expect(appeared).toBe(true);

    // Read pid so we can clean it up
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { pid: number };
      spawnedDaemonPid = d.pid;
    } catch { /* ok */ }
  }, 20_000);
});
