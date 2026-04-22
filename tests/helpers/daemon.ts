/**
 * Contract 17 — Daemon test helpers.
 * startTempDaemon / waitForIdle / waitForEvent for integration tests that need
 * a live daemon process. M-D3 VS Code extension tests reuse these helpers.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DaemonClient } from "../../src/daemon/client.js";
import type { DaemonEvent } from "../../src/daemon/client.js";
import type { TempProject } from "./project.js";

export type { DaemonEvent };

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

export interface TempDaemon {
  client: DaemonClient;
  port: number;
  dataDir: string;
  stop(): Promise<void>;
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

/**
 * Spawns a real daemon process against the given dataDir.
 * The projects must already be registered in dataDir/projects.json before calling.
 * Uses an ephemeral port by default (SCRYBE_DAEMON_PORT=0).
 * Disables the fetch poller (SCRYBE_DAEMON_NO_FETCH=1) so tests don't need git remotes.
 */
export async function startTempDaemon(opts: {
  dataDir: string;
  projects: TempProject[];
  port?: number;
  extraEnv?: Record<string, string>;
}): Promise<TempDaemon> {
  const pidfilePath = join(opts.dataDir, "daemon.pid");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SCRYBE_DATA_DIR: opts.dataDir,
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_DAEMON_PORT: String(opts.port ?? 0),
    SCRYBE_DAEMON_NO_FETCH: "1",
    ...opts.extraEnv,
  };

  const child = spawn(NODE, [ENTRY, "daemon", "start"], {
    env,
    stdio: "ignore",
    detached: false,
  });

  // Wait for pidfile with a real port (written after the HTTP server binds)
  await waitUntil(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number };
      return (d.port ?? 0) > 0;
    } catch {
      return false;
    }
  }, 10000);

  const pidfileData = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port: number };
  const port = pidfileData.port;
  const client = new DaemonClient({ port });

  // Wait until /health is responding
  await waitUntil(async () => {
    try {
      const h = await client.health();
      return h.ready;
    } catch {
      return false;
    }
  }, 5000);

  async function stop(): Promise<void> {
    try {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env,
        encoding: "utf8",
        timeout: 8000,
      });
    } catch { /* ignore */ }
    if (!child.killed) child.kill();
    client.close();
  }

  return { client, port, dataDir: opts.dataDir, stop };
}

/**
 * Polls /status until queue.active === 0 AND queue.pending === 0.
 * Default timeout: 30 s.
 */
export async function waitForIdle(
  daemon: TempDaemon,
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await daemon.client.status();
      if (status.queue.active === 0 && status.queue.pending === 0) return;
    } catch { /* daemon might still be initializing */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForIdle timed out after ${timeoutMs}ms`);
}

/**
 * Subscribes to SSE /events and resolves with the first event matching predicate.
 * Creates its own DaemonClient so it doesn't interfere with daemon.client's state.
 * Default timeout: 30 s.
 */
export async function waitForEvent(
  daemon: TempDaemon,
  predicate: (e: DaemonEvent) => boolean,
  timeoutMs = 30000
): Promise<DaemonEvent> {
  const watchClient = new DaemonClient({ port: daemon.port });

  return new Promise<DaemonEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      watchClient.close();
      reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of watchClient.watchEvents()) {
          if (predicate(event)) {
            clearTimeout(timer);
            watchClient.close();
            resolve(event);
            return;
          }
        }
        clearTimeout(timer);
        reject(new Error("SSE stream ended without matching event"));
      } catch (err) {
        clearTimeout(timer);
        reject(err as Error);
      }
    })();
  });
}
