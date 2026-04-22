/**
 * Phase 2 — HTTP API: every endpoint returns the documented shape.
 * Spawns a real daemon with SCRYBE_DAEMON_PORT=0 (ephemeral) and reads
 * the port from the pidfile after startup.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import http from "node:http";
import { join } from "path";
import { tmpdir } from "os";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-http-test-"));
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil timed out");
}

const activeDataDirs: string[] = [];
const activeChildren: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const dir of activeDataDirs) {
    try {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env: { ...process.env, SCRYBE_DATA_DIR: dir, SCRYBE_SKIP_MIGRATION: "1" },
        encoding: "utf8",
        timeout: 8000,
      });
    } catch { /* ignore */ }
  }
  for (const c of activeChildren) {
    if (!c.killed) c.kill();
  }
  for (const dir of activeDataDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
  activeChildren.length = 0;
});

interface PidfileData {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  dataDir: string;
  execPath: string;
}

async function startDaemon(): Promise<{ port: number; baseUrl: string; dataDir: string }> {
  const dataDir = makeDataDir();
  activeDataDirs.push(dataDir);
  const pidfilePath = join(dataDir, "daemon.pid");
  const env = {
    ...process.env,
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_DAEMON_PORT: "0", // ephemeral to avoid port conflicts between parallel test files
  };

  const child = spawn(NODE, [ENTRY, "daemon", "start"], {
    env,
    stdio: "ignore",
    detached: false,
  });
  activeChildren.push(child);

  // Wait for pidfile with an actual port (written after HTTP server binds)
  await waitUntil(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as PidfileData;
      return d.port > 0;
    } catch {
      return false;
    }
  }, 10000);

  const pidfileData = JSON.parse(readFileSync(pidfilePath, "utf8")) as PidfileData;
  const { port } = pidfileData;
  const baseUrl = `http://127.0.0.1:${port}`;

  // /health responds (HTTP server fully ready)
  await waitUntil(async () => {
    try {
      const r = await fetch(`${baseUrl}/health`);
      return r.ok;
    } catch {
      return false;
    }
  }, 5000);

  return { port, baseUrl, dataDir };
}

describe("HTTP API — endpoint shapes", () => {
  it("GET /health returns {ready, version, uptimeMs, pid}", async () => {
    const { baseUrl } = await startDaemon();
    const data = await (await fetch(`${baseUrl}/health`)).json() as Record<string, unknown>;
    expect(data.ready).toBe(true);
    expect(typeof data.version).toBe("string");
    expect(data.version).toBeTruthy();
    expect(typeof data.uptimeMs).toBe("number");
    expect(typeof data.pid).toBe("number");
    expect(data.pid as number).toBeGreaterThan(0);
  });

  it("GET /status returns full DaemonStatus shape", async () => {
    const { baseUrl, port } = await startDaemon();
    const data = await (await fetch(`${baseUrl}/status`)).json() as Record<string, unknown>;
    expect(typeof data.version).toBe("string");
    expect(data.pid as number).toBeGreaterThan(0);
    expect(data.port).toBe(port);
    expect(typeof data.uptimeMs).toBe("number");
    expect(["hot", "cold", "paused"]).toContain(data.state);
    expect(typeof data.startedAt).toBe("string");
    expect(typeof data.dataDir).toBe("string");
    expect(Array.isArray(data.projects)).toBe(true);
    const q = data.queue as Record<string, unknown>;
    expect(typeof q.active).toBe("number");
    expect(typeof q.pending).toBe("number");
    expect(typeof q.maxConcurrent).toBe("number");
    expect(Array.isArray(data.recentEvents)).toBe(true);
  });

  it("GET /projects returns {projects: [...]}", async () => {
    const { baseUrl } = await startDaemon();
    const data = await (await fetch(`${baseUrl}/projects`)).json() as Record<string, unknown>;
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it("POST /kick returns {jobs: [...]}", async () => {
    const { baseUrl } = await startDaemon();
    const res = await fetch(`${baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it("POST /pause → state:paused; POST /resume → state:hot", async () => {
    const { baseUrl } = await startDaemon();

    const paused = await (
      await fetch(`${baseUrl}/pause`, { method: "POST" })
    ).json() as Record<string, unknown>;
    expect(paused.state).toBe("paused");

    const status = await (await fetch(`${baseUrl}/status`)).json() as Record<string, unknown>;
    expect(status.state).toBe("paused");

    const resumed = await (
      await fetch(`${baseUrl}/resume`, { method: "POST" })
    ).json() as Record<string, unknown>;
    expect(resumed.state).toBe("hot");
  });

  it("GET /events connects as SSE and stays open", async () => {
    const { port } = await startDaemon();
    // Use http.get (fires callback on headers) — fetch/undici stalls on SSE
    // until body data arrives, causing the AbortController to race
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); reject(new Error("SSE timeout")); }, 5000);
      const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
        clearTimeout(timer);
        try {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          res.destroy();
          resolve();
        } catch (err) { reject(err); }
      });
      req.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  });

  it("GET /events with ?since replays from ring buffer", async () => {
    const { port } = await startDaemon();
    const since = encodeURIComponent(new Date(0).toISOString());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); reject(new Error("SSE timeout")); }, 5000);
      const req = http.get(`http://127.0.0.1:${port}/events?since=${since}`, (res) => {
        clearTimeout(timer);
        try {
          expect(res.statusCode).toBe(200);
          res.destroy();
          resolve();
        } catch (err) { reject(err); }
      });
      req.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  });

  it("POST /shutdown stops the daemon", async () => {
    const { baseUrl, dataDir } = await startDaemon();
    const pidfilePath = join(dataDir, "daemon.pid");

    const res = await fetch(`${baseUrl}/shutdown`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.state).toBe("stopping");

    // Pidfile removed by daemon stop handler
    await waitUntil(() => !existsSync(pidfilePath), 5000);
    expect(existsSync(pidfilePath)).toBe(false);

    // Remove from cleanup list (already stopped)
    activeDataDirs.splice(activeDataDirs.indexOf(dataDir), 1);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("404 for unknown paths", async () => {
    const { baseUrl } = await startDaemon();
    const res = await fetch(`${baseUrl}/no-such-route`);
    expect(res.status).toBe(404);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.error).toBe("string");
  });
});
