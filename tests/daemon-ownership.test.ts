/**
 * Plan 108 Slice 1 — data-dir ownership integration tests.
 *
 * Spawns real child daemon processes (like tests/daemon-lifecycle.test.ts) to
 * verify the two ship-gate behaviours from `acquireDataDirOwnership()`'s
 * wiring into `runDaemon()`:
 *
 *   1. A second daemon started against an already-owned data dir exits
 *      WITHOUT serving (contended → exit(0) before checkAndMigrate/HTTP bind).
 *   2. When the lock is `unavailable` (simulated via the test-only
 *      SCRYBE_TEST_FORCE_LOCK_ERRNO seam — see data-dir-lock.ts), the daemon
 *      still starts and serves (fail-open), and a diagnostic event is
 *      emitted to the daemon log.
 *
 * Uses a scratch SCRYBE_DATA_DIR per test — never the real
 * `~/.local/share/scrybe` (mandatory per plan 108's execution constraints).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-ownership-test-"));
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 20000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

function readPidfile(pidfilePath: string): { pid: number; port: number } | null {
  if (!existsSync(pidfilePath)) return null;
  try {
    return JSON.parse(readFileSync(pidfilePath, "utf8"));
  } catch {
    return null;
  }
}

async function waitForHealthyPidfile(pidfilePath: string, timeoutMs = 20000): Promise<{ pid: number; port: number }> {
  await waitFor(() => {
    const d = readPidfile(pidfilePath);
    return !!d && (d.port ?? 0) > 0;
  }, timeoutMs);
  return readPidfile(pidfilePath)!;
}

const activeDataDirs: string[] = [];

afterEach(() => {
  for (const d of activeDataDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
});

describe("daemon ownership — contended race on a fresh data dir", () => {
  it("two daemons started concurrently against an empty data dir: exactly one serves, the other exits via the ownership lock", async () => {
    // NOTE: this deliberately reproduces the incident's cold-start race, NOT
    // a sequential double-start. A sequential `daemon start` against an
    // already-healthy pidfile is caught by the PRE-EXISTING outer gate
    // (cli.ts's isDaemonRunning() check, exit 1 — already covered by
    // tests/daemon-lifecycle.test.ts "double-start fails cleanly"). That gate
    // is a TOCTOU check itself: with an empty data dir, isDaemonRunning()
    // returns `running:false` near-instantly for BOTH processes if they are
    // spawned close enough together, and both proceed into runDaemon() —
    // which is exactly where the new ownership lock is the backstop.
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");
    const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

    const procA = spawn(NODE, [ENTRY, "daemon", "start"], { env, stdio: "ignore", detached: false, windowsHide: true });
    const procB = spawn(NODE, [ENTRY, "daemon", "start"], { env, stdio: "ignore", detached: false, windowsHide: true });

    const exited = { a: null as number | null, b: null as number | null };
    procA.once("exit", (code) => { exited.a = code; });
    procB.once("exit", (code) => { exited.b = code; });

    try {
      // The loser exits almost immediately — mkdir + O_EXCL acquire attempt +
      // diagEmit is a handful of sync fs calls, well before checkAndMigrate,
      // HTTP bind, or the pidfile write on the winner's side.
      await waitFor(() => exited.a !== null || exited.b !== null, 15000);

      const loserExitCode = exited.a !== null ? exited.a : exited.b;
      expect(loserExitCode).toBe(0);

      const winnerProc = exited.a !== null ? procB : procA;
      expect(winnerProc.exitCode).toBeNull(); // winner must still be running

      // The winner reaches a healthy, serving pidfile.
      const winnerData = await waitForHealthyPidfile(pidfilePath);
      expect(winnerData.pid).toBe(winnerProc.pid);

      const health = await fetch(`http://127.0.0.1:${winnerData.port}/health`);
      expect(health.ok).toBe(true);

      // Only one daemon ever exited during the whole observation window —
      // the winner did not also get killed off / exit unexpectedly.
      expect(exited.a === null || exited.b === null).toBe(true);
    } finally {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
      if (!procA.killed) procA.kill();
      if (!procB.killed) procB.kill();
    }

    await waitFor(() => !existsSync(pidfilePath), 10000);
  });
});

describe("daemon ownership — unavailable lock (fail-open)", () => {
  it("lock unavailable (forced EACCES) → daemon still starts and serves, diagnostic is emitted", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");
    const logPath = join(dataDir, "daemon-log.jsonl");
    const env = {
      ...process.env,
      SCRYBE_DATA_DIR: dataDir,
      SCRYBE_SKIP_MIGRATION: "1",
      // Test-only fault injection (data-dir-lock.ts) — makes the ownership
      // acquire's underlying lock-create call fail with EACCES, without
      // touching real filesystem permissions on the shared data dir (which
      // would also break pidfile/log writes and make "still starts" moot).
      SCRYBE_TEST_FORCE_LOCK_ERRNO: "EACCES",
    };

    const child = spawn(NODE, [ENTRY, "daemon", "start"], {
      env,
      stdio: "ignore",
      detached: false,
      windowsHide: true,
    });

    try {
      // Fail-open: the daemon must still reach a fully healthy, serving state
      // despite never acquiring ownership.
      const data = await waitForHealthyPidfile(pidfilePath);
      const health = await fetch(`http://127.0.0.1:${data.port}/health`);
      expect(health.ok).toBe(true);

      // A loud diagnostic must be on record.
      await waitFor(() => existsSync(logPath), 10000);
      const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
      const events = lines.map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const unavailableEvent = events.find((e) => e.event === "daemon.ownership.unavailable");
      expect(unavailableEvent).toBeTruthy();
      expect(unavailableEvent.errorCode).toBe("EACCES");
    } finally {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
      if (!child.killed) child.kill();
    }

    await waitFor(() => !existsSync(pidfilePath), 10000);
  });
});
