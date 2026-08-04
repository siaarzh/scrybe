import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, delimiter } from "path";
import { config } from "../config.js";
import { diagEmit } from "./events.js";

/**
 * Merges glibc allocator-arena caps into a daemon spawn env, respecting any
 * value the user has already set. `MALLOC_ARENA_MAX=2` + a lower trim
 * threshold stop glibc from hoarding freed memory in per-thread arenas —
 * measured ~793 MB -> ~128 MB retained RSS after sustained vector scans
 * (see ADR-0009). glibc reads these at process init, so they must be present
 * in the child's env at spawn time, not set afterward. No-op on
 * Windows/musl (different allocator) — harmless to set unconditionally.
 */
export function daemonSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    MALLOC_ARENA_MAX: base.MALLOC_ARENA_MAX ?? "2",
    MALLOC_TRIM_THRESHOLD_: base.MALLOC_TRIM_THRESHOLD_ ?? "131072",
  };
}

/**
 * Spawns `scrybe daemon start` as a detached, fully independent process.
 * The spawned process is unref'd immediately so it outlives the parent.
 *
 * On Windows, routes through a tiny wscript.exe + VBS launcher because
 * spawning node.exe directly — even with `windowsHide: true` and
 * `detached: true` — briefly flashes a console window during node init.
 * wscript.exe is a GUI-subsystem binary, so it allocates no console at all,
 * and `Run(cmd, 0, false)` launches the child fully hidden.
 *
 * Uses process.execPath (node binary) + process.argv[1] (dist/index.js or the
 * globally-installed scrybe script) so it works in both dev and production.
 */
