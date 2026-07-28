/**
 * Data-dir ownership + spawn serialisation (Plan 108).
 *
 * Three distinct cross-process locks, all keyed on the DATA DIR — never on the
 * port. The port is the wrong discriminator: a daemon whose port is taken must
 * conclude "another daemon owns my data dir, exit", not "I'll take a different
 * port". Port fallback remains correct for genuinely separate data dirs.
 *
 *   1. OWNERSHIP  (`daemon-owner.lock.db`) — held for the daemon's whole life.
 *      Acquired in runDaemon() before the HTTP server starts. A daemon that
 *      loses this exits(0) instead of coming up on another port. This is the
 *      backstop: even if N daemons are spawned, N-1 exit within milliseconds,
 *      before any destructive work runs.
 *
 *   2. SPAWN      (`daemon-spawn.lock.db`) — held only across ensureRunning()'s
 *      check→spawn→health-wait window. Losers wait for the winner's daemon to
 *      become healthy rather than spawning their own.
 *
 *   3. MIGRATE    (`daemon-migrate.lock.db`) — held only across
 *      checkAndMigrate(), the one genuinely destructive operation in the
 *      startup path (deletes hash files, unlinks `branch-tags.db`), called
 *      from three independent entry points (`cli.ts`, `mcp-server.ts`,
 *      `main.ts`) — not just the daemon. Losers wait for the holder to finish,
 *      then re-read the schema version themselves rather than skip the check.
 *
 * ─── WHY SQLITE, AND NOT A LOCK FILE ────────────────────────────────────────
 *
 * A lock is held by holding an open `BEGIN IMMEDIATE` write transaction on a
 * dedicated, otherwise-empty SQLite database. The OS releases that transaction
 * when the holding process dies, by any means, including SIGKILL.
 *
 * That single property is the reason for this design. The previous
 * implementation hand-rolled mutual exclusion on the filesystem and, because a
 * lock FILE outlives the process that wrote it, had to infer liveness: pid
 * liveness checks, `/proc` start-tick comparison to catch PID recycling, zombie
 * refinement, age expiry for the short-lived lock, an atomic-reclaim marker so
 * two processes could not both delete one stale lock, orphaned temp-file
 * sweeping, and a hard-link fallback for filesystems that cannot hard-link.
 * Every one of those exists only to answer "is the recorded holder still
 * alive?" — a question SQLite never has to ask, because a dead holder has no
 * lock. Two review rounds found defects in that inference, including one that
 * could grant a single lock to two processes simultaneously.
 *
 * scrybe already depends on `node:sqlite` (see `branch-state.ts`), in these
 * very processes, so this adds no dependency.
 *
 * ─── DESIGN CONSTRAINTS THAT ARE NOT OBVIOUS ────────────────────────────────
 *
 * ONE DATABASE FILE PER LOCK. SQLite's write lock is database-wide, so a single
 * shared lock DB could only ever express ONE lock: the lifetime-held ownership
 * transaction would permanently block the spawn and migration locks. Hence
 * three tiny files rather than three rows in one.
 *
 * NEVER THE WORKING DATABASE. These are dedicated files, never `branch-tags.db`
 * — a lifetime `BEGIN IMMEDIATE` on the working DB would block every real
 * writer and stall WAL checkpointing for as long as the daemon runs.
 *
 * THE HOLDER'S PID IS NOT READABLE FROM THE LOCK. The pid is written inside the
 * holder's uncommitted transaction, so contenders cannot see it. A best-effort
 * `<lock>.owner` sidecar carries it instead, written under the lock and used
 * for DIAGNOSTICS ONLY — never for arbitration. It is explicitly allowed to be
 * missing, stale, or unreadable; the answer is then "unknown", which costs a
 * log line and nothing else. Keeping identity out of the correctness path is
 * what stops the staleness question from creeping back in.
 *
 * ─── ERRNO DISCRIMINATION IS STILL LOAD-BEARING ─────────────────────────────
 *
 * `SQLITE_BUSY` means "contended" (someone else holds it → exit / wait).
 * ANY other failure means the lock is *unavailable* — this data dir cannot
 * arbitrate at all (unwritable, read-only mount, out of disk, no such path) —
 * and the caller must proceed unprotected rather than treat an infrastructure
 * fault as "another daemon owns this". These stay distinct states in
 * `AcquireResult["outcome"]` and are never collapsed into one boolean:
 * collapsing them would let a permissions fault silently brick every daemon on
 * this data dir.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, realpathSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, dirname } from "path";
import { config } from "../config.js";

const OWNER_LOCK_BASENAME = "daemon-owner.lock.db";
const SPAWN_LOCK_BASENAME = "daemon-spawn.lock.db";
const MIGRATE_LOCK_BASENAME = "daemon-migrate.lock.db";

/**
 * Upper bound for any caller-supplied spawn-lock hold, enforced by mcp-shim.ts.
 *
 * NOTE: this is no longer load-bearing for lock CORRECTNESS. Under the previous
 * file-based implementation the spawn lock expired by age, so a caller holding
 * it longer than the threshold would have it reclaimed underneath them and a
 * duplicate daemon spawned; the clamp existed to make that unreachable. A
 * SQLite lock has no age expiry — a crashed holder releases instantly and a
 * live holder keeps it however long it needs — so over-holding is now merely
 * impolite. It is kept as a sanity bound on how long a cold start may block.
 */
