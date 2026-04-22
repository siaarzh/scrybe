/**
 * Phase 9 — scrybe daemon status (plain mode).
 * Tests the non-Ink `scrybe daemon status` command:
 *   - offline: prints "Daemon is not running." and exits 0
 *   - online: returns a valid DaemonStatus JSON shape
 *
 * The Ink --watch mode requires a live terminal; smoke-tested manually.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, spawn } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { formatUptime, formatEvent } from "../src/daemon/status-utils.js";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

// ─── Formatting helpers (pure, no React) ─────────────────────────────────────

describe("formatUptime", () => {
  it("shows seconds under 1 min", () => {
    expect(formatUptime(45_000)).toBe("45s");
  });
  it("shows minutes and seconds", () => {
    expect(formatUptime(3 * 60_000 + 7_000)).toBe("3m 7s");
  });
  it("shows hours and minutes", () => {
    expect(formatUptime(2 * 3600_000 + 15 * 60_000 + 30_000)).toBe("2h 15m");
  });
});

describe("formatEvent", () => {
  it("includes level, event, and projectId", () => {
    const e = {
      ts: new Date("2026-04-22T10:00:00.000Z").toISOString(),
      level: "info" as const,
      event: "job.completed" as const,
      projectId: "my-proj",
    };
    const out = formatEvent(e);
    expect(out).toContain("INFO");
    expect(out).toContain("job.completed");
    expect(out).toContain("[my-proj]");
  });

  it("includes phase detail when present", () => {
    const e = {
      ts: new Date().toISOString(),
      level: "warn" as const,
      event: "watcher.event" as const,
      detail: { phase: "fetch-poller" },
    };
    expect(formatEvent(e)).toContain("(fetch-poller)");
  });
});

// ─── CLI plain mode — offline ─────────────────────────────────────────────────

describe("scrybe daemon status — offline", () => {
  it("prints 'Daemon is not running.' when no pidfile exists", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scrybe-status-test-"));
    const result = spawnSync(NODE, [ENTRY, "daemon", "status"], {
      env: {
        ...process.env,
        SCRYBE_DATA_DIR: dataDir,
        SCRYBE_SKIP_MIGRATION: "1",
      },
      encoding: "utf8",
      timeout: 8000,
    });
    try {
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("Daemon is not running.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ─── CLI plain mode — online ──────────────────────────────────────────────────

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
  for (const c of activeChildren) { if (!c.killed) c.kill(); }
  for (const dir of activeDataDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
  activeChildren.length = 0;
});

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil timed out");
}

async function startDaemon(): Promise<{ port: number; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "scrybe-status-daemon-"));
  activeDataDirs.push(dataDir);
  const pidfilePath = join(dataDir, "daemon.pid");
  const env = {
    ...process.env,
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_DAEMON_PORT: "0",
  };
  const child = spawn(NODE, [ENTRY, "daemon", "start"], { env, stdio: "ignore", detached: false });
  activeChildren.push(child);
  await waitUntil(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port: number };
      return d.port > 0;
    } catch { return false; }
  });
  await waitUntil(async () => {
    const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port: number };
    try { return (await fetch(`http://127.0.0.1:${d.port}/health`)).ok; } catch { return false; }
  });
  const { port } = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port: number };
  return { port, dataDir };
}

describe("scrybe daemon status — online", () => {
  it("returns valid DaemonStatus JSON when daemon is running", async () => {
    const { dataDir } = await startDaemon();
    const result = spawnSync(NODE, [ENTRY, "daemon", "status"], {
      env: {
        ...process.env,
        SCRYBE_DATA_DIR: dataDir,
        SCRYBE_SKIP_MIGRATION: "1",
      },
      encoding: "utf8",
      timeout: 8000,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      version: expect.any(String),
      pid: expect.any(Number),
      port: expect.any(Number),
      uptimeMs: expect.any(Number),
      state: expect.stringMatching(/^(hot|cold|paused)$/),
      projects: expect.any(Array),
      queue: expect.objectContaining({ active: expect.any(Number), pending: expect.any(Number) }),
    });
  });
});
