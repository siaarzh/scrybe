/**
 * Plan 108 Slice 2 — spawn serialisation integration tests.
 *
 * Verifies that `ensureRunning()`'s check→spawn window (`client.ts`) is now
 * serialised across PROCESSES via the spawn lock (Plan 108 slice 1's
 * `acquireSpawnLock`/`releaseSpawnLock`), for both:
 *
 *   1. Cold start — N concurrent `ensureRunning()` callers against an empty
 *      data dir must yield exactly one daemon.
 *   2. The mid-restart window — the RSS-guard's on-demand-mode shutdown path
 *      (release ownership + pidfile, NO replacement spawned) reopens a
 *      genuine "daemon absent" window on every restart. N concurrent
 *      `ensureRunning()` callers landing in that window must still yield
 *      exactly one daemon. This is the case the incident actually hit — a
 *      cold-start-only test does not discharge this gate.
 *
 * Both scenarios spawn REAL, independent OS processes (via a harness script
 * that calls the compiled `ensureRunning()` and prints its result), not
 * mocks — this mirrors the incident's actual shape (N pmux sessions each
 * being a separate process) and is the same style slice 1 used to catch its
 * TOCTOU (only real process stress caught it, not unit-level assertions).
 *
 * Also covers: a stale spawn lock (crashed holder) does not deadlock a
 * subsequent `ensureRunning()` caller.
 *
 * Uses a scratch SCRYBE_DATA_DIR per test — never the real
 * `~/.local/share/scrybe` (mandatory per plan 108's execution constraints).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { holdLock, killHeldLocks, probeLock } from "./helpers/lock-probe.js";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");
const HARNESS = join(process.cwd(), "tests/helpers/ensure-running-harness.mjs");

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-spawn-lock-test-"));
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

/** Runs the ensure-running harness as a real child process; resolves with its parsed stdout JSON. */
function runHarness(env: NodeJS.ProcessEnv, timeoutMs = 20000): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [HARNESS, String(timeoutMs)], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.once("exit", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}"));
      } catch (err) {
        reject(new Error(`harness produced unparseable output: ${JSON.stringify(out)} (${err})`));
      }
    });
    child.once("error", reject);
  });
}

function countLogEvents(logPath: string, eventName: string): number {
  if (!existsSync(logPath)) return 0;
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    try {
      if (JSON.parse(line).event === eventName) count++;
    } catch { /* ignore malformed */ }
  }
  return count;
}

const activeDataDirs: string[] = [];

