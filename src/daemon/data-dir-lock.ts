/**
 * Data-dir ownership + spawn serialisation (Plan 108).
 *
 * Two distinct cross-process locks, both keyed on the DATA DIR — never on the port.
 * The port is the wrong discriminator: a daemon whose port is taken must conclude
 * "another daemon owns my data dir, exit", not "I'll take a different port".
 * Port fallback remains correct for genuinely separate data dirs.
 *
 *   1. OWNERSHIP  (`daemon-owner.lock`) — held for the daemon's whole life.
 *      Acquired in runDaemon() before the HTTP server starts. A daemon that
 *      loses this exits(0) instead of coming up on another port. This is the
 *      backstop: even if N daemons are spawned, N-1 exit within milliseconds,
 *      before any destructive work runs.
 *
 *   2. SPAWN      (`daemon-spawn.lock`) — held only across ensureRunning()'s
 *      check→spawn→health-wait window (wired in slice 2). Losers wait for the
 *      winner's daemon to become healthy rather than spawning their own.
 *
 *   3. MIGRATE    (`daemon-migrate.lock`) — held only across checkAndMigrate()
 *      (wired in slice 3). `checkAndMigrate()` is the only genuinely
 *      destructive operation in the startup path (deletes hash files,
 *      unlinks `branch-tags.db`) and is called from three independent entry
 *      points (`cli.ts`, `mcp-server.ts`, `main.ts`) — not just the daemon.
 *      Losers wait for the holder to finish, then re-read the schema
 *      version themselves rather than skip the check.
 *
 * Both use O_EXCL create, which is atomic on local filesystems — the property
 * a plain existsSync() check-then-write does not have. Not guaranteed atomic
 * on network filesystems (e.g. an NFS-mounted $HOME) — accepted risk,
 * documented rather than solved.
 *
 * Staleness: a crashed holder must never deadlock every future caller, so each
 * lock records its holder pid and is reclaimed when that pid is dead. The spawn
 * lock additionally expires by age, since it is only ever held briefly. The
 * ownership lock must NEVER expire by age — it is legitimately held for days;
 * instead it defends against PID RECYCLING via a recorded process start time
 * (see `readProcStartTicks`).
 *
 * Errno discrimination is load-bearing: `EEXIST` means "contended" (someone
 * else holds it, exit). Any other errno (`EACCES`, `EROFS`, `ENOSPC`, a
 * lingering `ENOENT`, …) means the lock is *unavailable* — the filesystem
 * can't arbitrate here at all, and the caller must proceed unprotected rather
 * than treat a permissions/disk fault as "another daemon owns this". These
 * are distinct states in `AcquireResult["outcome"]`, never collapsed into one
 * boolean — collapsing them would let a permissions fault silently brick
 * every daemon on this data dir.
 */

import {
  writeFileSync, linkSync, readFileSync, unlinkSync, realpathSync, existsSync,
  mkdirSync, readdirSync, statSync, openSync, writeSync, closeSync,
} from "fs";
import { join, resolve, dirname, basename } from "path";
import { randomUUID } from "crypto";
import { config } from "../config.js";
import { isPidAlive } from "./pidfile.js";

const OWNER_LOCK_BASENAME = "daemon-owner.lock";
const SPAWN_LOCK_BASENAME = "daemon-spawn.lock";
const MIGRATE_LOCK_BASENAME = "daemon-migrate.lock";

/**
 * Max age for the spawn lock before it is considered abandoned.
 *
 * NOTE (review F8): the spawn lock is NOT held only for the duration of the
 * spawn syscall. `client.ts` releases it in a `finally` that runs AFTER the
 * post-spawn health wait, so the hold is ≈ the caller's whole `timeoutMs`
 * budget. Real budgets in-tree: 3_000 (ensureRunning default), 5_000
 * (`mcp-shim.ts` tool path), 15_000 (`SCRYBE_MCP_COLD_START_WAIT_MS`) and
 * 30_000 (`mcp-shim.ts` degradedInit). A 30 s threshold sat exactly on the
 * largest of those, so a waiter would age-reclaim a legitimately-held lock and
 * spawn a duplicate. This is set comfortably above every caller budget;
 * `SCRYBE_MCP_COLD_START_WAIT_MS` is separately clamped in `mcp-shim.ts` so no
 * env-tunable budget can climb back over it.
 *
 * Only applies to the spawn lock: the ownership lock is held for the daemon's
 * entire lifetime and must never expire by age.
 */
