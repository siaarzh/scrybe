/**
 * data-dir-lock — unit tests for the SQLite-backed lock primitive.
 *
 * WHAT IS NOT TESTED HERE, AND WHY IT IS ABSENT RATHER THAN MISSING.
 *
 * An earlier file-based implementation of these locks needed — and this file
 * used to cover — stale-pid reclaim, PID-recycling detection via /proc start
 * ticks, age expiry for the short-lived lock, cross-process atomicity of the
 * reclaim itself, orphaned staging-file sweeping, refusing to release a lock it
 * could not prove was its own, and a hard-link fallback for filesystems that
 * cannot hard-link. Every one of those existed to answer a single question: "is
 * the process that wrote this lock file still alive?"
 *
 * A lock held as an open SQLite write transaction never poses that question.
 * The OS drops the transaction when the holder dies, so a lock that exists is
 * held by a process that is alive, by construction. All of the above is
 * therefore deleted rather than ported — and `holds the lock until killed, then
 * releases it instantly` below is the single test that replaces the lot.
 *
 * Contention MUST be created by a real foreign process (`lock-holder.mjs`): a
 * SQLite lock cannot be faked by writing a file, and the primitive is
 * re-entrant within a process, so a same-process attempt would report
 * `acquired` rather than observe anything.
 *
 * `tests/isolate.ts` (global setupFile) gives every test a fresh
 * `SCRYBE_DATA_DIR` temp dir and resets the module registry before each test.
 *
 * Integration-level acceptance (a second daemon exits without serving; the
 * unavailable/fail-open path inside a real runDaemon()) lives in
 * `tests/daemon-ownership.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";

import { writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync, symlinkSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { probeLock, isLockHeld, holdLock, killHeldLocks } from "./helpers/lock-probe.js";

/**
 * Every module instance this file has imported. `tests/isolate.ts` resets the
 * module registry between tests, so each call can hand back a NEW instance with
 * its own set of open lock handles — and an acquired lock is an open SQLite
 * connection. Without releasing them, the handles outlive their module and keep
 * Node's event loop alive, which hangs vitest's teardown.
 *
 * Production has no equivalent leak: the daemon holds ownership until it exits,
 * and the short-lived locks are released in a `finally` by their callers.
 */
const importedModules: Array<Awaited<ReturnType<typeof freshLockModule>>> = [];

async function freshLockModule() {
  const mod = await import("../src/daemon/data-dir-lock.js");
  importedModules.push(mod);
  return mod;
}

afterEach(() => {
  killHeldLocks();
  for (const mod of importedModules) {
    try { mod.releaseDataDirOwnership(); } catch { /* ignore */ }
    try { mod.releaseSpawnLock(); } catch { /* ignore */ }
    try { mod.releaseMigrationLock(); } catch { /* ignore */ }
  }
  importedModules.length = 0;
});

/** Wait for a pid to disappear. */
async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

