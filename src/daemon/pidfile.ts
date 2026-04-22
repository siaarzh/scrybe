import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";

export interface PidfileData {
  pid: number;
  port: number;      // 0 until HTTP server starts (Phase 2)
  startedAt: string; // ISO
  version: string;
  dataDir: string;
  execPath: string;
}

export function getPidfilePath(): string {
  return process.env["SCRYBE_DAEMON_PIDFILE"] ?? join(config.dataDir, "daemon.pid");
}

export function writePidfile(data: PidfileData): void {
  writeFileSync(getPidfilePath(), JSON.stringify(data), "utf8");
}

export function readPidfile(): PidfileData | null {
  const p = getPidfilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PidfileData;
  } catch {
    return null;
  }
}

export function removePidfile(): void {
  try {
    unlinkSync(getPidfilePath());
  } catch { /* no-op if already gone */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(port: number): Promise<boolean> {
  if (port <= 0) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns whether a daemon is currently running.
 * - pid dead → stale (removes pidfile, returns false)
 * - pid alive + execPath matches → running
 * - pid alive + execPath mismatch → PID reuse; probe /health; if fail → stale
 */
export async function isDaemonRunning(): Promise<{ running: boolean; data?: PidfileData }> {
  const data = readPidfile();
  if (!data) return { running: false };

  if (!isPidAlive(data.pid)) {
    removePidfile();
    return { running: false };
  }

  if (data.execPath !== process.execPath) {
    const healthy = await probeHealth(data.port);
    if (!healthy) {
      removePidfile();
      return { running: false };
    }
  }

  return { running: true, data };
}