export function spawnDaemonDetached(opts: {
  execPath?: string;
  entryScript?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the cgroup cap (MB) for this spawn. 0 disables the wrapper. */
  cgroupMaxMb?: number;
}): void {
  const node   = opts.execPath   ?? process.execPath;
  const script = opts.entryScript ?? process.argv[1]!;
  const env    = daemonSpawnEnv(opts.env ?? process.env);

  if (process.platform === "win32") {
    const vbs = ensureWindowsLauncherVbs();
    const child = spawn("wscript.exe", [vbs, node, script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    diagEmit({
      event: "child-process.spawn",
      level: "info",
      pid: child.pid ?? null,
      ppid: process.pid,
      command: "wscript.exe",
      args: [vbs, node, script],
      detached: true,
    });
    child.once("exit", (code, signal) => {
      diagEmit({
        event: "child-process.exit",
        level: "info",
        pid: child.pid ?? null,
        ppid: process.pid,
        exitCode: code,
        signal: signal ?? null,
      });
    });
    child.unref();
    return;
  }

  const capMb = opts.cgroupMaxMb ?? config.daemonCgroupMaxMb;
  const status = describeDaemonMemoryCap({ env, platform: process.platform, capMb });

  if (status.mode === "capped") {
    // Decided SYNCHRONOUSLY (see spawnViaSystemdRun): callers such as
    // main.ts's two self-restart sites call process.exit(0) on the next line,
    // so a fallback that needed another turn of the event loop would never run
    // and a failed wrapper would leave the host with no daemon at all.
    if (spawnViaSystemdRun({ node, script, env, status })) return;
    // Wrapper did not start — fall through to a plain spawn so a broken cgroup
    // path can never mean "no daemon at all".
  } else {
    diagEmit({
      event: "daemon.cgroup-cap.skipped",
      level: "debug",
      reason: status.reason,
    });
  }

  spawnPlainDetached(node, script, env);
}

/** Today's unwrapped detached spawn — also the fallback when no cgroup cap applies. */
function spawnPlainDetached(node: string, script: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(node, [script, "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  diagEmit({
    event: "child-process.spawn",
    level: "info",
    pid: child.pid ?? null,
    ppid: process.pid,
    command: node,
    args: [script, "daemon", "start"],
    detached: true,
  });
  child.once("exit", (code, signal) => {
    diagEmit({
      event: "child-process.exit",
      level: "info",
      pid: child.pid ?? null,
      ppid: process.pid,
      exitCode: code,
      signal: signal ?? null,
    });
  });
  child.unref();
}

// ─── Linux: kernel-enforced memory cap via a transient systemd user service ───

/**
 * Environment variables the systemd user manager sets for a unit itself.
 * Forwarding the spawner's copies would lie to the child about its own
 * activation, so they are dropped from the `--setenv` list.
 */
const SYSTEMD_OWNED_ENV_KEYS = new Set([
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "LISTEN_FDNAMES",
  "LISTEN_FDS",
  "LISTEN_PID",
  "MAINPID",
  "MANAGERPID",
  "NOTIFY_SOCKET",
  "SYSTEMD_EXEC_PID",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
]);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether the resulting daemon will be memory-capped, and if not, why not. */
export type DaemonMemoryCapStatus =
  | { mode: "capped"; wrapper: "systemd-run"; limitMb: number; systemdRunPath: string }
  | { mode: "uncapped"; reason: DaemonMemoryCapSkipReason };

export type DaemonMemoryCapSkipReason =
  | "not-linux"
  | "disabled-by-config"
  | "no-user-bus"
  | "systemd-run-not-found";

/**
 * Resolves — without executing anything — whether the next daemon spawn gets a
 * kernel-enforced memory cap. Consumed by `spawnDaemonDetached` and by the
 * doctor/diagnostics surface, which must be able to report the mode without
 * spawning a daemon.
 *
 * The probe is deliberately exec-free (env inspection + a PATH stat) so it
 * cannot hang: a `systemd-run --version` round-trip would block on the D-Bus
 * connect in exactly the degraded environments this needs to detect.
 */
export function describeDaemonMemoryCap(opts: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  capMb?: number;
} = {}): DaemonMemoryCapStatus {
  const env      = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const capMb    = opts.capMb ?? config.daemonCgroupMaxMb;

  if (platform !== "linux") return { mode: "uncapped", reason: "not-linux" };
  if (!Number.isFinite(capMb) || capMb <= 0) {
    return { mode: "uncapped", reason: "disabled-by-config" };
  }
  // A transient --user unit needs a reachable user manager. Both markers are
  // absent under headless cron, in most containers, and in `su`-style sessions.
  if (!env["DBUS_SESSION_BUS_ADDRESS"] && !env["XDG_RUNTIME_DIR"]) {
    return { mode: "uncapped", reason: "no-user-bus" };
  }
  const systemdRunPath = findOnPath("systemd-run", env);
  if (!systemdRunPath) return { mode: "uncapped", reason: "systemd-run-not-found" };

  return { mode: "capped", wrapper: "systemd-run", limitMb: Math.floor(capMb), systemdRunPath };
}

/** First PATH entry containing an existing `name`, or null. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A unit name that cannot collide with a stale or failed earlier unit. */
export function makeDaemonUnitName(): string {
  return `scrybe-daemon-${process.pid}-${randomBytes(4).toString("hex")}.service`;
}

/**
 * Builds the `systemd-run` argv (options + command), excluding argv[0].
 *
 * - `MemoryMax` and NOT `MemoryHigh`: MemoryHigh throttles instead of killing,
 *   and the daemon's memory is anonymous with nothing to reclaim, so it stalls
 *   in uninterruptible sleep while still holding the ownership lock and the
 *   HTTP listener — i.e. it manufactures the exact "listening but /health never
 *   answers" wedge this cap exists to prevent. MemoryMax OOM-kills instead, and
 *   the data-dir lock is re-acquirable within ~50 ms of a SIGKILL.
 * - `MemorySwapMax=0`: without it the cgroup spills to swap and the runaway
 *   still takes the host down, just more slowly.
 * - `Restart=no`: the shim-spawned deployment has no auto-restart today
 *   (recovery is the MCP shim's `ensureRunning()` on the next tool call).
 *   systemd must not invent a restart policy this path never had.
 * - `--collect`: a transient unit that failed or was OOM-killed otherwise
 *   lingers in `failed` state and blocks reuse of its name.
 * - `--setenv=NAME` (NAME-ONLY, never `NAME=VALUE`): a transient unit inherits
 *   the *user manager's* environment, not the caller's, so every variable the
 *   daemon needs (SCRYBE_*, MALLOC_*, PATH) must be forwarded explicitly — but
 *   the `NAME=VALUE` form puts every value in `systemd-run`'s argv, i.e. in
 *   world-readable `/proc/<pid>/cmdline` (default `hidepid=0`) and in
 *   `systemctl --user show <unit>`. That leaks SCRYBE_EMBEDDING_API_KEY /
 *   OPENAI_API_KEY to any local user. The name-only form makes systemd-run
 *   read the value from its OWN environment (which we hand it via `spawn`'s
 *   `env`) and pass it over the private D-Bus connection, so argv carries only
 *   the variable NAME. Verified on systemd 255.
 *
 *   Name-only `--setenv` needs a reasonably recent systemd; older releases
 *   reject an assignment without `=` and exit non-zero WITHOUT starting a unit.
 *   That is caught by the synchronous launch check in `spawnViaSystemdRun`,
 *   which then falls back to the plain (uncapped) spawn. Degrading to
 *   "uncapped but correct and leak-free" beats "capped but leaking secrets".
 *
 *   Specifier expansion (`%h`, `%%`, …) applied to forwarded VALUES under the
 *   `NAME=VALUE` form is moot here for two reasons: values no longer traverse
 *   argv at all, and a NAME is constrained by `ENV_NAME_RE` to
 *   `[A-Za-z_][A-Za-z0-9_]*`, which cannot contain `%`.
 * - `WorkingDirectory=-<cwd>`: preserves the spawner's cwd, which a relative
 *   `SCRYBE_DATA_DIR` resolves against. The leading `-` makes a missing
 *   directory non-fatal (a spawner running from a deleted worktree must still
 *   get a daemon).
 */
export function buildSystemdRunArgs(opts: {
  node: string;
  script: string;
  unitName: string;
  limitMb: number;
  env: NodeJS.ProcessEnv;
  workingDir?: string | null;
}): string[] {
  const args = [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${opts.unitName}`,
    "--description=scrybe daemon (memory-capped)",
    "-p", `MemoryMax=${opts.limitMb}M`,
    "-p", "MemorySwapMax=0",
    "-p", "Restart=no",
  ];

  if (opts.workingDir) args.push("-p", `WorkingDirectory=-${opts.workingDir}`);

  for (const [key, value] of Object.entries(opts.env)) {
    if (value === undefined) continue;
    if (SYSTEMD_OWNED_ENV_KEYS.has(key)) continue;
    if (!ENV_NAME_RE.test(key)) continue;
    // systemd cannot carry NUL or newlines in a unit property value; skipping
    // the variable is strictly better than failing the whole spawn. The value
    // is still inspected (not forwarded) — it reaches the unit out-of-band,
    // via systemd-run's own environment, so only the NAME goes in argv.
    if (/[\0\n\r]/.test(value)) continue;
    args.push(`--setenv=${key}`);
  }

  args.push("--", opts.node, opts.script, "daemon", "start");
  return args;
}

/**
 * How long we are willing to block waiting for `systemd-run` to enqueue the
 * unit's start job. It is a D-Bus client that returns as soon as the job is
 * queued (measured well under a second on a healthy user manager), so this is
 * a stuck-bus ceiling, not an expected wait.
 */
const SYSTEMD_RUN_TIMEOUT_MS = 10_000;

/**
 * Spawns the daemon inside a transient systemd user service. Returns true only
 * when `systemd-run` reported success — i.e. the start job was accepted.
 *
 * WHY THIS IS SYNCHRONOUS (`spawnSync`, not `spawn`). The fallback to a plain
 * spawn used to hang off `child.once("exit")`, which is unreachable from the
 * daemon's two self-restart call sites (`main.ts`): both call
 * `spawnDaemonDetached()` and then `process.exit(0)` on the very next line, so
 * the event loop never turns and the exit handler never fires. Any
 * systemd-run failure there — stale `XDG_RUNTIME_DIR`, unreachable bus, a
 * property (or a name-only `--setenv`) the local systemd does not understand —
 * therefore produced NO daemon at all: strictly worse than the uncapped status
 * quo. Deciding inside `spawnDaemonDetached`, before it returns, makes the
 * fallback reachable from every caller without touching their exit semantics.
 *
 * Blocking is acceptable here: the restart path is already tearing the process
 * down, and `ensureRunning()` tolerates a sub-second block (it already awaits a
 * multi-probe /health round-trip afterwards).
 *
 * A unit that is accepted and only THEN fails to exec is deliberately not
 * covered — that surfaces through the existing "daemon never became ready"
 * path in `ensureRunning`.
 */
function spawnViaSystemdRun(opts: {
  node: string;
  script: string;
  env: NodeJS.ProcessEnv;
  status: Extract<DaemonMemoryCapStatus, { mode: "capped" }>;
}): boolean {
  const { node, script, env, status } = opts;
  const unitName = makeDaemonUnitName();

  let workingDir: string | null = null;
  try {
    workingDir = process.cwd();
  } catch {
    // cwd was deleted from under us — let systemd pick its default.
  }

  const args = buildSystemdRunArgs({
    node,
    script,
    unitName,
    limitMb: status.limitMb,
    env,
    workingDir,
  });

  diagEmit({
    event: "child-process.spawn",
    level: "info",
    pid: null,
    ppid: process.pid,
    command: status.systemdRunPath,
    // The forwarded environment is omitted — it is large and may hold secrets.
    args: ["--user", `--unit=${unitName}`, `MemoryMax=${status.limitMb}M`, node, script, "daemon", "start"],
    detached: true,
    unit: unitName,
    memoryMaxMb: status.limitMb,
  });

  const declineWrapper = (why: string): false => {
    diagEmit({
      event: "daemon.cgroup-cap.fallback",
      level: "warn",
      unit: unitName,
      reason: why,
    });
    return false;
  };

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(status.systemdRunPath, args, {
      stdio: "ignore",
      windowsHide: true,
      env,
      timeout: SYSTEMD_RUN_TIMEOUT_MS,
    });
  } catch (err) {
    // spawnSync only throws on a caller error (bad options), but a wrapper
    // that cannot even be attempted must never take the daemon down with it.
    return declineWrapper(`spawn-threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.error) {
    // Includes ETIMEDOUT (bus wedged — spawnSync has already SIGKILLed
    // systemd-run) and ENOENT (the PATH entry vanished between the probe and
    // now). If a unit did squeak through before the kill, the loser of the
    // data-dir ownership lock exits(0) on its own — a duplicate is
    // self-healing, zero daemons is not.
    return declineWrapper(`spawn-error: ${result.error.message}`);
  }

  diagEmit({
    event: "child-process.exit",
    level: "info",
    pid: null,
    ppid: process.pid,
    exitCode: result.status,
    signal: result.signal ?? null,
    unit: unitName,
  });

  if (result.status !== 0) {
    return declineWrapper(`systemd-run exited ${result.status ?? result.signal}`);
  }
  return true;
}

/**
 * Writes (idempotently) a VBS launcher into DATA_DIR that runs
 * `<node> <script> daemon start` with a hidden window via WScript.Shell.Run.
 * Returns the absolute path to the .vbs file.
 */
function ensureWindowsLauncherVbs(): string {
  const dir = config.dataDir;
  mkdirSync(dir, { recursive: true });
  const vbsPath = join(dir, "daemon-spawn.vbs");
  if (existsSync(vbsPath)) return vbsPath;

  const vbs = [
    "' Auto-generated by scrybe - launches the daemon with no console flash.",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "Dim cmd",
    "cmd = \"\"\"\" & WScript.Arguments(0) & \"\"\" \"\"\" & WScript.Arguments(1) & \"\"\" daemon start\"",
    "sh.Run cmd, 0, False",
  ].join("\r\n") + "\r\n";

  writeFileSync(vbsPath, vbs, "utf8");
  return vbsPath;
}