describe("data-dir-lock — contention", () => {
  it("acquireDataDirOwnership succeeds on a fresh data dir", async () => {
    const { acquireDataDirOwnership } = await freshLockModule();
    expect(acquireDataDirOwnership().outcome).toBe("acquired");
  });

  it("reports contended when a foreign process holds the owner lock", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    const { pid } = await holdLock(dataDir, "owner");

    const { acquireDataDirOwnership } = await freshLockModule();
    const result = acquireDataDirOwnership();

    expect(result.outcome).toBe("contended");
    // Diagnostics-only, but it should work in the ordinary case.
    expect(result.heldByPid).toBe(pid);
  });

  it("reports contended on the spawn lock the same way", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    await holdLock(dataDir, "spawn");

    const { acquireSpawnLock } = await freshLockModule();
    expect(acquireSpawnLock().outcome).toBe("contended");
  });

  /**
   * A second acquire from the SAME process must NOT report success.
   *
   * It used to, mirroring the old file-based "the lock file records our own pid"
   * case. That is unsound in both directions: a caller told `acquired` believes
   * it may act (ensureRunning would spawn a second daemon), and since release()
   * is not refcounted its `finally` would close the transaction the first caller
   * is still inside — handing the cross-process lock to any other process on the
   * machine mid-critical-section.
   */
  it("a second acquire in the same process reports contended, not acquired", async () => {
    const { acquireDataDirOwnership } = await freshLockModule();
    expect(acquireDataDirOwnership().outcome).toBe("acquired");

    const second = acquireDataDirOwnership();
    expect(second.outcome).toBe("contended");
    expect(second.heldByPid).toBe(process.pid);
  });

  it("a release paired with that second acquire cannot free the real holder's lock", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    const { acquireDataDirOwnership, releaseDataDirOwnership } = await freshLockModule();

    expect(acquireDataDirOwnership().outcome).toBe("acquired");
    const second = acquireDataDirOwnership();

    // Every caller in the tree releases only on `acquired`, so a correct caller
    // never reaches this. Prove the lock survives even if one gets it wrong.
    if (second.outcome === "acquired") releaseDataDirOwnership();

    expect(
      isLockHeld(dataDir, "owner"),
      "a second in-process acquire/release pair freed the lock the first caller still holds",
    ).toBe(true);
  });

  it("release frees the lock for another process", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    const { acquireDataDirOwnership, releaseDataDirOwnership } = await freshLockModule();

    expect(acquireDataDirOwnership().outcome).toBe("acquired");
    expect(isLockHeld(dataDir, "owner"), "a foreign process should not be able to take a held lock").toBe(true);

    releaseDataDirOwnership();
    expect(isLockHeld(dataDir, "owner"), "the lock should be free after release").toBe(false);
  });
});

describe("data-dir-lock — the three locks are independent", () => {
  /**
   * SQLite's write lock is database-wide, so all three locks sharing one
   * database file would silently collapse into one: the lifetime-held ownership
   * transaction would block spawn and migration forever. This is the test that
   * fails if someone later "tidies up" the three files into one.
   */
  it("holding ownership does not block the spawn or migration locks", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    await holdLock(dataDir, "owner");

    const { acquireSpawnLock, acquireMigrationLock } = await freshLockModule();
    expect(acquireSpawnLock().outcome, "the spawn lock must not be blocked by ownership").toBe("acquired");
    expect(acquireMigrationLock().outcome, "the migration lock must not be blocked by ownership").toBe("acquired");
  });
});

describe("data-dir-lock — crash release (the property the whole design rests on)", () => {
  /**
   * This single test stands in for everything the file-based implementation
   * needed a staleness heuristic for: dead holders, PID recycling, zombies,
   * abandoned short-lived locks, and holders killed mid-reclaim. No cleanup
   * code runs on SIGKILL — the OS closes the connection, and that IS the
   * release.
   */
  it("holds the lock until killed, then releases it instantly", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    const { child, pid } = await holdLock(dataDir, "owner");

    expect(isLockHeld(dataDir, "owner"), "precondition: the holder must actually hold it").toBe(true);

    child.kill("SIGKILL");
    await waitForDeath(pid);

    const after = probeLock(dataDir, "owner");
    expect(
      after.outcome,
      "a SIGKILLed holder must leave no lock behind — nothing else reclaims it",
    ).toBe("acquired");
  });
});

describe("data-dir-lock — corrupt lock database", () => {
  it("discards a lock file that is not a database and acquires anyway", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    // A lock DB carries no data, so garbage in it must never be a permanent brick.
    writeFileSync(lockPath, "this is not a sqlite database", "utf8");

    expect(acquireDataDirOwnership().outcome).toBe("acquired");
  });
});

describe("data-dir-lock — errno discrimination", () => {
  /**
   * "Someone else holds this" and "this data dir cannot arbitrate at all" must
   * stay distinct: collapsing them into one boolean would let a permissions or
   * disk fault read as contention and silently brick every daemon on the dir.
   */
  it("a forced infrastructure fault reports 'unavailable' with the error attached, not 'contended'", async () => {
    process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"] = "EACCES";
    try {
      const { acquireDataDirOwnership } = await freshLockModule();
      const result = acquireDataDirOwnership();
      expect(result.outcome).toBe("unavailable");
      expect(result.error?.code).toBe("EACCES");
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
    }
  });

  it("a forced EEXIST is still classified as 'contended', never as 'unavailable'", async () => {
    process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"] = "EEXIST";
    try {
      const { acquireDataDirOwnership } = await freshLockModule();
      expect(acquireDataDirOwnership().outcome).toBe("contended");
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
    }
  });
});

