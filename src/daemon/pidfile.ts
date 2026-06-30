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

type HealthProbeResult = "healthy" | "refused" | "timeout";

/**
 * Single /health probe that distinguishes three outcomes:
 *   "healthy"  — HTTP 200 OK
 *   "refused"  — TCP connection refused / nothing listening (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH)
 *   "timeout"  — port accepted the connection but /health did not respond in time
 */
async function probeHealthOnce(port: number, timeoutMs: number): Promise<HealthProbeResult> {
  if (port <= 0) return "refused";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? "healthy" : "refused";
  } catch (err: unknown) {
    // AbortSignal.timeout() throws DOMException name="TimeoutError" (Node 18+) or "AbortError"
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return "timeout";
    }
    // Connection-refused class: the listener is gone
    const code: string = (err as any)?.cause?.code ?? "";
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
      return "refused";
    }
    // Unknown error — treat conservatively as refused
    return "refused";
  }
}

/**
 * Probes port up to 3 times over ~1 s to rule out a transient blip.
 *   "timeout"  — returned immediately on the first timeout (port is open, daemon is busy)
 *   "healthy"  — returned immediately on the first success
 *   "refused"  — all probes were refused; the listener is gone
 */
async function probeHealthRetried(port: number): Promise<HealthProbeResult> {
  const PROBES = 3;
  const INTERVAL_MS = 350;
  const PROBE_TIMEOUT_MS = 2000;

  for (let i = 0; i < PROBES; i++) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, INTERVAL_MS));
    const result = await probeHealthOnce(port, PROBE_TIMEOUT_MS);
    if (result !== "refused") return result; // "healthy" or "timeout" — stop immediately
    // "refused" — retry to rule out a transient blip
  }
  return "refused";
}

/**
 * Returns whether a daemon is currently running.
 *
 * - No pidfile             → { running: false }
 * - pid dead               → remove pidfile, { running: false }
 * - pid alive, port open + healthy     → { running: true, data }
 * - pid alive, port open + timeout     → { running: true, data }  (busy/mid-reindex — do not kill)
 * - pid alive, port refused/no-listen  → SIGKILL pid, remove pidfile, { running: false }
 *                                         (zombie: HTTP listener gone but process still occupies
 *                                          memory and file locks — take over)
 *
 * Previously this only probed /health on execPath MISMATCH, which caused a same-execPath
 * zombie (HTTP listener closed, process still alive after rss-guard SIGKILL attempt) to be
 * mistaken for a running daemon, blocking every recovery path.
 */
export async function isDaemonRunning(): Promise<{ running: boolean; data?: PidfileData }> {
  const data = readPidfile();
  if (!data) return { running: false };

  if (!isPidAlive(data.pid)) {
    removePidfile();
    return { running: false };
  }

  // Always probe health — regardless of execPath match.
  const probe = await probeHealthRetried(data.port);

  if (probe === "healthy" || probe === "timeout") {
    // "timeout" = port is accepting connections but /health is slow (e.g. mid-reindex).
    // Daemon is alive — do NOT kill. Treat as running.
    return { running: true, data };
  }

  // probe === "refused" — nothing is listening on the pidfile's port.
  // The recorded process is alive but its HTTP listener is gone (zombie / wedged after an
  // rss-guard ceiling trip). SIGKILL to free memory + DB/file locks, then clear the pidfile
  // so the caller can take over.
  try {
    process.kill(data.pid, "SIGKILL");
  } catch { /* pid may have exited between isPidAlive and now */ }
  removePidfile();
  return { running: false };
}
