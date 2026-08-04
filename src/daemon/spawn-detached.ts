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
export interface SpawnDaemonOptions {
  execPath?: string;
  entryScript?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the cgroup cap (MB) for this spawn. 0 disables the wrapper. */
  cgroupMaxMb?: number;
  /**
   * The caller's REMAINING wall-clock budget for "get me a daemon", in ms.
   *
   * Only the `systemd-run` wrapper can block, and only this bounds it. Omit it
   * (the daemon's own self-restart sites) and the wrapper gets its full stuck-bus
   * ceiling — nobody is waiting on those; the process is already exiting.
   * Supply it (`ensureRunning`) and the wrapper is capped at a small share of
   * what is left, so the health-wait that follows still has most of the budget.
   * See `resolveWrapperTimeoutMs`.
   */
  budgetMs?: number;
}

export function spawnDaemonDetached(opts: SpawnDaemonOptions): void {
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

  const attempt = planWrapperAttempt(opts, node, script, env);
  if (attempt) {
    // Decided SYNCHRONOUSLY (see the `spawnViaSystemdRun*` docstring): callers
    // such as main.ts's three self-restart sites call process.exit() on the
    // next line, so a fallback that needed another turn of the event loop would
    // never run and a failed wrapper would leave the host with no daemon at
    // all.
    if (spawnViaSystemdRunSync(attempt, env)) return;
    // Wrapper did not start — fall through to a plain spawn so a broken cgroup
    // path can never mean "no daemon at all".
  }

  spawnPlainDetached(node, script, env);
}

/**
 * Async twin of `spawnDaemonDetached`, for callers that are NOT about to exit.
 *
 * Identical behaviour and identical fallback ordering — the only difference is
 * that the `systemd-run` round-trip is awaited instead of blocking the event
 * loop. That matters exactly once, but it matters a lot: the MCP shim calls
 * `ensureRunning()` from a live server process with other RPCs in flight, and a
 * synchronous wrapper attempt there freezes every one of them for the duration.
 * The daemon's own restart paths keep the sync form, because at those call
 * sites there is no event loop left to yield to.
 */