export const MAX_SPAWN_LOCK_HOLD_MS = 60_000;

/** SQLITE_BUSY. Extended result codes put the primary code in the low byte. */
const SQLITE_BUSY = 5;
/** SQLITE_NOTADB / SQLITE_CORRUPT — a lock DB carries no data, so it is safe to recreate. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

type LockName = "owner" | "spawn" | "migrate";

/**
 * Normalise a data dir path before it keys any lock.
 *
 * `resolve()` makes the path absolute and collapses `.`/`..` segments;
 * `realpathSync()` additionally collapses symlinks, so two paths that differ
 * only by a symlink hop still land on one lock.
 *
 * KNOWN LIMITATION: this does NOT make a *relative* `SCRYBE_DATA_DIR` safe
 * across processes with different working directories. `resolve()` anchors to
 * `process.cwd()`, which is precisely the source of the divergence — two
 * processes with different cwds and `SCRYBE_DATA_DIR="."` genuinely point at
 * two different directories, and no normalisation can (or should) merge them.
 * A relative `SCRYBE_DATA_DIR` remains a footgun for the whole product
 * (indexes, registry, pidfile — not just locks) and is left alone here rather
 * than rejected inside a lock primitive.
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

function lockPathFor(name: LockName): string {
  const basename =
    name === "owner" ? OWNER_LOCK_BASENAME :
    name === "spawn" ? SPAWN_LOCK_BASENAME :
    MIGRATE_LOCK_BASENAME;
  return join(normaliseDataDir(config.dataDir), basename);
}

/**
 * Path of the ownership lock database. Exported for tests only.
 *
 * NOTE: the presence of this FILE says nothing about whether the lock is held —
 * the database is a token that persists across acquire and release, and the
 * lock itself is an open transaction inside it. Anything wanting to know
 * "is this lock held?" must try to acquire it from another process.
 */
export function getOwnerLockPath(): string { return lockPathFor("owner"); }

/**
 * Test-only fault injection (never read outside a test run): when
 * `SCRYBE_TEST_FORCE_LOCK_ERRNO` is set, acquisition fails without touching the
 * filesystem — `"EEXIST"` synthesizes contention, anything else synthesizes an
 * unavailable data dir. Exists because the real dataDir is shared by the
 * pidfile, logs and schema files, so chmod'ing it read-only to provoke a
 * genuine fault would also break those writes, making "the daemon still starts"
 * impossible to observe from an integration test. Same rationale as the
 * pre-existing `SCRYBE_TEST_WRITE_DELAY_MS` (indexer.ts) and
 * `__testingBindSticky` (http-server.ts) seams.
 */
