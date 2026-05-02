/**
 * Fix 4 (Plan 31) — preinstall script stops the running daemon.
 *
 * The `npm-hooks/pre-install.js` script is invoked before npm unpacks new files.
 * It reads daemon.pid, sends /shutdown, waits for the process to exit.
 *
 * Test cases:
 *  1. Live daemon running → preinstall script stops it gracefully, exits 0.
 *  2. No pidfile → script exits 0 silently.
 *  3. Stale pidfile (PID dead) → script exits 0 silently.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, ENTRY, type ScenarioEnv } from "./helpers/spawn.js";
import { sidecar } from "../helpers/sidecar.js";

const NODE = process.execPath;
const PRE_INSTALL = join(process.cwd(), "npm-hooks/pre-install.js");

let env: ScenarioEnv | null = null;
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

async function startDaemon(dataDir: string): Promise<{ pid: number; port: number; stop(): void }> {
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
  }, 10_000);

  const pidData = JSON.parse(readFileSync(pidfilePath, "utf8")) as { pid: number; port: number };
  return {
    pid: pidData.pid,
    port: pidData.port,
    stop() {
      if (!child.killed) child.kill();
      daemonProcess = null;
    },
  };
}

afterEach(() => {
  if (daemonProcess && !daemonProcess.killed) { daemonProcess.kill(); daemonProcess = null; }
  env?.cleanup(); env = null;
});

function runPreinstall(dataDir: string): { stdout: string; stderr: string; exit: number } {
  const result = spawnSync(NODE, [PRE_INSTALL], {
    env: {
      ...(process.env as Record<string, string>),
      SCRYBE_DATA_DIR: dataDir,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exit: result.status ?? 1,
  };
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("Fix 4 — preinstall script", () => {
  it("exits 0 when no pidfile exists (fresh install)", () => {
    env = makeScenarioEnv();
    // No pidfile written — directory is empty

    const result = runPreinstall(env.dataDir);

    expect(result.exit).toBe(0);
    // stdout should be silent (no daemon to stop)
    expect(result.stdout).not.toContain("[scrybe preinstall]");
  });

  it("exits 0 when pidfile has a dead PID (stale pidfile)", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    // Write a pidfile pointing to a PID that won't exist
    // Use a very high PID unlikely to be real; if it is, the test still exits 0
    // (worst case: warns but doesn't hang, then exits 0 after 5s wait)
    // For reliability, fork+kill a subprocess to get a guaranteed-dead PID.
    const deadChild = spawnSync(NODE, ["--eval", "process.exit(0)"], { timeout: 2000 });
    const deadPid = deadChild.pid ?? 99999999;

    writeFileSync(
      join(env.dataDir, "daemon.pid"),
      JSON.stringify({ pid: deadPid, port: 0, version: "0.28.2", dataDir: env.dataDir, execPath: NODE, startedAt: new Date().toISOString() }),
      "utf8"
    );

    const result = runPreinstall(env.dataDir);

    // Must always exit 0
    expect(result.exit).toBe(0);
  });

  it("exits 0 and stops a live daemon gracefully", async () => {
    env = makeScenarioEnv();

    const daemon = await startDaemon(env.dataDir);
    expect(isPidAlive(daemon.pid)).toBe(true);

    // Run preinstall — should send /shutdown and wait for process to exit
    const result = runPreinstall(env.dataDir);

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("[scrybe preinstall]");
    expect(result.stdout).toContain(`pid=${daemon.pid}`);

    // Daemon process should be stopped after preinstall
    // Give it a short moment to finish exiting
    await new Promise((r) => setTimeout(r, 500));
    expect(isPidAlive(daemon.pid)).toBe(false);

    daemonProcess = null; // already stopped
  }, 30_000);
});
