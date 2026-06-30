/**
 * Plan 96 — Regression tests for rss-guard self-restart deadlock fix.
 *
 * Part A — Unit: isDaemonRunning() takeover guard (Phase 1)
 *   - refused port + live same-execPath pid → takes over (SIGKILL + remove pidfile)
 *   - open port that never sends HTTP response (timeout) → leaves running (no kill)
 *   - no pidfile → {running:false}
 *   - dead pid in pidfile → remove pidfile, {running:false}
 *
 * Part B — Integration: rss-guard triggers bounded, blackout-free restart exit (Phase 2)
 *   - real daemon with MAX_RSS_HARD_MB=1 + fast mem-sample exits within bounded time,
 *     removes its pidfile, and no zombie remains.
 *
 * Test dependencies:
 *   - isolate.ts (setupFiles) sets SCRYBE_DATA_DIR + calls vi.resetModules() per test
 *   - dist/index.js must be built with Slice 1 + Slice 2 changes (npm run build)
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as net from "net";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Bind a server on a random port, close it, return the port (now not listening). */
async function getClosedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

// ── Cleanup state (per-file) ──────────────────────────────────────────────────

const childrenToKill: ReturnType<typeof spawn>[] = [];
const serversToClose: net.Server[] = [];
const dirsToRemove: string[] = [];

