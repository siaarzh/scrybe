import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync, lstatSync } from "fs";
import { join, delimiter, isAbsolute } from "path";
import { config, ENV_REF_RE } from "../config.js";
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
  /** Where the private env file for `systemd-run` goes; defaults to the spawn env's XDG_RUNTIME_DIR. */
  runtimeDir?: string;
}

/** The daemon's spawn env: arena caps merged in, then (Linux) cut down to what the daemon needs. */
function resolveSpawnEnv(opts: SpawnDaemonOptions): NodeJS.ProcessEnv {
  const env = daemonSpawnEnv(opts.env ?? process.env);
  if (process.platform !== "linux") return env;

  const filtered = filterDaemonEnv(env, env["SCRYBE_DATA_DIR"] || config.dataDir);
  diagEmit({
    event: "daemon.spawn.env-filtered",
    level: "info",
    kept: filtered.kept,
    dropped: filtered.dropped,
    missingRefs: filtered.missingRefs,
  });
  return filtered.env;
}

export function spawnDaemonDetached(opts: SpawnDaemonOptions): void {
  const node   = opts.execPath   ?? process.execPath;
  const script = opts.entryScript ?? process.argv[1]!;
  const env    = resolveSpawnEnv(opts);

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
  if (process.platform === "win32") {
    // The Windows launcher never blocks (wscript.exe returns immediately), so
    // there is nothing to await — reuse the one implementation.
    spawnDaemonDetached(opts);
    return;
  }

  const node   = opts.execPath   ?? process.execPath;
  const script = opts.entryScript ?? process.argv[1]!;
  const env    = resolveSpawnEnv(opts);

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

// ─── Linux: what the daemon inherits from whoever spawned it ─────────────────

const FORWARD_PREFIXES = [
  "SCRYBE_", "MALLOC_", "LC_", "XDG_", "GIT_", "NODE_", "OPENSSL_", "LANCE_", "LANCEDB_", "HF_",
  "NAPI_RS_", "TOKIO_", "ORT_", "ONNXRUNTIME_", "GCM_", "RAYON_", "npm_config_",
];

/** Prefixed names that redirect the daemon's own git calls, or are an npm publish credential. */
const PREFIX_EXCEPTIONS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "NODE_AUTH_TOKEN"]);

const FORWARD_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SSH_AUTH_SOCK", "SSH_ASKPASS", "KRB5CCNAME", "DBUS_SESSION_BUS_ADDRESS", "DEBUG",
  "UV_THREADPOOL_SIZE", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_LOG",
  "CI", "WSL_DISTRO_NAME", "NO_UPDATE_NOTIFIER", "RUST_LOG", "RUST_BACKTRACE", "RUST_LIB_BACKTRACE",
  "RUST_MIN_STACK", "OMP_NUM_THREADS", "UV_USE_IO_URING", "ELECTRON_RUN_AS_NODE",
  "LD_LIBRARY_PATH", "LD_PRELOAD", "GLIBC_TUNABLES", "NIX_LD", "NIX_LD_LIBRARY_PATH",
]);

/** Resolved preset credentials a process injects into its own env; the child re-derives them. */
const NEVER_FORWARD_PREFIX = "SCRYBE_PRESET_";

export interface DaemonEnvFilterResult {
  env: NodeJS.ProcessEnv;
  kept: number;
  dropped: number;
  /** `${VAR}` names scrybe config references that the spawner's env lacks. */
  missingRefs: string[];
}

/** Every `${VAR}` name in the raw text of the data dir's config.json and projects.json. */
export function configEnvRefs(dataDir: string): Set<string> {
  const refs = new Set<string>();
  for (const file of ["config.json", "projects.json"]) {
    let text: string;
    try {
      text = readFileSync(join(dataDir, file), "utf8");
      JSON.parse(text);
    } catch {
      continue;
    }
    for (const m of text.matchAll(ENV_REF_RE)) refs.add(m[1]!);
  }
  return refs;
}

