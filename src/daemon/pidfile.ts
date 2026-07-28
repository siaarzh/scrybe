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

/**
 * True when `pid` names a process that is still RUNNING.
 *
 * Used for the PIDFILE only. The data-dir locks deliberately do NOT consult
 * this: a SQLite lock is released by the OS when its holder dies, so liveness
 * never has to be inferred there. This is the single implementation for the
 * pidfile paths that genuinely do need to guess whether a recorded pid is
 * still alive.
 *
 *  - A non-integer / non-positive pid can only come from a corrupt lock or
 *    pidfile; treat it as dead rather than letting `process.kill` interpret it
 *    (0 = "this process group", negatives = "that process group").
 *  - `EPERM` AND `EACCES` mean the process exists but belongs to another
 *    user/elevation — Windows surfaces ERROR_ACCESS_DENIED as `EACCES`
 *    (review G7), so treating only `EPERM` as alive reclaimed foreign locks
 *    there.
 *  - Linux only: a ZOMBIE (state `Z`) has already exited and is merely
 *    unreaped, yet still answers `kill(pid, 0)`. Without this refinement a
 *    `kill -9`-ed daemon whose parent never reaps it reads as a live lock
 *    holder forever — a permanent, hand-fix-only outage reachable through the
 *    very remedy `daemon stop` prints.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM" || code === "EACCES";
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0] !== "Z";
  } catch {
    return false; // /proc entry vanished between the two checks — it is gone
  }
}

export interface StopDaemonResult {
  /** True only when the process is provably gone. */
  stopped: boolean;
  /** Set when `stopped` is false — what the caller should tell the user. */
  reason?: "still-draining" | "signal-failed";
  detail?: string;
}

/**
 * Stop a running daemon and REPORT HONESTLY whether it actually stopped
 * (review F2/F6). Shared by `daemon stop`, `daemon restart` and `uninstall`,
 * all three of which previously did the same broken thing: send one SIGTERM,
 * poll the pidfile for 5 s, force-unlink the pidfile, declare success.
 *
 * FORCE-UNLINKING the pidfile under a live process strands data-dir ownership:
 * the next `daemon start` finds no pidfile, starts, loses the ownership lock to
 * the still-draining daemon and exits(0) silently. We never unlink while the
 * pid is alive, and never claim success we cannot prove.
 *
 * ESCALATION IS OPT-IN (review G3). A previous revision fired a SECOND SIGTERM
 * unconditionally after `firstWaitMs`, which trips the daemon's escalation
 * branch → `process.exit(0)`, skipping `stopQueue()` / `cancelAllJobs()` /
 * `closeDB()`. Since no caller passed options, EVERY user-facing stop aborted
 * an in-flight reindex at 5 s and force-exited mid-write-batch — destroying the
 * 30-minute drain that `docs/configuration.md` documents and that the daemon
 * deliberately preserves. The default now sends exactly ONE SIGTERM and reports
 * "still draining"; `opts.force` (wired to `--force` on the CLI) is what asks
 * for the immediate exit.
 */
export async function stopDaemonGracefully(
  pid: number,
  opts?: { force?: boolean; firstWaitMs?: number; escalatedWaitMs?: number; pollMs?: number },
): Promise<StopDaemonResult> {
  const firstWaitMs = opts?.firstWaitMs ?? 5000;
  const escalatedWaitMs = opts?.escalatedWaitMs ?? 10_000;
  const pollMs = opts?.pollMs ?? 100;

  const waitForDeath = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return !isPidAlive(pid);
  };

  const send = (): { ok: true } | { ok: false; gone: boolean; message: string } => {
    try {
      process.kill(pid, "SIGTERM");
      return { ok: true };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      // ESRCH — the process is already gone, which is the outcome we wanted.
      return { ok: false, gone: e?.code === "ESRCH", message: e?.message ?? String(err) };
    }
  };

  const first = send();
  if (!first.ok && !first.gone) {
    return { stopped: false, reason: "signal-failed", detail: first.message };
  }

  if (await waitForDeath(firstWaitMs)) {
    cleanupAfterConfirmedDeath(pid);
    return { stopped: true };
  }

  if (!opts?.force) {
    return {
      stopped: false,
      reason: "still-draining",
      detail:
        `PID ${pid} is still draining — it finishes in-flight work before exiting ` +
        `(up to SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS, 30 min by default)`,
    };
  }

  // --force: a second SIGTERM makes the daemon abandon its drain immediately.
  const second = send();
  if (!second.ok && !second.gone) {
    return { stopped: false, reason: "signal-failed", detail: second.message };
  }

  if (await waitForDeath(escalatedWaitMs)) {
    cleanupAfterConfirmedDeath(pid);
    return { stopped: true };
  }

  return {
    stopped: false,
    reason: "still-draining",
    detail: `PID ${pid} is still alive after two SIGTERMs`,
  };
}

/**
 * Remove a pidfile ONLY once its recorded process is confirmed dead. Covers
 * the Windows case (SIGTERM → TerminateProcess skips the handler, so nothing
 * cleans up) without ever unlinking under a live daemon.
 */
function cleanupAfterConfirmedDeath(pid: number): void {
  const data = readPidfile();
  if (data && data.pid !== pid) return; // someone else's pidfile now — leave it
  removePidfile();
}

type HealthProbeResult = "healthy" | "refused" | "timeout";

/**
 * Single /health probe that distinguishes three outcomes:
 *   "healthy"  — HTTP 200 OK
 *   "refused"  — TCP connection refused / nothing listening (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH)
 *   "timeout"  — port accepted the connection but /health did not respond in time
 */
async function probeHealthOnce(port: number, timeoutMs: number): Promise<HealthProbeResult> {
  // `port` originates from the on-disk pidfile (JSON.parse), so treat it as untrusted:
  // coerce to a bounded TCP port integer before it reaches fetch(). Anything outside the
  // valid range means there is no listener we can reach — report "refused".
  const safePort = Number.isInteger(port) ? port : 0;
  if (safePort <= 0 || safePort > 65535) return "refused";
  try {
    const res = await fetch(`http://127.0.0.1:${safePort}/health`, {
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
