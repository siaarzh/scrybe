/**
 * Liveness for HTTP-only MCP clients (GitHub issue #102): each request to
 * POST /mcp registers or refreshes a stand-in client so on-demand mode does
 * not idle out under HTTP-only traffic, and the stand-in ages out on the
 * normal staleness rule once that traffic stops. Real spawned daemon, real
 * (compressed) timers — no fake-timer shortcuts, since the process boundary
 * makes those unusable here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTempDaemon } from "./helpers/daemon.js";
import type { TempDaemon } from "./helpers/daemon.js";

let daemon: TempDaemon | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (daemon) { await daemon.stop(); daemon = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
});

async function startDaemon(extraEnv: Record<string, string>): Promise<TempDaemon> {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-mcp-http-live-"));
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify([]), "utf8");
  daemon = await startTempDaemon({
    dataDir,
    projects: [],
    extraEnv: { SCRYBE_DAEMON_MCP_HTTP: "1", ...extraEnv },
  });
  return daemon;
}

async function touchMcp(port: number): Promise<void> {
  const client = new Client({ name: "mcp-http-liveness-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  await client.listTools();
  await client.close();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("Daemon liveness for HTTP-only /mcp clients (#102)", () => {
  it("repeated /mcp traffic keeps the daemon up past a short grace period, and /status shows the stand-in", async () => {
    const d = await startDaemon({
      SCRYBE_DAEMON_IDLE_GRACE_MS: "300",
      SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "5000",
      SCRYBE_DAEMON_HEARTBEAT_STALE_MS: "60000",
    });

    // Grace is 300ms; keep sending /mcp traffic well inside that window so a
    // client is never absent long enough to be pruned.
    for (let i = 0; i < 4; i++) {
      await touchMcp(d.port);
      await new Promise((r) => setTimeout(r, 150));
    }

    const status = await d.client.status();
    expect(status.clientCount).toBeGreaterThanOrEqual(1);
    expect(status.mode).toBe("on-demand");

    // Still up well past the 300ms grace window.
    const health = await d.client.health();
    expect(health.ready).toBe(true);
  }, 20000);

  it("exits once /mcp traffic stops for longer than staleness plus grace", async () => {
    const d = await startDaemon({
      SCRYBE_DAEMON_IDLE_GRACE_MS: "300",
      SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "5000",
      SCRYBE_DAEMON_HEARTBEAT_STALE_MS: "100",
    });
    const pidfilePath = join(d.dataDir, "daemon.pid");

    await touchMcp(d.port);
    expect((await d.client.status()).clientCount).toBeGreaterThanOrEqual(1);

    // No further /mcp traffic. The stand-in is pruned once the (fixed-cadence)
    // stale sweep runs past SCRYBE_DAEMON_HEARTBEAT_STALE_MS, which then arms
    // the grace timer; the daemon exits once grace elapses with no client.
    await waitFor(() => !existsSync(pidfilePath), 50000, 500);
    expect(existsSync(pidfilePath)).toBe(false);
  }, 60000);
});