/** Names listed in `SCRYBE_DAEMON_ENV_PASSTHROUGH` (comma or space separated). */
export function daemonEnvPassthrough(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env["SCRYBE_DAEMON_ENV_PASSTHROUGH"] ?? "").split(/[\s,]+/).filter(Boolean));
}

/** Secret-looking names such as HF_TOKEN or GIT_PASSWORD, which a family prefix alone must not forward. */
const PREFIXED_CREDENTIAL_RE = /(TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i;

/** npm credential settings, e.g. `npm_config__authToken` or `npm_config_//registry/:_password`. */
const NPM_CREDENTIAL_RE = /^npm_config_.*(auth|token|pass|cert|key)/i;

function forwardsEnvName(key: string, refs: Set<string>, passthrough: Set<string>): boolean {
  if (key.startsWith(NEVER_FORWARD_PREFIX)) return false;
  if (FORWARD_EXACT.has(key) || refs.has(key) || passthrough.has(key)) return true;
  if (PREFIX_EXCEPTIONS.has(key) || NPM_CREDENTIAL_RE.test(key)) return false;
  if (!key.startsWith("SCRYBE_") && PREFIXED_CREDENTIAL_RE.test(key)) return false;
  return FORWARD_PREFIXES.some((p) => key.startsWith(p));
}

/** Whether a spawned daemon gets `key` regardless of what config references (allowlist or passthrough). */
export function daemonKeepsEnvName(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return forwardsEnvName(key, new Set(), daemonEnvPassthrough(env));
}

/**
 * Variable names (never values) in a live process's start-up environment: `"gone"` when no such
 * process exists, `null` when it exists but can't be read.
 */
export function processEnvNames(pid: number): Set<string> | "gone" | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : null;
  }
  return new Set(raw.split("\0").filter(Boolean).map((e) => {
    const eq = e.indexOf("=");
    return eq === -1 ? e : e.slice(0, eq);
  }));
}

/** Cuts a spawn env down to the allowlist, config `${VAR}` refs and `SCRYBE_DAEMON_ENV_PASSTHROUGH` names. */
export function filterDaemonEnv(env: NodeJS.ProcessEnv, dataDir: string): DaemonEnvFilterResult {
  const refs = configEnvRefs(dataDir);
  const passthrough = daemonEnvPassthrough(env);
  const forward = (key: string): boolean => forwardsEnvName(key, refs, passthrough);

  const out: NodeJS.ProcessEnv = {};
  let kept = 0;
  let dropped = 0;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (forward(key)) {
      out[key] = value;
      kept++;
    } else {
      dropped++;
    }
  }

  const missingRefs = [...refs].filter((name) => env[name] === undefined).sort();
  return { env: out, kept, dropped, missingRefs };
}

// ─── Linux: kernel-enforced memory cap via a transient systemd user service ───

/**
 * Environment variables the systemd user manager sets for a unit itself.
 * Forwarding the spawner's copies would lie to the child about its own
 * activation, so they are never handed to the unit.
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

/** The env entries a unit can be given: systemd-owned keys, invalid names and NUL/CR/LF values skipped. */
function unitEnvEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SYSTEMD_OWNED_ENV_KEYS.has(key)) continue;
    if (!ENV_NAME_RE.test(key)) continue;
    // Skipping one variable systemd cannot carry beats failing the whole spawn.
    if (/[\0\n\r]/.test(value)) continue;
    entries.push([key, value]);
  }
  return entries;
}

/** Double-quotes a value for a systemd EnvironmentFile, which does no `$` expansion. */
export function escapeEnvFileValue(v: string): string {
  return '"' + v.replace(/[\\"`$]/g, (c) => "\\" + c) + '"';
}

/** A live env file exists only while `systemd-run` runs (at most `SYSTEMD_RUN_TIMEOUT_MS`). */
const STALE_ENV_FILE_MS = 60_000;

/** Removes env files a spawner killed mid-launch left behind. */
export function sweepStaleEnvFiles(dir: string, now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^scrybe-daemon-[\w.-]+\.env$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isFile() && now - st.mtimeMs > STALE_ENV_FILE_MS) rmSync(path, { force: true });
    } catch { /* best effort */ }
  }
}