const SPAWN_LOCK_STALE_MS = 120_000;

/** Upper bound for any caller-supplied spawn-lock hold, enforced by mcp-shim.ts. */
export const MAX_SPAWN_LOCK_HOLD_MS = 60_000;

/** Orphaned `*.tmp.*` staging files older than this are swept on acquire (F17a). */
const TMP_SWEEP_MAX_AGE_MS = 5 * 60_000;

/**
 * Max age for an abandoned `<lock>.reclaim` marker (see `clearIfStale`). The
 * marker is held for the few syscalls of a reclaim, so anything this old
 * belongs to a process that died mid-reclaim.
 */
const RECLAIM_MARKER_STALE_MS = 30_000;

interface LockData {
  pid: number;
  acquiredAt: string;
  /**
   * Linux-only: the holder process's start time (jiffies since boot,
   * `/proc/<pid>/stat` field 22). Absent on platforms where it cannot be read.
   * Guards against PID RECYCLING — see `clearIfStale`.
   */
  startTicks?: number;
  /** Diagnostic only; never used to decide staleness. */
  execPath?: string;
}

/**
 * Read a process's start time so a recycled pid can be told apart from the
 * original holder. Linux-only (`/proc/<pid>/stat` field 22 — "starttime",
 * jiffies since boot); returns null on macOS/Windows or on any read failure,
 * and the caller degrades to bare pid-liveness (the pre-existing behaviour).
 *
 * Field 22 is counted from field 1 = pid. Fields 1 and 2 are skipped by
 * slicing after the LAST ')' — field 2 (`comm`) is the process name in
 * parentheses and may itself contain spaces and parens, so a naive split()
 * would misalign every later field.
 */
function readProcStartTicks(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return undefined;
    // After "<pid> (<comm>) " the next token is field 3 (state), so field 22
    // sits at index 22 - 3 = 19.
    const fields = stat.slice(rparen + 2).trim().split(/\s+/);
    const raw = fields[19];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise a data dir path before it keys any lock.
 *
 * `resolve()` makes the path absolute and collapses `.`/`..` segments;
 * `realpathSync()` additionally collapses symlinks, so two paths that differ
 * only by a symlink hop still land on one lock file.
 *
 * KNOWN LIMITATION (review F14): this does NOT make a *relative*
 * `SCRYBE_DATA_DIR` safe across processes with different working directories.
 * `resolve()` anchors to `process.cwd()`, which is precisely the source of the
 * divergence — two processes with different cwds and `SCRYBE_DATA_DIR="."`
 * genuinely point at two different directories, and no normalisation can (or
 * should) merge them. What normalisation buys is: absolute paths agree
 * regardless of spelling, and symlinked spellings of one directory agree.
 * A relative `SCRYBE_DATA_DIR` remains a user-facing footgun for the whole
 * product (indexes, registry, pidfile — not just locks) and is left alone here
 * rather than rejected inside a lock primitive.
 *
 * Falls back to the resolved (non-realpath'd) path if the directory does not
 * exist yet — path normalisation itself must never throw.
 */
function normaliseDataDir(dir: string): string {
  const resolved = resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function getOwnerLockPath(): string {
  return join(normaliseDataDir(config.dataDir), OWNER_LOCK_BASENAME);
}

export function getSpawnLockPath(): string {
  return join(normaliseDataDir(config.dataDir), SPAWN_LOCK_BASENAME);
}

export function getMigrateLockPath(): string {
  return join(normaliseDataDir(config.dataDir), MIGRATE_LOCK_BASENAME);
}

// Liveness is `isPidAlive` from ./pidfile.js — ONE implementation for the whole
// product (review G12). This module used to carry a second copy without the
// zombie refinement, and it is the SOLE staleness signal for a lock that never
// expires by age: after a `kill -9` the unreaped daemon still answered
// `kill(pid, 0)`, so its ownership lock read `contended` forever and every
// future `runDaemon()` exited(0) in silence.

function readLock(path: string): LockData | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as LockData).pid === "number"
    ) {
      return parsed as LockData;
    }
    return null;
  } catch {
    // Missing, unreadable, or corrupt — caller treats as stale.
    return null;
  }
}

type CreateAttempt =
  | { ok: true }
  | { ok: false; kind: "contended" }
  | { ok: false; kind: "unavailable"; error: NodeJS.ErrnoException };

