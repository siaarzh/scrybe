/**
 * Integration tests for heartbeat/unregister HTTP endpoints and lifecycle wiring.
 * Spawns a real daemon; uses compressed env-var timers to keep the suite fast.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const NODE  = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-heartbeat-test-"));
}

async function waitFor(check: () => boolean, ms = 6000, step = 100): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timed out");
}

const activeDataDirs: string[] = [];

afterEach(() => {
  for (const d of activeDataDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
});

async function startDaemonWithTimers(
  dataDir: string,
  extraEnv: Record<string, string> = {}
): Promise<{ child: ReturnType<typeof spawn>; port: number; pidfilePath: string }> {
  const pidfilePath = join(dataDir, "daemon.pid");
  const env = {
    ...process.env,
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_DAEMON_PORT: "0",
    SCRYBE_DAEMON_NO_FETCH: "1",
    ...extraEnv,
  } as Record<string, string>;

  const child = spawn(NODE, [ENTRY, "daemon", "start"], {
    env,
    stdio: "ignore",
    detached: false,
  });

  await waitFor(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number };
      return (d.port ?? 0) > 0;
    } catch { return false; }
  });

  const port = (JSON.parse(readFileSync(pidfilePath, "utf8")) as { port: number }).port;
  return { child, port, pidfilePath };
}

describe("daemon heartbeat endpoints", () => {
  it("POST /clients/heartbeat increments client count in /status", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const { child, port } = await startDaemonWithTimers(dataDir);

    try {
      const hbRes = await fetch(`http://127.0.0.1:${port}/clients/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "test-client-1", pid: process.pid }),
      });
      expect(hbRes.ok).toBe(true);

      const status = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json()) as any;
      expect(status.clientCount).toBe(1);
      expect(status.mode).toBe("on-demand");
    } finally {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
        timeout: 8000,
      });
      if (!child.killed) child.kill();
    }
  });

  it("POST /clients/unregister decrements client count", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const { child, port } = await startDaemonWithTimers(dataDir);

    try {
      await fetch(`http://127.0.0.1:${port}/clients/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "test-client-2", pid: process.pid }),
      });

      await fetch(`http://127.0.0.1:${port}/clients/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "test-client-2" }),
      });

      const status = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json()) as any;
      expect(status.clientCount).toBe(0);
    } finally {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
        timeout: 8000,
      });
      if (!child.killed) child.kill();
    }
  });

  it("daemon shuts down via grace timer after client unregisters (compressed timers)", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);

    // 200 ms grace, 500 ms no-client-ever (so daemon waits for us to register first)
    const { child, port, pidfilePath } = await startDaemonWithTimers(dataDir, {
      SCRYBE_DAEMON_IDLE_GRACE_MS: "200",
      SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "10000",
      SCRYBE_DAEMON_HEARTBEAT_STALE_MS: "5000",
    });

    try {
      await fetch(`http://127.0.0.1:${port}/clients/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "test-grace-client", pid: process.pid }),
      });

      await fetch(`http://127.0.0.1:${port}/clients/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "test-grace-client" }),
      });

      // Daemon should shut down within ~300 ms (200 ms grace + buffer)
      await waitFor(() => !existsSync(pidfilePath), 3000);
      expect(existsSync(pidfilePath)).toBe(false);
    } finally {
      if (!child.killed) child.kill();
    }
  });

  it("daemon shuts down via no-client-ever timer when no client connects (compressed timer)", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);

    const { child, pidfilePath } = await startDaemonWithTimers(dataDir, {
      SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "200",
      SCRYBE_DAEMON_IDLE_GRACE_MS: "60000",
    });

    try {
      await waitFor(() => !existsSync(pidfilePath), 3000);
      expect(existsSync(pidfilePath)).toBe(false);
    } finally {
      if (!child.killed) child.kill();
    }
  });

  it("daemon stays up with SCRYBE_DAEMON_KEEP_ALIVE=1 even after client unregisters", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);

    const { child, port, pidfilePath } = await startDaemonWithTimers(dataDir, {
      SCRYBE_DAEMON_KEEP_ALIVE: "1",
      SCRYBE_DAEMON_IDLE_GRACE_MS: "100",
      SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "100",
    });

    try {
      await fetch(`http://127.0.0.1:${port}/clients/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "keep-alive-client", pid: process.pid }),
      });

      await fetch(`http://127.0.0.1:${port}/clients/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "keep-alive-client" }),
      });

      // Wait 400 ms — daemon should NOT have shut down
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(pidfilePath)).toBe(true);

      const status = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json()) as any;
      expect(status.mode).toBe("always-on");
    } finally {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
        timeout: 8000,
      });
      if (!child.killed) child.kill();
    }
  });
});