/** Writes `<runtimeDir>/scrybe/<unitName>.env` (dir 700, file 600, exclusive create); null means use `--setenv`. */
function writeDaemonEnvFile(
  runtimeDir: string | undefined,
  unitName: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!runtimeDir || !isAbsolute(runtimeDir)) {
    diagEmit({
      event: "daemon.spawn.env-file-fallback",
      level: "warn",
      unit: unitName,
      reason: runtimeDir ? "runtime-dir-not-absolute" : "no-runtime-dir",
    });
    return null;
  }
  const dir = join(runtimeDir, "scrybe");
  const path = join(dir, `${unitName}.env`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      diagEmit({ event: "daemon.spawn.env-file-fallback", level: "warn", unit: unitName, reason: "runtime-dir-unsafe" });
      return null;
    }
    sweepStaleEnvFiles(dir);
    const body = unitEnvEntries(env).map(([k, v]) => `${k}=${escapeEnvFileValue(v)}\n`).join("");
    writeFileSync(path, body, { mode: 0o600, flag: "wx" });
    return path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A write that failed after creating the file must not leave values behind; EEXIST means it is not ours.
    if (code !== "EEXIST") removeEnvFile(path);
    diagEmit({
      event: "daemon.spawn.env-file-fallback",
      level: "warn",
      unit: unitName,
      reason: code ?? String(err),
    });
    return null;
  }
}

function removeEnvFile(path: string | null): void {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* best effort */ }
}

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
 * - Environment: `envFile` → `EnvironmentFile=` (values never in argv or `systemctl show`);
 *   otherwise name-only `--setenv=NAME`, whose values `systemctl show` does print.
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
  envFile?: string | null;
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

  if (opts.envFile) {
    args.push("-p", `EnvironmentFile=${opts.envFile}`);
  } else {
    for (const [key] of unitEnvEntries(opts.env)) args.push(`--setenv=${key}`);
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
  systemdRunPath: string;
  limitMb: number;
  timeoutMs: number;
  node: string;
  script: string;
  workingDir: string | null;
  runtimeDir: string | undefined;
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
    workingDir,
    runtimeDir: opts.runtimeDir ?? env["XDG_RUNTIME_DIR"],
  };
}

/** Writes the env file when possible and builds the matching argv; the caller removes the file. */
function prepareWrapperLaunch(
  a: WrapperAttempt,
  env: NodeJS.ProcessEnv,
): { args: string[]; envFile: string | null } {
  const envFile = writeDaemonEnvFile(a.runtimeDir, a.unitName, env);
  const args = buildSystemdRunArgs({
    node: a.node,
    script: a.script,
    unitName: a.unitName,
    limitMb: a.limitMb,
    env,
    workingDir: a.workingDir,
    envFile,
  });
  return { args, envFile };
}

function emitWrapperSpawn(a: WrapperAttempt, envFile: string | null): void {
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
    envVia: envFile ? "environment-file" : "setenv",
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
  const { args, envFile } = prepareWrapperLaunch(a, env);
  emitWrapperSpawn(a, envFile);

  try {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(a.systemdRunPath, args, {
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
  } finally {
    // systemd has read the file by the time systemd-run returns; a late one finds it gone and starts nothing.
    removeEnvFile(envFile);
  }
}

/**
 * Non-blocking twin of `spawnViaSystemdRunSync`, with byte-identical argv,
 * timeout and fallback semantics — it only differs in yielding the event loop
 * while the D-Bus round-trip is in flight.
 */
async function spawnViaSystemdRunAsync(a: WrapperAttempt, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { args, envFile } = prepareWrapperLaunch(a, env);
  emitWrapperSpawn(a, envFile);
  try {
    return await launchSystemdRunAsync(a, args, env);
  } finally {
    removeEnvFile(envFile);
  }
}

function launchSystemdRunAsync(a: WrapperAttempt, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(a.systemdRunPath, args, {
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
