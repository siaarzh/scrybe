/**
 * Test-side wrapper around `lock-probe.mjs` — see that file for why observing a
 * lock requires a separate OS process.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { join } from "path";

export type ProbeOutcome = "acquired" | "contended" | "unavailable" | "exception";

export interface LockProbeResult {
  outcome: ProbeOutcome;
  heldByPid?: number;
  message?: string;
}

const PROBE = join(process.cwd(), "tests", "helpers", "lock-probe.mjs");

/** Ask a foreign process whether `name` is currently held on `dataDir`. */
export function probeLock(dataDir: string, name: "owner" | "spawn" | "migrate"): LockProbeResult {
  const r = spawnSync(process.execPath, [PROBE, name], {
    env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!line) {
    return { outcome: "exception", message: `no probe output (status ${r.status}): ${r.stderr}` };
  }
  try {
    return JSON.parse(line) as LockProbeResult;
  } catch {
    return { outcome: "exception", message: `unparseable probe output: ${line}` };
  }
}

/**
 * True when a foreign process cannot take the lock — i.e. somebody holds it.
 * Deliberately treats only "contended" as held: "unavailable" means the data
 * dir cannot arbitrate at all, which is a different condition entirely.
 */
export function isLockHeld(dataDir: string, name: "owner" | "spawn" | "migrate"): boolean {
  return probeLock(dataDir, name).outcome === "contended";
}

const HOLDER = join(process.cwd(), "tests", "helpers", "lock-holder.mjs");

/** Every holder started via `holdLock`, so a suite can reap them in afterEach. */
const _holders: ChildProcess[] = [];

/**
 * Start a foreign process that takes `name` and holds it until killed.
 * Resolves once the lock is confirmed taken.
 *
 * A held SQLite lock cannot be simulated by writing a file — it is an open
 * write transaction owned by a live process — so tests that need a contended
 * lock must create one for real.
 */
export function holdLock(
  dataDir: string,
  name: "owner" | "spawn" | "migrate",
): Promise<{ child: ChildProcess; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, name], {
      env: { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    _holders.push(child);

    let buf = "";
    const timer = setTimeout(() => reject(new Error(`lock holder for "${name}" did not report within 15s`)), 15_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      let parsed: { pid: number; outcome: string; message?: string };
      try {
        parsed = JSON.parse(buf.slice(0, nl).trim()) as { pid: number; outcome: string; message?: string };
      } catch {
        reject(new Error(`bad holder output: ${buf}`));
        return;
      }
      if (parsed.outcome !== "acquired") {
        reject(new Error(`holder failed to acquire ${name}: ${parsed.outcome} ${parsed.message ?? ""}`));
        return;
      }
      resolve({ child, pid: parsed.pid });
    });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** SIGKILL every holder started by `holdLock`. Call from afterEach. */
export function killHeldLocks(): void {
  for (const h of _holders) {
    try { h.kill("SIGKILL"); } catch { /* already gone */ }
  }
  _holders.length = 0;
}