afterEach(() => {
  // Reap lock holders BEFORE deleting their data dirs — a live holder keeps an
  // open SQLite handle into the dir it is locking.
  killHeldLocks();
  for (const d of activeDataDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
});

describe("spawn serialisation — cold start", () => {
  it(
    "N concurrent ensureRunning() callers (real processes) against an empty data dir yield exactly one daemon",
    async () => {
      const dataDir = makeDataDir();
      activeDataDirs.push(dataDir);
      const pidfilePath = join(dataDir, "daemon.pid");
      const logPath = join(dataDir, "daemon-log.jsonl");
      const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

      const N = 5;
      const results = await Promise.all(
        Array.from({ length: N }, () => runHarness(env, 20000))
      );

      try {
        // Every caller must eventually see a healthy daemon.
        for (const r of results) expect(r.ok).toBe(true);

        const winner = await waitForHealthyPidfile(pidfilePath);
        const health = await fetch(`http://127.0.0.1:${winner.port}/health`);
        expect(health.ok).toBe(true);

        // Exactly one real "daemon start" child process was ever spawned —
        // the whole point of the spawn lock. If serialisation regressed,
        // this would read N (one per losing caller that raced its own spawn).
        expect(countLogEvents(logPath, "child-process.spawn")).toBe(1);
      } finally {
        spawnSync(NODE, [ENTRY, "daemon", "stop"], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
      }

      await waitFor(() => !existsSync(pidfilePath), 10000);
    },
    30000
  );
});

describe("spawn serialisation — mid-restart window", () => {
  it(
    "N concurrent ensureRunning() callers landing in the on-demand-mode 'daemon absent' shutdown window yield exactly one daemon",
    async () => {
      const dataDir = makeDataDir();
      activeDataDirs.push(dataDir);
      const pidfilePath = join(dataDir, "daemon.pid");
      const logPath = join(dataDir, "daemon-log.jsonl");
      const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

      // Start the first daemon directly (not via ensureRunning) — this is
      // the "long-lived daemon that later gets RSS-guard-restarted" role.
      const firstProc = spawn(NODE, [ENTRY, "daemon", "start"], { env, stdio: "ignore", detached: false, windowsHide: true });

      try {
        const first = await waitForHealthyPidfile(pidfilePath);

        // Trigger the exact same release-ownership-then-exit-without-respawn
        // shape the RSS-guard uses in on-demand mode: POST /shutdown wires to
        // the same shutdown() call with no spawnAfterRemovePidfile, so no
        // replacement is spawned by this process — the "absent window" from
        // the incident write-up (main.ts:~474).
        const shutdownRes = await fetch(`http://127.0.0.1:${first.port}/shutdown`, { method: "POST" });
        expect(shutdownRes.ok).toBe(true);

        // Wait until the window actually opens (pidfile gone).
        await waitFor(() => !existsSync(pidfilePath), 10000);

        // Now race N concurrent ensureRunning() callers (real processes)
        // squarely into that window.
        const N = 5;
        const results = await Promise.all(
          Array.from({ length: N }, () => runHarness(env, 20000))
        );
        for (const r of results) expect(r.ok).toBe(true);

        const replacement = await waitForHealthyPidfile(pidfilePath);
        const health = await fetch(`http://127.0.0.1:${replacement.port}/health`);
        expect(health.ok).toBe(true);

        // The first daemon was started directly (no spawnDaemonDetached), so
        // it contributes zero "child-process.spawn" events. Exactly one of
        // the N racing callers must have won the spawn lock and actually
        // spawned the replacement.
        expect(countLogEvents(logPath, "child-process.spawn")).toBe(1);
      } finally {
        spawnSync(NODE, [ENTRY, "daemon", "stop"], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
        if (!firstProc.killed) firstProc.kill();
      }

      await waitFor(() => !existsSync(pidfilePath), 10000);
    },
    40000
  );
});

describe("rss-guard restart — contended spawn lock must not produce ZERO daemons (review F1)", () => {
  it(
    "an always-on daemon restarting while another process holds the spawn lock still spawns its replacement",
    async () => {
      // THE HEADLINE REGRESSION. shutdown() used to acquire the spawn lock
      // LATE and SKIP its own respawn when it read "contended", deferring to
      // whoever held it. That deference is unsound: the contender is normally
      // an ensureRunning() caller that already spawned a daemon while THIS
      // process still owned the data dir — so that daemon exited(0) on
      // contended ownership. Skipping then leaves nobody serving, and because
      // this process exits 0, systemd's Restart=on-failure never resurrects
      // it. A duplicate is self-healing (the loser exits via the ownership
      // lock); zero daemons is a silent outage.
      const dataDir = makeDataDir();
      activeDataDirs.push(dataDir);
      const pidfilePath = join(dataDir, "daemon.pid");
      const spawnLockPath = join(dataDir, "daemon-spawn.lock");

      const env = {
        ...process.env,
        SCRYBE_DATA_DIR: dataDir,
        SCRYBE_SKIP_MIGRATION: "1",
        // Always-on → shutdown() takes the spawnAfterRemovePidfile path.
        SCRYBE_DAEMON_KEEP_ALIVE: "1",
        // Trip the hard RSS ceiling on the first sampler tick (any Node
        // process is > 1 MB). Interval is deliberately long so each generation
        // lives long enough for us to reap it before it restarts in turn.
        SCRYBE_DAEMON_MAX_RSS_HARD_MB: "1",
        SCRYBE_DAEMON_MEM_SAMPLE_MS: "3000",
        SCRYBE_DAEMON_RESTART_DRAIN_MS: "200",
        SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "999999999",
      };

      const reaped: number[] = [];
      const firstProc = spawn(NODE, [ENTRY, "daemon", "start"], { env, stdio: "ignore", detached: false, windowsHide: true });

      try {
        const first = await waitForHealthyPidfile(pidfilePath);

        // Hold the spawn lock in a real foreign process, so the daemon's
        // acquire reads "contended". It cannot be planted as a file: the lock
        // is an open SQLite write transaction, which only a live process holds.
        const holder = await holdLock(dataDir, "spawn");

        // Wait for the rss-guard tick to take the daemon down and a
        // REPLACEMENT to appear. Pre-fix this never happens: the pidfile
        // vanishes and stays gone.
        await waitFor(() => {
          const d = readPidfile(pidfilePath);
          return !!d && d.pid !== first.pid && (d.port ?? 0) > 0;
        }, 25000);

        const replacement = readPidfile(pidfilePath)!;
        expect(replacement.pid).not.toBe(first.pid);
        const health = await fetch(`http://127.0.0.1:${replacement.port}/health`);
        expect(health.ok).toBe(true);

        // Non-vacuity: the lock must still be held by our holder. If it had
        // somehow been released, the daemon would have seen "acquired" and the
        // contended branch — the whole point of this test — would never have
        // run. Asked from a third process, so the answer is the real one.
        const stillHeld = probeLock(dataDir, "spawn");
        expect(stillHeld.outcome).toBe("contended");
        expect(stillHeld.heldByPid).toBe(holder.pid);
      } finally {
        // Reap the restart cascade deterministically: SIGKILL is not catchable
        // so a killed generation cannot spawn a successor. Bounded loop, and
        // the mem-sample interval (3 s) gives ample margin per generation.
        for (let i = 0; i < 30; i++) {
          const d = readPidfile(pidfilePath);
          if (!d) { await new Promise((r) => setTimeout(r, 200)); if (!readPidfile(pidfilePath)) break; continue; }
          try { process.kill(d.pid, "SIGKILL"); reaped.push(d.pid); } catch { /* already gone */ }
          try { rmSync(pidfilePath, { force: true }); } catch { /* ignore */ }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!firstProc.killed) { try { firstProc.kill("SIGKILL"); } catch { /* ignore */ } }
      }
    },
    60000
  );
});

describe("spawn serialisation — a crashed spawn-lock holder does not deadlock", () => {
  it("ensureRunning() proceeds after the spawn-lock holder is killed, instead of waiting forever", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");
    const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

    // A REAL crashed holder: take the spawn lock in a foreign process, then
    // SIGKILL it so no cleanup code of ours can possibly run. The previous
    // file-based lock survived its holder, so this scenario needed a staleness
    // heuristic to recover from; a SQLite lock dies with its process, and this
    // asserts that end-to-end through ensureRunning() rather than trusting it.
    //
    // If the lock somehow outlived the holder, this caller would wait out its
    // whole timeout budget polling a pidfile nobody ever creates and fail with
    // (ok: false, reason: "health-timeout") instead.
    const crashed = await holdLock(dataDir, "spawn");
    crashed.child.kill("SIGKILL");
    await waitFor(() => {
      try { process.kill(crashed.pid, 0); return false; } catch { return true; }
    }, 5000);

    try {
      const result = await runHarness(env, 20000);
      expect(result.ok).toBe(true);

      const winner = await waitForHealthyPidfile(pidfilePath);
      const health = await fetch(`http://127.0.0.1:${winner.port}/health`);
      expect(health.ok).toBe(true);
    } finally {
      spawnSync(NODE, [ENTRY, "daemon", "stop"], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
    }

    await waitFor(() => !existsSync(pidfilePath), 10000);
  }, 30000);
});