afterEach(async () => {
  // Kill any spawned children (safe to call on already-dead processes)
  for (const c of childrenToKill) {
    try {
      c.kill("SIGKILL");
    } catch {
      // already dead or never spawned
    }
  }
  childrenToKill.length = 0;

  // Close any net.Server instances
  for (const s of serversToClose) {
    await new Promise<void>((r) => s.close(() => r())).catch(() => {});
  }
  serversToClose.length = 0;

  // Remove extra temp directories created in tests
  for (const d of dirsToRemove) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirsToRemove.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part A — Unit: isDaemonRunning() takeover guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("isDaemonRunning — takeover guard (unit)", () => {
  /**
   * Refused → take over.
   *
   * Pidfile records a live pid whose port is REFUSED (nothing listening).
   * The pid has the SAME execPath as the current process — proving that the
   * old execPath short-circuit that caused D1 is gone.
   *
   * Expected: isDaemonRunning() SIGKILLs the pid, removes the pidfile, returns
   * {running:false}.
   *
   * ⚠️  CRITICAL: the fake-daemon child MUST NOT be process.pid — the SIGKILL
   * inside isDaemonRunning would kill the test runner itself.
   */
  it(
    "refused port + live same-execPath pid → SIGKILLs pid, removes pidfile, returns not-running",
    async () => {
      // Dynamic import so vi.resetModules() (isolate.ts beforeEach) picks up
      // the fresh SCRYBE_DATA_DIR for this test.
      const { isDaemonRunning, writePidfile, getPidfilePath } = await import(
        "../src/daemon/pidfile.js"
      );

      // Spawn a throwaway child that loops forever — acting as the "wedged daemon"
      const fakeDaemon = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1e9)"],
        { windowsHide: true, stdio: "ignore" },
      );
      childrenToKill.push(fakeDaemon);

      // Wait for spawn to succeed and PID to be assigned
      await new Promise<void>((r) => {
        if (fakeDaemon.pid) {
          r();
          return;
        }
        fakeDaemon.once("spawn", r);
      });
      expect(fakeDaemon.pid).toBeDefined();
      expect(isProcessAlive(fakeDaemon.pid!)).toBe(true); // sanity

      // A port that is closed — nobody listening
      const closedPort = await getClosedPort();

      // Write pidfile with the fake daemon's pid, the closed port, and SAME execPath
      // (this is the exact scenario that caused D1: same-execPath zombie)
      writePidfile({
        pid: fakeDaemon.pid!,
        port: closedPort,
        startedAt: new Date().toISOString(),
        version: "0.0.0-test",
        dataDir: process.env["SCRYBE_DATA_DIR"] ?? tmpdir(),
        execPath: process.execPath, // ← same as current runner, proves short-circuit is removed
      });

      const pidfilePath = getPidfilePath();
      expect(existsSync(pidfilePath)).toBe(true); // sanity: pidfile written

      // isDaemonRunning probes the port (refused after 3 attempts ~700ms),
      // then SIGKILLs the fake daemon and removes the pidfile.
      const result = await isDaemonRunning();

      // Core assertions
      expect(result.running).toBe(false);
      expect(existsSync(pidfilePath)).toBe(false); // pidfile must be removed

      // Wait for the fake daemon to be reaped (SIGKILL was sent inside isDaemonRunning)
      await new Promise<void>((resolve) => {
        if (fakeDaemon.exitCode !== null || fakeDaemon.signalCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, 3_000);
        fakeDaemon.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });

      // The fake daemon must now be dead
      expect(
        fakeDaemon.exitCode !== null || fakeDaemon.signalCode !== null,
      ).toBe(true);
    },
    15_000, // 3 probes × 350ms gap + headroom
  );

  /**
   * Timeout → leave running.
   *
   * A port accepts the TCP connection but never sends an HTTP response.
   * The probe times out (AbortSignal.timeout) → result = "timeout".
   * Expected: isDaemonRunning() returns {running:true}, does NOT kill the pid,
   * and the pidfile remains.
   */
  it(
    "open port with no HTTP response (timeout) → returns running, does NOT kill pid",
    async () => {
      const { isDaemonRunning, writePidfile, getPidfilePath } = await import(
        "../src/daemon/pidfile.js"
      );

      // Silent TCP server: accepts the connection but never sends data (no HTTP response)
      const silentServer = net.createServer((socket) => {
        socket.resume(); // drain incoming data, never write back
      });
      serversToClose.push(silentServer);
      await new Promise<void>((r) => silentServer.listen(0, "127.0.0.1", r));
      const openPort = (silentServer.address() as net.AddressInfo).port;

      // Spawn a throwaway child (it will NOT be killed in this code path)
      const fakeDaemon = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1e9)"],
        { windowsHide: true, stdio: "ignore" },
      );
      childrenToKill.push(fakeDaemon);

      await new Promise<void>((r) => {
        if (fakeDaemon.pid) {
          r();
          return;
        }
        fakeDaemon.once("spawn", r);
      });

      writePidfile({
        pid: fakeDaemon.pid!,
        port: openPort,
        startedAt: new Date().toISOString(),
        version: "0.0.0-test",
        dataDir: process.env["SCRYBE_DATA_DIR"] ?? tmpdir(),
        execPath: process.execPath,
      });

      const pidfilePath = getPidfilePath();

      // This call takes ~2000ms (PROBE_TIMEOUT_MS in probeHealthOnce)
      const result = await isDaemonRunning();

      expect(result.running).toBe(true);
      expect(existsSync(pidfilePath)).toBe(true);           // pidfile NOT removed
      expect(isProcessAlive(fakeDaemon.pid!)).toBe(true);  // process NOT killed
    },
    15_000, // 2s probe timeout + headroom
  );

  it("no pidfile → returns {running:false}", async () => {
    const { isDaemonRunning } = await import("../src/daemon/pidfile.js");
    const result = await isDaemonRunning();
    expect(result.running).toBe(false);
  });

  it("dead pid in pidfile → removes pidfile, returns {running:false}", async () => {
    const { isDaemonRunning, writePidfile, getPidfilePath } = await import(
      "../src/daemon/pidfile.js"
    );

    // Use a PID number that is guaranteed not to exist on any platform
    // (Linux max PID is typically 32768 or up to 4194304; 999999999 is safely beyond)
    const deadPid = 999_999_999;

    writePidfile({
      pid: deadPid,
      port: 12345,
      startedAt: new Date().toISOString(),
      version: "0.0.0-test",
      dataDir: process.env["SCRYBE_DATA_DIR"] ?? tmpdir(),
      execPath: process.execPath,
    });

    const pidfilePath = getPidfilePath();
    expect(existsSync(pidfilePath)).toBe(true); // sanity

    const result = await isDaemonRunning();

    expect(result.running).toBe(false);
    expect(existsSync(pidfilePath)).toBe(false); // pidfile removed
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part B — Integration: rss-guard → bounded, blackout-free exit
// ═══════════════════════════════════════════════════════════════════════════════

describe("rss-guard → bounded, blackout-free restart exit (integration)", () => {
  /**
   * Start a real daemon with:
   *   SCRYBE_DAEMON_MAX_RSS_HARD_MB=1    → hard ceiling 1 MB; always exceeded
   *   SCRYBE_DAEMON_MEM_SAMPLE_MS=300    → first rss-guard tick after 300ms
   *   SCRYBE_DAEMON_RESTART_DRAIN_MS=500 → short drain cap (post-fix: used for rss-guard)
   *
   * Assert:
   *   1. Pidfile appears (daemon fully started)
   *   2. Pidfile disappears within bounded time (daemon removed it before exiting)
   *   3. Daemon process has exited (no zombie)
   *
   * Pre-fix, the daemon would hold the pidfile indefinitely:
   *   D1 — the replacement bailed "already running" (same-execPath short-circuit)
   *   D3 — the drain cap was 30 min, not the ~500ms configured here
   * Post-fix, the daemon exits promptly via the short restart-drain cap and the
   * corrected doRestart ordering.
   */
  it(
    "exits within bounded time, removes pidfile, no zombie",
    async () => {
      // Use a dedicated DATA_DIR for the daemon so isolate.ts cleanup doesn't
      // interfere with an in-flight daemon process.
      const daemonDataDir = mkdtempSync(
        join(tmpdir(), "scrybe-plan96-integ-"),
      );
      dirsToRemove.push(daemonDataDir);

      const pidfilePath = join(daemonDataDir, "daemon.pid");

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SCRYBE_DATA_DIR: daemonDataDir,
        SCRYBE_SKIP_MIGRATION: "1",
        // Trip the hard ceiling immediately (any Node.js process uses >1 MB RSS)
        SCRYBE_DAEMON_MAX_RSS_HARD_MB: "1",
        // First rss-guard tick after 300ms
        SCRYBE_DAEMON_MEM_SAMPLE_MS: "300",
        // Short drain cap for rss-guard exit path (post-fix setting; pre-fix ignored this)
        SCRYBE_DAEMON_RESTART_DRAIN_MS: "500",
        // Keep no-client-ever timer from racing (it's .unref()-ed but be explicit)
        SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "999999999",
      };
      // Ensure on-demand mode: no self-spawn after exit
      delete env["SCRYBE_DAEMON_KEEP_ALIVE"];

      const daemonChild = spawn(NODE, [ENTRY, "daemon", "start"], {
        env,
        stdio: "ignore",
        windowsHide: true,
        detached: false,
      });
      childrenToKill.push(daemonChild);

      // Phase 1: wait for daemon to fully start (pidfile written)
      await waitFor(() => existsSync(pidfilePath) || daemonChild.exitCode !== null, 20_000);
      if (!existsSync(pidfilePath)) {
        throw new Error(
          `Daemon exited early (code=${daemonChild.exitCode}) before writing pidfile`,
        );
      }

      // Phase 2: wait for rss-guard to trip + daemon to remove pidfile and exit.
      // Pre-fix: this hangs forever (30-min cap + D1 block).
      // Post-fix: pidfile gone within mem-sample interval (300ms) + drain cap (500ms) + overhead.
      await waitFor(() => !existsSync(pidfilePath), 10_000);

      expect(existsSync(pidfilePath)).toBe(false);

      // Phase 3: verify the process actually exited (not a zombie holding memory)
      await new Promise<void>((resolve) => {
        if (daemonChild.exitCode !== null || daemonChild.signalCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, 5_000);
        daemonChild.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });

      expect(
        daemonChild.exitCode !== null || daemonChild.signalCode !== null,
      ).toBe(true);
    },
    45_000, // 20s startup window + 10s exit window + headroom
  );
});