/**
 * Test-only fault injection (never read outside a test run): when
 * `SCRYBE_TEST_FORCE_LOCK_ERRNO` is set to an errno code (e.g. "EACCES"),
 * `tryCreateLock` synthesizes that failure instead of touching the real
 * filesystem. Exists because the real dataDir is shared by the pidfile, logs,
 * and schema files — chmod'ing it read-only to provoke a genuine EACCES would
 * also break pidfile/log writes, making "the daemon still starts" impossible
 * to observe from an integration test. Same rationale as the pre-existing
 * `SCRYBE_TEST_WRITE_DELAY_MS` (indexer.ts) and `__testingBindSticky`
 * (http-server.ts) test seams — deterministic fault injection beats OS-level
 * permission tricks that collide with other production paths sharing the dir.
 */
function forcedTestErrno(): NodeJS.ErrnoException | null {
  const code = process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
  if (!code) return null;
  const err = new Error(`test-forced errno ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Errnos that mean "this filesystem cannot do hard links", as opposed to
 * "this hard link failed for a real reason". exFAT, many SMB-mounted home
 * directories (corporate Windows with a redirected LOCALAPPDATA) and some FUSE
 * mounts fall in here. Without the fallback below, any of them would turn all
 * three locks into permanent no-ops (review F12).
 */
const LINK_UNSUPPORTED_ERRNOS = new Set(["EPERM", "ENOSYS", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "EMLINK"]);

export type LockingMode = "link" | "o_excl-fallback";

/** Which create strategy last succeeded in THIS process. Surfaced by `scrybe doctor`. */
let _lockingMode: LockingMode | null = null;

/** The create strategy this process is using, or null if it has not locked yet. */
export function getLockingMode(): LockingMode | null {
  return _lockingMode;
}

/**
 * Degraded fallback for filesystems without hard links: a bare O_EXCL create.
 * Still atomic (that is what O_EXCL buys); what it loses is the
 * partial-write mitigation described on `tryCreateLock` — a competing process
 * can observe the file after create but before the body is written and treat
 * it as corrupt-therefore-stale. Strictly better than no locking at all, which
 * is the alternative on these filesystems.
 */
function tryCreateLockDirect(path: string, data: LockData): CreateAttempt {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EEXIST") return { ok: false, kind: "contended" };
    return { ok: false, kind: "unavailable", error: e };
  }
  try {
    writeSync(fd, JSON.stringify(data));
    _lockingMode = "o_excl-fallback";
    return { ok: true };
  } catch (err: unknown) {
    try { unlinkSync(path); } catch { /* ignore */ }
    return { ok: false, kind: "unavailable", error: err as NodeJS.ErrnoException };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Atomically create `path` as a lock owned by this process.
 * Distinguishes WHY it failed — `EEXIST` (contended) vs anything else
 * (unavailable) — so the caller never conflates "someone else owns this"
 * with "the filesystem can't arbitrate here".
 *
 * Implementation note — write-to-temp + `linkSync`, NOT a bare
 * `openSync(path, "wx")` + write: a plain O_EXCL create leaves a window where
 * the lock file exists at `path` but is still empty (between the create and
 * the write completing). A competing process racing through `clearIfStale()`
 * in that window reads that empty file, fails to JSON.parse it, and — by the
 * (correct, for genuine corruption) "unreadable lock is stale" rule — deletes
 * it and recreates its own, so BOTH processes end up believing they hold the
 * lock. Verified this actually happens under real concurrent `daemon start`
 * (~1-in-8 in a local stress run), not just in theory. Writing the full lock
 * body to a uniquely-named temp file first, then `linkSync`-ing it onto
 * `path`, means the lock file is never observable in a partially-written
 * state: `link()` either fails atomically (`EEXIST`, target already has a
 * fully-written lock) or succeeds atomically (target now points at an inode
 * that was already fully written before the link existed).
 *
 * On filesystems that cannot hard-link at all we fall back to the plain
 * O_EXCL create rather than silently disabling every lock (review F12).
 */
function tryCreateLock(path: string): CreateAttempt {
  const forced = forcedTestErrno();
  if (forced) {
    if (forced.code === "EEXIST") return { ok: false, kind: "contended" };
    return { ok: false, kind: "unavailable", error: forced };
  }

  const data: LockData = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    startTicks: readProcStartTicks(process.pid),
    execPath: process.execPath,
  };
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;

  try {
    writeFileSync(tmpPath, JSON.stringify(data), "utf8");
  } catch (err: unknown) {
    // Can't even write the temp file (ENOENT/EACCES/EROFS/ENOSPC on the data
    // dir) — cannot lock here at all.
    return { ok: false, kind: "unavailable", error: err as NodeJS.ErrnoException };
  }

  try {
    // Test-only seam, same rationale as SCRYBE_TEST_FORCE_LOCK_ERRNO: there is
    // no portable way to mount an exFAT/SMB volume from a unit test, so the
    // link-unsupported fallback would otherwise be unreachable in CI.
    const forcedLink = process.env["SCRYBE_TEST_FORCE_LINK_ERRNO"];
    if (forcedLink) {
      const e = new Error(`test-forced link errno ${forcedLink}`) as NodeJS.ErrnoException;
      e.code = forcedLink;
      throw e;
    }
    linkSync(tmpPath, path);
    _lockingMode = "link";
    return { ok: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EEXIST") return { ok: false, kind: "contended" };
    if (e?.code && LINK_UNSUPPORTED_ERRNOS.has(e.code)) {
      return tryCreateLockDirect(path, data);
    }
    // Any other errno — surface as unavailable rather than throwing: failing
    // to lock must never be more disruptive than the stampede it prevents.
    return { ok: false, kind: "unavailable", error: e };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Sweep orphaned `<lock>.tmp.<pid>.<uuid>` staging files (review F17a).
 *
 * `tryCreateLock` unlinks its temp file in a `finally`, but a process killed
 * between the write and the unlink leaves one behind — and nothing else sweeps
 * the data-dir ROOT (`scrybe gc` is scoped to LanceDB tables and the registry),
 * so they accumulate without bound. Runs once per lock path per process: the
 * readdir is cheap but pointless to repeat, and the daemon acquires ownership
 * exactly once for its whole life.
 */
const _sweptTmpFor = new Set<string>();
function sweepStaleTmpFiles(path: string): void {
  if (_sweptTmpFor.has(path)) return;
  _sweptTmpFor.add(path);

  const dir = dirname(path);
  const prefix = `${basename(path)}.tmp.`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const holderPid = Number.parseInt(entry.slice(prefix.length).split(".")[0] ?? "", 10);
    if (holderPid === process.pid) continue; // ours, possibly in flight
    const full = join(dir, entry);
    let stale = !Number.isInteger(holderPid) || !isPidAlive(holderPid);
    if (!stale) {
      // Alive pid, but the pid may have been recycled long after the temp file
      // was orphaned — age is the secondary signal.
      try { stale = now - statSync(full).mtimeMs > TMP_SWEEP_MAX_AGE_MS; } catch { stale = false; }
    }
    if (stale) {
      try { unlinkSync(full); } catch { /* ignore */ }
    }
  }
}

/**
 * Is the recorded holder provably gone? A lock is stale when it is
 * unreadable/corrupt (`held === null`), or its holder pid is dead, or its
 * holder pid was RECYCLED onto an unrelated process, or (spawn lock only) it
 * is older than `maxAgeMs`.
 *
 * PID RECYCLING (review F11): ownership never expires by age and pid liveness
 * is its only staleness signal — so if the daemon dies hard and the OS later
 * hands its pid to any long-lived process, ownership would read "contended"
 * forever: every runDaemon() exits(0) silently. Comparing the recorded process
 * start time against the CURRENT holder's distinguishes "same process still
 * running" from "same number, different process". Linux-only; elsewhere
 * `startTicks` is absent on both sides and we degrade to bare-pid liveness.
 */
function isHolderStale(held: LockData | null, maxAgeMs?: number): boolean {
  if (held === null) return true;
  if (!isPidAlive(held.pid)) return true;
  if (held.startTicks !== undefined) {
    const currentTicks = readProcStartTicks(held.pid);
    if (currentTicks !== undefined && currentTicks !== held.startTicks) return true;
  }
  if (maxAgeMs !== undefined) {
    const age = Date.now() - Date.parse(held.acquiredAt);
    if (Number.isFinite(age) && age > maxAgeMs) return true;
  }
  return false;
}

/** Blocking sleep — test seam only, see `clearIfStale`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Drop a `<lock>.reclaim` marker whose holder died mid-reclaim, so one crash
 * cannot permanently block every future reclaim of that lock.
 */
function clearAbandonedReclaimMarker(markerPath: string): void {
  const held = readLock(markerPath);
  const abandoned =
    held === null ||
    !isPidAlive(held.pid) ||
    Date.now() - Date.parse(held.acquiredAt) > RECLAIM_MARKER_STALE_MS;
  if (abandoned) {
    try { unlinkSync(markerPath); } catch { /* already gone */ }
  }
}

/**
 * Remove a lock file if it is stale. Returns true if a stale lock was cleared
 * and the caller should retry the atomic create.
 *
 * ATOMICITY (review G2 — a defect in the original primitive, not a regression).
 * Reclaim used to be read-then-unlink with nothing in between, so ONE lock
 * could be granted to TWO processes: A and B both read the same stale lock; A
 * unlinked it and `linkSync`-ed its own successfully; B — delayed, still
 * believing the holder is the dead pid it read — then unlinked **A's fresh
 * lock** and its own create succeeded too. Both saw `acquired`: two daemons on
 * one LanceDB dir, in exactly the startup timing the incident lived in.
 *
 * The create is already atomic; the *unlink* was not, so that is what needs an
 * exclusive owner. A process that wants to delete a stale lock must first win
 * an atomic create of `<lock>.reclaim`, and then RE-VERIFY staleness while
 * holding it — by then the lock may already be a previous reclaimer's fresh,
 * live one, in which case we correctly report contended instead of deleting it.
 * Losers of the marker race simply report contended; the winner's fresh lock is
 * what they see on their next attempt.
 */
function clearIfStale(path: string, maxAgeMs?: number): boolean {
  const held = readLock(path);
  if (held?.pid === process.pid) {
    // Our own lock, left over from an earlier acquire in this process.
    return false;
  }
  if (!isHolderStale(held, maxAgeMs)) return false;

  // Test-only seam: widens the decide→unlink window so the double-grant
  // interleaving above is reproducible from two real processes. Never set
  // outside tests (same rationale as SCRYBE_TEST_FORCE_LOCK_ERRNO).
  const delayMs = Number(process.env["SCRYBE_TEST_RECLAIM_DELAY_MS"] ?? "");
  if (Number.isFinite(delayMs) && delayMs > 0) sleepSync(delayMs);

  const reclaimPath = `${path}.reclaim`;
  const marker = tryCreateLock(reclaimPath);
  if (!marker.ok) {
    if (marker.kind === "contended") clearAbandonedReclaimMarker(reclaimPath);
    return false;
  }
  try {
    // Already reclaimed by the marker's previous holder — nothing to delete,
    // but the path may now be free, so tell the caller to retry the create.
    if (!existsSync(path)) return true;
    const now = readLock(path);
    if (now?.pid === process.pid) return false;
    if (!isHolderStale(now, maxAgeMs)) return false;
    try { unlinkSync(path); return true; } catch { return false; }
  } finally {
    release(reclaimPath);
  }
}

export type LockOutcome = "acquired" | "contended" | "unavailable";

export interface AcquireResult {
  outcome: LockOutcome;
  /** Pid of the current holder, when `outcome === "contended"` and the lock file is readable. */
  heldByPid?: number;
  /** The errno that made the lock unavailable, when `outcome === "unavailable"`. */
  error?: NodeJS.ErrnoException;
}

/**
 * Acquire a lock, reclaiming it once if the existing holder is provably gone.
 * Bounded retries — under genuine contention we lose rather than spin.
 * An "unavailable" result (non-EEXIST errno) is never retried: retrying the
 * same permissions/disk fault would not change the outcome.
 *
 * The `mkdirSync` here is load-bearing and belongs to the primitive, NOT to
 * individual callers (review F9): on a fresh install nothing has created the
 * data dir yet, so `tryCreateLock` would get ENOENT → "unavailable" →
 * fail-open, and the destructive first-run migration would run unlocked. Doing
 * it here covers all three locks and all their callers by construction.
 */
function acquire(path: string, maxAgeMs?: number): AcquireResult {
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* tryCreateLock reports the real errno */ }
  sweepStaleTmpFiles(path);

  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptResult = tryCreateLock(path);
    if (attemptResult.ok) return { outcome: "acquired" };
    if (attemptResult.kind === "unavailable") {
      return { outcome: "unavailable", error: attemptResult.error };
    }
    // Contended — reclaim if the holder is provably stale, else report contended.
    if (!clearIfStale(path, maxAgeMs)) {
      const held = readLock(path);
      return held ? { outcome: "contended", heldByPid: held.pid } : { outcome: "contended" };
    }
    // Stale lock cleared — loop to retry the atomic create.
  }
  const held = readLock(path);
  return held ? { outcome: "contended", heldByPid: held.pid } : { outcome: "contended" };
}

/**
 * Release a lock, but only if this process can PROVE it holds it.
 *
 * An unreadable/corrupt lock is deliberately NOT released (review F17b). It is
 * tempting to treat "can't parse it" as "safe to remove", but `clearIfStale`'s
 * version of that rule is justified by a retry immediately re-creating the
 * lock — here there is no such repair, so unlinking an unparseable lock would
 * silently free a lock belonging to a LIVE foreign daemon (e.g. one that wrote
 * via the O_EXCL fallback and was killed mid-write). Leaving it costs nothing:
 * the next `acquire()` reclaims it through `clearIfStale` anyway.
 */
function release(path: string): void {
  const held = readLock(path);
  if (held === null) return;
  if (held.pid !== process.pid) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Claim ownership of the data dir for this daemon's lifetime.
 * A daemon that does not acquire this must exit rather than serve — unless
 * the outcome is "unavailable", in which case it proceeds unprotected
 * (fail-open: a permissions/disk fault must not brick every daemon).
 */
export function acquireDataDirOwnership(): AcquireResult {
  return acquire(getOwnerLockPath());
}

/** Release the data-dir ownership claim. Must happen before any replacement is spawned. */
export function releaseDataDirOwnership(): void {
  release(getOwnerLockPath());
}

/** Acquire the short-lived spawn lock that serialises ensureRunning()'s check→spawn. */
export function acquireSpawnLock(): AcquireResult {
  return acquire(getSpawnLockPath(), SPAWN_LOCK_STALE_MS);
}

/** Release the spawn lock. */
export function releaseSpawnLock(): void {
  release(getSpawnLockPath());
}

/**
 * Acquire the migration lock that serialises `checkAndMigrate()` across its
 * three independent callers (`cli.ts`, `mcp-server.ts`, `main.ts`). No age
 * expiry: a migration's legitimate duration is unbounded (registry
 * migrations may compact tables across every registered project), so only
 * dead-pid reclaim protects a crashed holder — never a wall-clock guess.
 * The caller-side wait loop in `schema-version.ts` supplies its own bounded
 * safety-net timeout for a holder that is alive but wedged.
 */
export function acquireMigrationLock(): AcquireResult {
  return acquire(getMigrateLockPath());
}

/** Release the migration lock. */
export function releaseMigrationLock(): void {
  release(getMigrateLockPath());
}

export interface LockingProbe {
  /** False when this data dir cannot arbitrate locks at all — every lock fails open. */
  ok: boolean;
  /** `"not-created"`: the data dir does not exist yet, so there is nothing to probe. */
  mode: LockingMode | "none" | "not-created";
  errorCode?: string;
}

/**
 * Actively probe whether this data dir supports locking, and by which
 * mechanism. Exists so degraded locking is visible in `scrybe doctor` rather
 * than only as a line in `daemon-log.jsonl` (review F12) — a user on exFAT or
 * an SMB-redirected home dir otherwise has no way to learn that the whole
 * ownership/spawn/migration guarantee silently became a no-op.
 *
 * Uses a throwaway lock name so it can never contend with a real lock.
 *
 * NON-MUTATING (review G15): this used to `mkdirSync(config.dataDir)`, so
 * `scrybe doctor` — a read-only diagnostic — created the data dir as a side
 * effect. A missing data dir is reported as `not-created` instead; `acquire()`
 * still creates it for real callers, which is where that belongs.
 */
export function probeDataDirLocking(): LockingProbe {
  const dir = normaliseDataDir(config.dataDir);
  if (!existsSync(dir)) return { ok: true, mode: "not-created" };
  const probePath = join(dir, "daemon-probe.lock");
  try { unlinkSync(probePath); } catch { /* not there — fine */ }

  const attempt = tryCreateLock(probePath);
  try { unlinkSync(probePath); } catch { /* ignore */ }

  if (attempt.ok) return { ok: true, mode: _lockingMode ?? "link" };
  if (attempt.kind === "contended") {
    // Something re-created it between our unlink and our create — locking
    // demonstrably works.
    return { ok: true, mode: _lockingMode ?? "link" };
  }
  return { ok: false, mode: "none", ...(attempt.error?.code ? { errorCode: attempt.error.code } : {}) };
}
