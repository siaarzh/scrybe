/**
 * `ensureRunning()`'s timeout is a BUDGET, and `health-timeout` is a claim
 * about a daemon that was actually asked.
 *
 * The regression this pins: the cgroup wrapper (`spawnDaemonDetached*`) blocked
 * for a flat 10 s while `ensureRunning` had computed its deadline BEFORE
 * spawning. On a wedged-but-present user bus a 5 000 ms caller (the MCP shim)
 * was stalled for 10 s and then handed an already-expired deadline to
 * `waitForHealthyPidfile`, which returned `health-timeout` without issuing a
 * single /health probe — a false failure for a daemon the plain-spawn fallback
 * had, in fact, started.
 *
 * Two independent guarantees are asserted here, because either alone still
 * leaves a false negative constructible:
 *   1. the spawn is handed the REMAINING budget, so it cannot overrun it; and
 *   2. the health wait probes at least once regardless of the deadline, so an
 *      overrun from any other source still cannot manufacture `health-timeout`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "http";
import { writeFileSync } from "fs";
import { join } from "path";
import { isContainer } from "../src/daemon/container-detect.js";

// `ensureRunning` returns early with `container` / `opted-out` before any of
// this is reachable, so the assertions below would be vacuous there.
const SKIP = isContainer() || process.env["SCRYBE_NO_AUTO_DAEMON"] === "1";

let servers: Server[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  vi.doUnmock("../src/daemon/spawn-detached.js");
  vi.resetModules();
});

/** A minimal always-ready /health responder. Returns its port. */
async function startHealthServer(): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: true, version: "test", uptimeMs: 1, pid: process.pid }));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

function writePidfileAt(dataDir: string, port: number): void {
  writeFileSync(
    join(dataDir, "daemon.pid"),
    JSON.stringify({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      version: "test",
      dataDir,
      execPath: process.execPath,
    }),
    "utf8"
  );
}

/** A port nothing is listening on — makes the pre-spawn health probe fail. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe.skipIf(SKIP)("ensureRunning budget", () => {
  it("hands the spawn what is LEFT of the deadline, not the original timeout", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    writePidfileAt(dataDir, await deadPort());

    const budgets: Array<number | undefined> = [];
    vi.doMock("../src/daemon/spawn-detached.js", () => ({
      spawnDaemonDetachedAsync: vi.fn(async (opts: { budgetMs?: number }) => {
        budgets.push(opts.budgetMs);
      }),
      spawnDaemonDetached: vi.fn(),
      daemonSpawnEnv: (e: NodeJS.ProcessEnv) => e,
    }));

    const { ensureRunning } = await import("../src/daemon/client.js");
    await ensureRunning(2000);

    expect(budgets).toHaveLength(1);
    // Strictly less than the caller's timeout: the pidfile read, the stale
    // /health probe and the spawn lock have already spent part of it. A spawn
    // handed the FULL 2000 here could still overrun the deadline it shares.
    expect(budgets[0]!).toBeGreaterThan(0);
    expect(budgets[0]!).toBeLessThanOrEqual(2000);
  });

  it("does not report health-timeout for a daemon that came up while the spawn overran", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    writePidfileAt(dataDir, await deadPort());
    const livePort = await startHealthServer();

    // The wedged-bus shape, exaggerated: the spawn blows straight past the
    // caller's whole budget — but it DOES leave a serving daemon behind. The
    // pre-fix `while (Date.now() < deadline)` loop never ran its body, so this
    // returned `health-timeout` for a healthy daemon.
    vi.doMock("../src/daemon/spawn-detached.js", () => ({
      spawnDaemonDetachedAsync: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 300));
        writePidfileAt(dataDir, livePort);
      }),
      spawnDaemonDetached: vi.fn(),
      daemonSpawnEnv: (e: NodeJS.ProcessEnv) => e,
    }));

    const { ensureRunning } = await import("../src/daemon/client.js");
    const result = await ensureRunning(100);

    expect(result).toEqual({ ok: true });
  });

  it("still reports health-timeout when nothing is actually serving", async () => {
    // The guarantee above must not have turned `health-timeout` into dead code.
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    writePidfileAt(dataDir, await deadPort());

    vi.doMock("../src/daemon/spawn-detached.js", () => ({
      spawnDaemonDetachedAsync: vi.fn(async () => {}),
      spawnDaemonDetached: vi.fn(),
      daemonSpawnEnv: (e: NodeJS.ProcessEnv) => e,
    }));

    const { ensureRunning } = await import("../src/daemon/client.js");
    expect(await ensureRunning(200)).toEqual({ ok: false, reason: "health-timeout" });
  });
});
