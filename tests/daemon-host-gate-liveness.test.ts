/**
 * Regression guard for the Host/Origin gate (GitHub issue #102): the
 * watchdog's health probe and the MCP shim's own heartbeat/unregister calls
 * must never be rejected by the gate — that would wrongly trigger the
 * watchdog's SIGKILL-and-respawn path or break shim client bookkeeping. Runs
 * against a real spawned daemon process, not a fake one.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTempDaemon } from "./helpers/daemon.js";
import type { TempDaemon } from "./helpers/daemon.js";

// _sendHeartbeat re-reads the pidfile to opportunistically refresh its base
// URL. Mocked to null so it never clobbers the __testing base URL this test
// sets for its own throwaway daemon with some unrelated pidfile on disk.
vi.mock("../src/daemon/pidfile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/pidfile.js")>()),
  readPidfile: vi.fn().mockReturnValue(null),
}));

let daemon: TempDaemon | null = null;
let testDataDir: string | null = null;

afterEach(async () => {
  if (daemon) { await daemon.stop(); daemon = null; }
  if (testDataDir) { try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ } testDataDir = null; }
});

async function startDaemon(): Promise<TempDaemon> {
  testDataDir = mkdtempSync(join(tmpdir(), "scrybe-host-gate-live-"));
  writeFileSync(join(testDataDir, "projects.json"), JSON.stringify([]), "utf8");
  daemon = await startTempDaemon({ dataDir: testDataDir, projects: [] });
  return daemon;
}

describe("Host/Origin gate — daemon liveness plumbing keeps working", () => {
  it("the watchdog's probeHealthOnce reports healthy against a real daemon", async () => {
    const d = await startDaemon();
    const { probeHealthOnce } = await import("../src/daemon/pidfile.js");
    // A 403 from the gate would make fetch's res.ok false, and probeHealthOnce
    // maps that to "refused" — the same outcome as no daemon at all.
    const result = await probeHealthOnce(d.port, 2000);
    expect(result).toBe("healthy");
  });

  it("the shim's own heartbeat call registers a client on a real daemon", async () => {
    const d = await startDaemon();
    const { __testing } = await import("../src/mcp-shim.js");
    __testing.setBaseUrl(`http://127.0.0.1:${d.port}`);
    await __testing.sendHeartbeat();

    const status = await d.client.status();
    expect(status.clientCount).toBeGreaterThanOrEqual(1);
  });

  it("a request shaped exactly like the shim's unregister call succeeds on a real daemon", async () => {
    // src/mcp-shim.ts's _unregisterAndExit has no exported test seam, so this
    // sends the identical request shape it builds: POST /clients/unregister,
    // JSON body { clientId }, no extra headers.
    const d = await startDaemon();
    const res = await fetch(`http://127.0.0.1:${d.port}/clients/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "test-client" }),
      signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(200);
  });
});
