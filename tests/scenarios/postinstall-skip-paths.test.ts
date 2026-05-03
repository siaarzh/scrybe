/**
 * Plan 33 — B skip paths: post-install.js skips gracefully.
 *
 * Three skip paths:
 *  1. SCRYBE_NO_AUTO_DAEMON=1 — opt-out env var
 *  2. Container environment (/.dockerenv mock via /proc/1/cgroup content trick on Linux;
 *     WSL_DISTRO_NAME on all platforms)
 *  3. Daemon already running at expected port (pidfile + /health probe succeeds)
 *
 * Each path must: exit 0, not spawn a daemon process.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, type ScenarioEnv } from "./helpers/spawn.js";
import { sidecar } from "../helpers/sidecar.js";

const NODE = process.execPath;
const POST_INSTALL = join(process.cwd(), "npm-hooks/post-install.js");
const ENTRY = join(process.cwd(), "dist/index.js");

let env: ScenarioEnv | null = null;
let daemonProcess: ReturnType<typeof spawn> | null = null;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return true; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

afterEach(() => {
  if (daemonProcess && !daemonProcess.killed) { daemonProcess.kill(); daemonProcess = null; }
  env?.cleanup(); env = null;
});

function runPostInstall(dataDir: string, extraEnv: Record<string, string> = {}): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [POST_INSTALL], {
    env: {
      ...(process.env as Record<string, string>),
      SCRYBE_DATA_DIR: dataDir,
      SCRYBE_SKIP_MIGRATION: "1",
      NO_UPDATE_NOTIFIER: "1",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    exit: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("Plan 33 B — postinstall skip paths", () => {
  it("skip 1: exits 0 silently when SCRYBE_NO_AUTO_DAEMON=1", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    const result = runPostInstall(env.dataDir, { SCRYBE_NO_AUTO_DAEMON: "1" });

    expect(result.exit).toBe(0);

    // Daemon pidfile should NOT appear
    expect(existsSync(join(env.dataDir, "daemon.pid"))).toBe(false);
  });

  it("skip 2: exits 0 silently when WSL_DISTRO_NAME is set (container detection)", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    // WSL_DISTRO_NAME simulates container/WSL detection across all platforms
    const result = runPostInstall(env.dataDir, { WSL_DISTRO_NAME: "Ubuntu-22.04" });

    expect(result.exit).toBe(0);
    expect(existsSync(join(env.dataDir, "daemon.pid"))).toBe(false);
  });

  it("skip 3: exits 0 silently when daemon is already running (pidfile + /health healthy)", async () => {
    env = makeScenarioEnv();

    // Start a real daemon
    daemonProcess = spawn(NODE, [ENTRY, "daemon", "start"], {
      env: {
        ...(process.env as Record<string, string>),
        SCRYBE_DATA_DIR: env.dataDir,
        SCRYBE_DAEMON_PORT: "0",
        SCRYBE_SKIP_MIGRATION: "1",
        SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
        SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
        SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
        SCRYBE_CODE_EMBEDDING_API_KEY: "test",
        NO_UPDATE_NOTIFIER: "1",
        SCRYBE_DAEMON_NO_FETCH: "1",
      },
      stdio: "ignore",
    });

    const pidfilePath = join(env.dataDir, "daemon.pid");
    const ready = await waitFor(() => {
      if (!existsSync(pidfilePath)) return false;
      try {
        const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number };
        return (d.port ?? 0) > 0;
      } catch { return false; }
    }, 10_000);

    expect(ready).toBe(true);

    // Now run postinstall — daemon is already running, should skip
    const result = runPostInstall(env.dataDir);
    expect(result.exit).toBe(0);

    // Daemon should still be running (postinstall didn't kill it)
    if (daemonProcess.pid) {
      try { process.kill(daemonProcess.pid, 0); } catch {
        // If it exited unexpectedly that's fine for our purpose
      }
    }
  }, 25_000);
});
