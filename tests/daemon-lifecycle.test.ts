/**
 * Phase 1 — Daemon lifecycle: start → pidfile present; stop → pidfile gone;
 * double-start → fails cleanly.
 *
 * Spawns real child processes via `tsx` to test the full start/stop flow.
 * Does NOT use the WASM sidecar — no embedding involved.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-daemon-test-"));
}

/** Wait until predicate returns true or timeout elapses. */
async function waitFor(
  check: () => boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
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

describe("daemon lifecycle", () => {
  it("start writes a pidfile with correct shape", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");

    const child = spawn(NODE, [ENTRY, "daemon", "start"], {
      env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
      stdio: "ignore",
      detached: false,
    });

    try {
      await waitFor(() => existsSync(pidfilePath), 5000);

      const data = JSON.parse(readFileSync(pidfilePath, "utf8"));
      expect(data.pid).toBeGreaterThan(0);
      expect(data.version).toBeTruthy();
      expect(data.dataDir).toBe(dataDir);
      expect(data.execPath).toBeTruthy();
      expect(data.startedAt).toBeTruthy();
    } finally {
      // Use daemon stop for reliable cross-platform cleanup (Windows: SIGTERM
      // skips Node.js signal handlers so the daemon won't remove its own pidfile)
      spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
        encoding: "utf8",
        timeout: 8000,
      });
      if (!child.killed) child.kill();
    }

    await waitFor(() => !existsSync(pidfilePath), 3000);
    expect(existsSync(pidfilePath)).toBe(false);
  });

  it("daemon stop removes the pidfile", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");
    const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

    const child = spawn(NODE, [ENTRY, "daemon", "start"], {
      env,
      stdio: "ignore",
      detached: false,
    });

    try {
      await waitFor(() => existsSync(pidfilePath), 5000);

      // Stop via CLI
      const stopResult = spawnSync(NODE, [ENTRY, "daemon", "stop"], {
        env,
        encoding: "utf8",
        timeout: 8000,
      });
      expect(stopResult.status).toBe(0);
    } finally {
      if (!child.killed) child.kill("SIGTERM");
    }

    await waitFor(() => !existsSync(pidfilePath), 5000);
    expect(existsSync(pidfilePath)).toBe(false);
  });

  it("double-start fails cleanly when daemon is running", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");
    const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

    const child = spawn(NODE, [ENTRY, "daemon", "start"], {
      env,
      stdio: "ignore",
      detached: false,
    });

    try {
      await waitFor(() => existsSync(pidfilePath), 5000);

      // Second start should fail (exit 1)
      const second = spawnSync(NODE, [ENTRY, "daemon", "start"], {
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(second.status).toBe(1);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("daemon status reports running while daemon is up", async () => {
    const dataDir = makeDataDir();
    activeDataDirs.push(dataDir);
    const pidfilePath = join(dataDir, "daemon.pid");
    const env = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };

    const child = spawn(NODE, [ENTRY, "daemon", "start"], {
      env,
      stdio: "ignore",
      detached: false,
    });

    try {
      await waitFor(() => existsSync(pidfilePath), 5000);

      const statusResult = spawnSync(NODE, [ENTRY, "daemon", "status"], {
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(statusResult.status).toBe(0);
      const parsed = JSON.parse(statusResult.stdout);
      expect(parsed.pid).toBeGreaterThan(0);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