describe("data-dir-lock — data dir does not exist yet", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    created.length = 0;
  });

  /**
   * On a fresh install nothing has created the data dir yet. If the primitive
   * did not create it, every lock would report "unavailable" → fail open → the
   * destructive first-run migration would run unprotected. Creating it belongs
   * to the primitive so all three locks and all their callers are covered by
   * construction.
   */
  it("acquireMigrationLock creates the data dir instead of failing open", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scrybe-lock-nodir-"));
    created.push(parent);
    const dataDir = join(parent, "not-created-yet");
    process.env["SCRYBE_DATA_DIR"] = dataDir;
    expect(existsSync(dataDir)).toBe(false);

    const { acquireMigrationLock } = await freshLockModule();
    expect(acquireMigrationLock().outcome).toBe("acquired");
    expect(existsSync(dataDir)).toBe(true);
  });

  it("acquireDataDirOwnership and acquireSpawnLock do the same", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scrybe-lock-nodir2-"));
    created.push(parent);
    const dataDir = join(parent, "also-not-created");
    process.env["SCRYBE_DATA_DIR"] = dataDir;

    const { acquireDataDirOwnership, acquireSpawnLock } = await freshLockModule();
    expect(acquireDataDirOwnership().outcome).toBe("acquired");
    expect(acquireSpawnLock().outcome).toBe("acquired");
    expect(existsSync(dataDir)).toBe(true);
  });
});

describe("data-dir-lock — path normalisation", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    created.length = 0;
  });

  it("collapses a symlinked spelling of the data dir onto the same lock", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scrybe-lock-symlink-"));
    created.push(parent);
    const real = join(parent, "real");
    const link = join(parent, "link");
    mkdirSync(real, { recursive: true });
    try {
      symlinkSync(real, link, "dir");
    } catch {
      return; // no symlink privilege (unprivileged Windows) — nothing to assert
    }

    process.env["SCRYBE_DATA_DIR"] = real;
    const viaReal = (await freshLockModule()).getOwnerLockPath();
    process.env["SCRYBE_DATA_DIR"] = link;
    const viaLink = (await freshLockModule()).getOwnerLockPath();

    expect(viaLink).toBe(viaReal);
  });

  it("normalises redundant absolute spellings onto one lock path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrybe-lock-spelling-"));
    created.push(dir);
    const canonical = realpathSync(dir);

    process.env["SCRYBE_DATA_DIR"] = canonical;
    const plain = (await freshLockModule()).getOwnerLockPath();
    process.env["SCRYBE_DATA_DIR"] = `${canonical}/./`;
    const dotted = (await freshLockModule()).getOwnerLockPath();
    process.env["SCRYBE_DATA_DIR"] = join(canonical, "sub", "..");
    const dotdot = (await freshLockModule()).getOwnerLockPath();

    expect(dotted).toBe(plain);
    expect(dotdot).toBe(plain);
  });
});

describe("data-dir-lock — locking probe", () => {
  it("reports SQLite locking on a normal local data dir", async () => {
    const { probeDataDirLocking } = await freshLockModule();
    const probe = probeDataDirLocking();
    expect(probe.ok).toBe(true);
    expect(probe.mode).toBe("sqlite");
  });

  it("reports 'not-created' without creating the data dir", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scrybe-lock-probe-nodir-"));
    const dataDir = join(parent, "absent");
    process.env["SCRYBE_DATA_DIR"] = dataDir;
    try {
      const { probeDataDirLocking } = await freshLockModule();
      const probe = probeDataDirLocking();
      expect(probe.mode).toBe("not-created");
      // `doctor` is a read-only diagnostic — probing must not create anything.
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("leaves no probe artifact behind", async () => {
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    mkdirSync(dataDir, { recursive: true });
    const { probeDataDirLocking } = await freshLockModule();
    probeDataDirLocking();

    const leftovers = readdirSync(dataDir).filter((f) => f.startsWith("daemon-probe"));
    expect(leftovers, `probe left artifacts: ${leftovers.join(", ")}`).toEqual([]);
  });
});