function forcedTestFailure(): AcquireResult | null {
  const code = process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
  if (!code) return null;
  if (code === "EEXIST") return { outcome: "contended" };
  const err = new Error(`test-forced errno ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return { outcome: "unavailable", error: err };
}

/** Primary SQLite result code, or null when this is not a SQLite error. */
function sqliteCode(err: unknown): number | null {
  const raw = (err as { errcode?: unknown })?.errcode;
  return typeof raw === "number" ? raw & 0xff : null;
}

export type LockOutcome = "acquired" | "contended" | "unavailable";

export interface AcquireResult {
  outcome: LockOutcome;
  /**
   * Pid of the current holder when `outcome === "contended"`, if the holder
   * advertised one. DIAGNOSTIC ONLY, and best-effort: absent when the holder
   * had not written its sidecar yet, and possibly a stale pid left by a
   * previously crashed holder. Never used to decide anything.
   */
  heldByPid?: number;
  /** The error that made the lock unavailable, when `outcome === "unavailable"`. */
  error?: NodeJS.ErrnoException;
}

/**
 * Open connections for locks this process currently holds. The open handle IS
 * the lock — dropping it (or dying) releases it — so these must stay reachable
 * for exactly as long as the lock is held.
 */
interface HeldLock {
  db: DatabaseSync;
  /**
   * The path this lock was actually acquired on. Remembered rather than
   * re-derived on release: `acquire()` resolves the path BEFORE its `mkdirSync`,
   * so on a fresh install `realpathSync` fails and `normaliseDataDir` falls back
   * to `resolve()`. Once the directory exists the same call can return a
   * different string if any component is a symlink — and `release()` would then
   * clear a sidecar it never wrote, stranding the real one.
   */
  lockPath: string;
}

const _held = new Map<LockName, HeldLock>();

function ownerSidecarPath(lockPath: string): string {
  return `${lockPath}.owner`;
}

/** Advertise the holder's pid for diagnostics. Failure is not an error. */
function writeOwnerSidecar(lockPath: string): void {
  try {
    writeFileSync(ownerSidecarPath(lockPath), JSON.stringify({ pid: process.pid }), "utf8");
  } catch { /* diagnostics only */ }
}

function clearOwnerSidecar(lockPath: string): void {
  try { unlinkSync(ownerSidecarPath(lockPath)); } catch { /* already gone */ }
}

/** Read the advertised holder pid. Returns undefined for missing/stale/corrupt. */
function readOwnerSidecar(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerSidecarPath(lockPath), "utf8")) as unknown;
    const pid = (parsed as { pid?: unknown })?.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Try once to take the write transaction. Separated from `acquire` so a corrupt
 * lock DB can be discarded and the attempt retried — the file holds no data, so
 * recreating it loses nothing and avoids a permanent brick.
 */
function tryBegin(lockPath: string, waitMs: number): { ok: true; db: DatabaseSync } | { ok: false; error: unknown } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(lockPath);
  } catch (err: unknown) {
    return { ok: false, error: err };
  }
  try {
    // Bounded wait for a contended lock, straight from SQLite. 0 = fail fast,
    // which is what ownership wants: a losing daemon should exit immediately,
    // not linger.
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(waitMs))}`);
    db.exec("BEGIN IMMEDIATE");
    return { ok: true, db };
  } catch (err: unknown) {
    try { db.close(); } catch { /* ignore */ }
    return { ok: false, error: err };
  }
}

/**
 * Acquire a lock by opening a write transaction and holding it.
 *
 * There is no reclaim path, no staleness check and no retry loop under
 * contention: if another process holds the transaction it is BY DEFINITION
 * alive, and if it is not alive it does not hold the transaction. That absence
 * is the point of the design, not an omission.
 *
 * The `mkdirSync` here is load-bearing and belongs to the primitive, NOT to
 * individual callers: on a fresh install nothing has created the data dir yet,
 * so opening the DB would fail → "unavailable" → fail-open, and the destructive
 * first-run migration would run unlocked. Doing it here covers all three locks
 * and all their callers by construction.
 */
function acquire(name: LockName, waitMs = 0): AcquireResult {
  const forced = forcedTestFailure();
  if (forced) return forced;

  // ALREADY HELD BY US — report contention, not success.
  //
  // This used to short-circuit with `acquired`, mirroring the file-based
  // implementation's "the lock file records our own pid" case. That is unsound
  // here, in both directions. A caller receiving `acquired` believes it may now
  // act: `ensureRunning()` re-checks the pidfile and, finding no healthy daemon
  // yet, spawns one — a SECOND spawn, which is precisely what the spawn lock
  // exists to prevent. Worse, `release()` is not refcounted, so that caller's
  // `finally` closes the transaction the FIRST caller is still relying on,
  // handing the cross-process lock to any other process on the machine while
  // the original holder is still inside its critical section.
  //
  // Reporting `contended` is correct on both counts: the caller does not act,
  // and (since every caller releases only on `acquired`) it cannot free a lock
  // it never took. It is also honest — from the caller's point of view somebody
  // else genuinely is in the critical section; that it happens to be another
  // async caller in this same process changes nothing about what is safe to do.
  //
  // Reachable today via `mcp-shim.ts`, which calls `ensureRunning()` per request
  // and can have two tool calls in flight at once. No caller in this codebase
  // legitimately needs to hold one of these locks twice over.
  if (_held.has(name)) return { outcome: "contended", heldByPid: process.pid };

  const lockPath = lockPathFor(name);
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* the open below reports the real error */ }

  let attempt = tryBegin(lockPath, waitMs);

  if (!attempt.ok) {
    const code = sqliteCode(attempt.error);
    // A lock DB holds no data. If it is not a database at all — truncated by a
    // crash mid-create, or clobbered by something else — discard and retry once
    // rather than failing open forever.
    if (code === SQLITE_NOTADB || code === SQLITE_CORRUPT) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      attempt = tryBegin(lockPath, waitMs);
    }
  }

  if (attempt.ok) {
    _held.set(name, { db: attempt.db, lockPath });
    writeOwnerSidecar(lockPath);
    return { outcome: "acquired" };
  }

  if (sqliteCode(attempt.error) === SQLITE_BUSY) {
    const heldByPid = readOwnerSidecar(lockPath);
    return heldByPid === undefined ? { outcome: "contended" } : { outcome: "contended", heldByPid };
  }

  return { outcome: "unavailable", error: attempt.error as NodeJS.ErrnoException };
}