export async function spawnDaemonDetachedAsync(opts: SpawnDaemonOptions): Promise<void> {
  const node   = opts.execPath   ?? process.execPath;
  const script = opts.entryScript ?? process.argv[1]!;
  const env    = daemonSpawnEnv(opts.env ?? process.env);

  if (process.platform === "win32") {
    // The Windows launcher never blocks (wscript.exe returns immediately), so
    // there is nothing to await — reuse the one implementation.
    spawnDaemonDetached(opts);
    return;
  }

  const attempt = planWrapperAttempt(opts, node, script, env);
  if (attempt && await spawnViaSystemdRunAsync(attempt, env)) return;

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
 * - `KillMode=process`: WITHOUT THIS THE PLAIN-SPAWN FALLBACK DESTROYS ITSELF.
 *   Once the daemon runs inside a transient unit — which this wrapper makes the
 *   normal case — a self-restart that falls back to `spawn(…, {detached:true})`
 *   puts the replacement in the PARENT's cgroup: `detached` buys a new session,
 *   not a new cgroup. The parent then calls `process.exit()` on the next line,
 *   its unit loses its main process and deactivates, and under the DEFAULT
 *   `KillMode=control-group` systemd SIGKILLs everything still in that cgroup —
 *   including the replacement that was just started. `Restart=no` means nothing
 *   resurrects it. Net result on the exact path advertised as the safety net
 *   (wrapper fails → fall back): ZERO daemons.
 *
 *   `KillMode=process` narrows the teardown kill to the main process only, so a
 *   detached child started before the exit survives deactivation. Verified by
 *   probe on systemd 255: with the default the detached child is gone within
 *   3 s of the main process exiting; with `KillMode=process` it is still
 *   running.
 *
 *   Three things this does NOT cost us, also probe-verified:
 *   1. Resource control is unaffected — `KillMode` governs stop behaviour, not
 *      the cgroup's limits. A `MemoryMax=32M` unit with `KillMode=process`
 *      still ends in `Failed with result 'oom-kill'`, status 137.
 *   2. The survivor stays in the (now deactivated) unit's cgroup, which is NOT
 *      removed while it holds a process — and that cgroup's `memory.max` is
 *      still the one we set, so the fallback daemon inherits the SAME cap
 *      rather than escaping it.
 *   3. That leftover cgroup is not a leak: the directory disappears on its own
 *      once the survivor exits.
 *
 *   The daemon spawns no long-lived children of its own (indexing runs
 *   in-process), so narrowing the kill leaves nothing else behind, and a user
 *   logout still tears the whole `user.slice` down regardless of `KillMode`.
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
 *   HONEST LIMIT of the name-only form: it closes the CROSS-USER leak only.
 *   systemd still resolves each value and stores it as the unit's
 *   `Environment=` property, so `systemctl --user show <unit>` prints the
 *   full `NAME=VALUE` — to the SAME uid (verified on systemd 255: a probe
 *   secret came back verbatim). That is equivalent exposure to the daemon's
 *   own `/proc/<pid>/environ` (mode 400, same-uid readable), so it grants an
 *   attacker nothing they don't already have — unlike `/proc/<pid>/cmdline`,
 *   which is mode 444 and readable by EVERY local user at default hidepid=0.
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
    "-p", "KillMode=process",
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
 * Stuck-bus ceiling for a `systemd-run` round-trip when NO caller budget was
 * supplied (the daemon's own restart sites). `systemd-run` is a D-Bus client
 * that returns as soon as the start job is queued — measured 24–44 ms on a
 * healthy user manager across five runs — so this is a hang bound, never an
 * expected wait.
 */
export const SYSTEMD_RUN_TIMEOUT_MS = 10_000;

/**
 * Share of a caller's REMAINING budget the wrapper may consume.
 *
 * The rest belongs to the /health wait that follows, and that wait is what
 * decides whether the caller reports success. At the 30 % share, the MCP shim's
 * 5 000 ms budget gives the wrapper 1 500 ms — roughly 35× the measured
 * round-trip — and still leaves 3 500 ms of probing. The pre-fix behaviour was
 * a flat 10 000 ms blocking wrapper inside a 5 000 ms budget, which on a wedged
 * bus burned the entire deadline before a single probe ran and returned
 * `health-timeout` for a daemon the fallback had in fact started.
 */
const WRAPPER_BUDGET_FRACTION = 0.3;

/**
 * Floor for the wrapper's slice. Below this even a healthy bus could be judged
 * stuck, so we would lose the memory cap on every spawn rather than
 * occasionally. A caller whose whole remaining budget is under this floor
 * therefore overshoots — by at most this many ms, and only for budgets far
 * below any real caller's (the smallest in the tree is `ensureRunning`'s 3 000
 * ms default, which yields a 900 ms slice).
 */
const WRAPPER_MIN_TIMEOUT_MS = 250;

/**
 * The wrapper's timeout for a given remaining caller budget. `undefined` budget
 * (the exiting-daemon call sites — nobody is waiting) gets the full ceiling.
 */
export function resolveWrapperTimeoutMs(budgetMs?: number): number {
  if (budgetMs === undefined || !Number.isFinite(budgetMs)) return SYSTEMD_RUN_TIMEOUT_MS;
  const share = Math.floor(budgetMs * WRAPPER_BUDGET_FRACTION);
  return Math.min(SYSTEMD_RUN_TIMEOUT_MS, Math.max(WRAPPER_MIN_TIMEOUT_MS, share));
}

/** Everything needed to launch (and log) one `systemd-run` attempt. */
interface WrapperAttempt {
  unitName: string;
  args: string[];
  systemdRunPath: string;
  limitMb: number;
  timeoutMs: number;
  node: string;
  script: string;
}

/**
 * Decides whether this spawn gets the cgroup wrapper and, if so, builds the
 * attempt. Returns null when the cap does not apply (and emits the reason), so
 * both `spawnDaemonDetached` variants share one decision.
 */
function planWrapperAttempt(
  opts: SpawnDaemonOptions,
  node: string,
  script: string,
  env: NodeJS.ProcessEnv,
): WrapperAttempt | null {
  const capMb = opts.cgroupMaxMb ?? config.daemonCgroupMaxMb;
  const status = describeDaemonMemoryCap({ env, platform: process.platform, capMb });

  if (status.mode !== "capped") {
    diagEmit({
      event: "daemon.cgroup-cap.skipped",
      level: "debug",
      reason: status.reason,
    });
    return null;
  }

  let workingDir: string | null = null;
  try {
    workingDir = process.cwd();
  } catch {
    // cwd was deleted from under us — let systemd pick its default.
  }

  // Generated ONCE per attempt: the same name must appear in the argv and in
  // every diag record for this attempt, or the log cannot be joined back to the
  // unit it describes.
  const unitName = makeDaemonUnitName();

  return {
    unitName,
    systemdRunPath: status.systemdRunPath,
    limitMb: status.limitMb,
    timeoutMs: resolveWrapperTimeoutMs(opts.budgetMs),
    node,
    script,
    args: buildSystemdRunArgs({
      node,
      script,
      unitName,
      limitMb: status.limitMb,
      env,
      workingDir,
    }),
  };
}

function emitWrapperSpawn(a: WrapperAttempt): void {
  diagEmit({
    event: "child-process.spawn",
    level: "info",
    pid: null,
    ppid: process.pid,
    command: a.systemdRunPath,
    // The forwarded environment is omitted — it is large and may hold secrets.
    args: ["--user", `--unit=${a.unitName}`, `MemoryMax=${a.limitMb}M`, a.node, a.script, "daemon", "start"],
    detached: true,
    unit: a.unitName,
    memoryMaxMb: a.limitMb,
    timeoutMs: a.timeoutMs,
  });
}

function emitWrapperExit(a: WrapperAttempt, code: number | null, signal: NodeJS.Signals | null): void {
  diagEmit({
    event: "child-process.exit",
    level: "info",
    pid: null,
    ppid: process.pid,
    exitCode: code,
    signal: signal ?? null,
    unit: a.unitName,
  });
}

function declineWrapper(a: WrapperAttempt, why: string): false {
  diagEmit({
    event: "daemon.cgroup-cap.fallback",
    level: "warn",
    unit: a.unitName,
    reason: why,
  });
  return false;
}

/**
 * Spawns the daemon inside a transient systemd user service, blocking until
 * `systemd-run` reports the start job accepted. Returns true only on success.
 *
 * WHY A SYNCHRONOUS VARIANT EXISTS (`spawnSync`, not `spawn`). The fallback to
 * a plain spawn used to hang off `child.once("exit")`, which is unreachable
 * from the daemon's self-restart call sites (`main.ts`): they call
 * `spawnDaemonDetached()` and then `process.exit()` on the very next line, so
 * the event loop never turns and the exit handler never fires. Any systemd-run
 * failure there — stale `XDG_RUNTIME_DIR`, unreachable bus, a property (or a
 * name-only `--setenv`) the local systemd does not understand — therefore
 * produced NO daemon at all: strictly worse than the uncapped status quo.
 * Deciding before `spawnDaemonDetached` returns makes the fallback reachable
 * without touching those call sites' exit semantics.
 *
 * Callers that still have an event loop to protect use
 * `spawnViaSystemdRunAsync` instead; the shim must not freeze its in-flight
 * RPCs on a wedged bus.
 *
 * A unit that is accepted and only THEN fails to exec is deliberately not
 * covered — that surfaces through the existing "daemon never became ready"
 * path in `ensureRunning`.
 */
function spawnViaSystemdRunSync(a: WrapperAttempt, env: NodeJS.ProcessEnv): boolean {
  emitWrapperSpawn(a);

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(a.systemdRunPath, a.args, {
      stdio: "ignore",
      windowsHide: true,
      env,
      timeout: a.timeoutMs,
      // Node's default is SIGTERM, which a wedged D-Bus client blocked in an
      // uninterruptible connect can ignore — turning the "bound" above into a
      // suggestion. SIGKILL makes `timeout` mean what the comment says.
      killSignal: "SIGKILL",
    });
  } catch (err) {
    // spawnSync only throws on a caller error (bad options), but a wrapper
    // that cannot even be attempted must never take the daemon down with it.
    return declineWrapper(a, `spawn-threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.error) {
    // Includes ETIMEDOUT (bus wedged — spawnSync has already SIGKILLed
    // systemd-run) and ENOENT (the PATH entry vanished between the probe and
    // now). If a unit did squeak through before the kill, the loser of the
    // data-dir ownership lock exits(0) on its own — a duplicate is
    // self-healing, zero daemons is not.
    return declineWrapper(a, `spawn-error: ${result.error.message}`);
  }

  emitWrapperExit(a, result.status, result.signal ?? null);

  if (result.status !== 0) {
    return declineWrapper(a, `systemd-run exited ${result.status ?? result.signal}`);
  }
  return true;
}

/**
 * Non-blocking twin of `spawnViaSystemdRunSync`, with byte-identical argv,
 * timeout and fallback semantics — it only differs in yielding the event loop
 * while the D-Bus round-trip is in flight.
 */
function spawnViaSystemdRunAsync(a: WrapperAttempt, env: NodeJS.ProcessEnv): Promise<boolean> {
  emitWrapperSpawn(a);

  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(a.systemdRunPath, a.args, {
        stdio: "ignore",
        windowsHide: true,
        env,
      });
    } catch (err) {
      resolve(declineWrapper(a, `spawn-threw: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // Same bound as the sync path, same signal: SIGKILL, because a D-Bus client
    // wedged in connect() need not honour SIGTERM.
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(declineWrapper(a, "spawn-error: ETIMEDOUT"));
    }, a.timeoutMs);
    // Never hold the process open on the wrapper's account — the caller's own
    // deadline governs, and an exiting process must not be delayed by this.
    timer.unref();

    child.once("error", (err) => {
      finish(declineWrapper(a, `spawn-error: ${err.message}`));
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      emitWrapperExit(a, code, signal ?? null);
      if (code !== 0) {
        finish(declineWrapper(a, `systemd-run exited ${code ?? signal}`));
        return;
      }
      finish(true);
    });
  });
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