/**
 * Release a lock this process holds. Rolling back and closing drops SQLite's
 * write lock; the database FILE is left in place, since it is a lock token
 * rather than state and recreating it on every acquire buys nothing.
 *
 * A process that never acquired the lock cannot release it — there is no handle
 * to close — so the "don't free someone else's lock" hazard that the file-based
 * implementation had to guard against cannot arise here.
 */
function release(name: LockName): void {
  const held = _held.get(name);
  if (!held) return;
  _held.delete(name);
  try { held.db.exec("ROLLBACK"); } catch { /* closing releases it regardless */ }
  try { held.db.close(); } catch { /* ignore */ }
  clearOwnerSidecar(held.lockPath);
}

/**
 * Claim ownership of the data dir for this daemon's lifetime.
 * A daemon that does not acquire this must exit rather than serve — unless the
 * outcome is "unavailable", in which case it proceeds unprotected (fail-open: a
 * permissions/disk fault must not brick every daemon).
 */
export function acquireDataDirOwnership(): AcquireResult {
  return acquire("owner");
}

/** Release the data-dir ownership claim. Must happen before any replacement is spawned. */
export function releaseDataDirOwnership(): void {
  release("owner");
}

/** Acquire the short-lived spawn lock that serialises ensureRunning()'s check→spawn. */
export function acquireSpawnLock(): AcquireResult {
  return acquire("spawn");
}

/** Release the spawn lock. */
export function releaseSpawnLock(): void {
  release("spawn");
}

/**
 * Acquire the migration lock that serialises `checkAndMigrate()` across its
 * three independent callers (`cli.ts`, `mcp-server.ts`, `main.ts`).
 *
 * Fails fast rather than waiting inside SQLite: `schema-version.ts` polls this
 * and must keep observing "contended" so its own bounded safety-net timeout can
 * fire against a holder that is alive but wedged. A blocking `busy_timeout`
 * here would swallow that distinction.
 */
export function acquireMigrationLock(): AcquireResult {
  return acquire("migrate");
}

/** Release the migration lock. */
export function releaseMigrationLock(): void {
  release("migrate");
}

export interface LockingProbe {
  /** False when this data dir cannot arbitrate locks at all — every lock fails open. */
  ok: boolean;
  /** `"not-created"`: the data dir does not exist yet, so there is nothing to probe. */
  mode: "sqlite" | "none" | "not-created";
  errorCode?: string;
}

/**
 * Actively probe whether this data dir supports locking. Exists so degraded
 * locking is visible in `scrybe doctor` rather than only as a line in
 * `daemon-log.jsonl` — a user whose data dir sits somewhere unwritable
 * otherwise has no way to learn that the whole ownership/spawn/migration
 * guarantee silently became a no-op.
 *
 * Uses a throwaway lock name so it can never contend with a real lock, and
 * removes the probe DB afterwards.
 *
 * NON-MUTATING: this must not create the data dir — `scrybe doctor` is a
 * read-only diagnostic. A missing data dir is reported as `not-created`;
 * `acquire()` still creates it for real callers, which is where that belongs.
 */
export function probeDataDirLocking(): LockingProbe {
  const dir = normaliseDataDir(config.dataDir);
  if (!existsSync(dir)) return { ok: true, mode: "not-created" };

  // Per-process probe name: a fixed one lets two concurrent `scrybe doctor`
  // runs collide, and the winner's unlink of a file the loser still has open
  // throws on Windows — stranding a probe database in the data dir permanently,
  // where it is the only lock-shaped file a user ever sees lying around.
  const probePath = join(dir, `daemon-probe.${process.pid}.lock.db`);
  const attempt = tryBegin(probePath, 0);
  if (attempt.ok) {
    try { attempt.db.exec("ROLLBACK"); } catch { /* ignore */ }
    try { attempt.db.close(); } catch { /* ignore */ }
  }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { unlinkSync(`${probePath}${suffix}`); } catch { /* ignore */ }
  }

  if (attempt.ok) return { ok: true, mode: "sqlite" };
  // Contention on a throwaway name means another process is doing the same
  // probe — locking demonstrably works.
  if (sqliteCode(attempt.error) === SQLITE_BUSY) return { ok: true, mode: "sqlite" };

  const code = (attempt.error as NodeJS.ErrnoException | undefined)?.code;
  const errcode = sqliteCode(attempt.error);
  const errorCode = code ?? (errcode === null ? undefined : `SQLITE_${errcode}`);
  return { ok: false, mode: "none", ...(errorCode ? { errorCode } : {}) };
}
