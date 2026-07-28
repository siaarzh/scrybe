/**
 * Plan 108 Slice 1 — data-dir-lock unit tests.
 *
 * Covers the primitive directly (no daemon process spawned): contention,
 * stale-pid reclaim, PID-recycling detection, spawn-lock-only age expiry,
 * errno discrimination (via the SCRYBE_TEST_FORCE_LOCK_ERRNO seam — a real
 * chmod cannot fail-closed on Windows or under root), the hard-link fallback
 * for filesystems that cannot link, release safety, orphaned-temp sweeping,
 * data dirs that do not exist yet, and what path normalisation does and does
 * NOT guarantee. `tests/isolate.ts` (global setupFile) gives every test a
 * fresh `SCRYBE_DATA_DIR` temp dir and resets the module registry before each
 * test.
 *
 * Integration-level acceptance (second daemon exits without serving; the
 * unavailable/fail-open path in a real runDaemon()) lives in
 * `tests/daemon-ownership.test.ts`, which spawns real child processes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync, symlinkSync, mkdtempSync, rmSync } from "fs";
import { join, dirname, basename } from "path";
import { tmpdir } from "os";

/**
 * Review G7: these tests used to plant `pid: 1` and assert `contended`, premised
 * on "pid 1 is always alive". That is Unix-only. Windows has no PID 1 — libuv
 * maps the `OpenProcess` failure to `UV_ESRCH`, so `process.kill(1, 0)` throws,
 * the holder reads as DEAD, the lock is reclaimed, and every one of those
 * assertions inverts. `test.yml` runs the default vitest config on
 * windows-latest and none of them were gated.
 *
 * Hold a REAL child process instead: alive on every platform, and genuinely
 * foreign to this process (which is the other half of what pid 1 was standing
 * in for).
 */
let liveChild: ChildProcess;
let LIVE_PID = 0;

beforeAll(async () => {
  liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  LIVE_PID = liveChild.pid!;
  // Let the OS actually materialise it before anything probes its liveness.
  await new Promise((r) => setTimeout(r, 150));
  expect(LIVE_PID).toBeGreaterThan(0);
});

afterAll(() => {
  try { liveChild.kill("SIGKILL"); } catch { /* already gone */ }
});

async function freshLockModule() {
  return import("../src/daemon/data-dir-lock.js");
}

describe("data-dir-lock — contention", () => {
  it("acquireDataDirOwnership succeeds on a fresh data dir", async () => {
    const { acquireDataDirOwnership } = await freshLockModule();
    const result = acquireDataDirOwnership();
    expect(result.outcome).toBe("acquired");
  });

  it("reports contended when a foreign, alive pid already holds the owner lock", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();
    // A real, foreign, still-running process (see LIVE_PID above).
    writeFileSync(lockPath, JSON.stringify({ pid: LIVE_PID, acquiredAt: new Date().toISOString() }), "utf8");

    const result = acquireDataDirOwnership();
    expect(result.outcome).toBe("contended");
    expect(result.heldByPid).toBe(LIVE_PID);
  });

  it("release() only unlinks a lock this process owns", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership, releaseDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();

    // Foreign lock present — release must be a no-op.
    writeFileSync(lockPath, JSON.stringify({ pid: LIVE_PID, acquiredAt: new Date().toISOString() }), "utf8");
    releaseDataDirOwnership();
    const stillContended = acquireDataDirOwnership();
    expect(stillContended.outcome).toBe("contended");

    // Now let this process actually own it, then release should clear it.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8"
    );
    releaseDataDirOwnership();
    const nowFree = acquireDataDirOwnership();
    expect(nowFree.outcome).toBe("acquired");
  });
});

describe("data-dir-lock — stale-pid reclaim", () => {
  it("reclaims the owner lock when the recorded holder pid is dead", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();
    // A pid this large is astronomically unlikely to be a live process.
    const deadPid = 999_999_999;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }), "utf8");

    const result = acquireDataDirOwnership();
    expect(result.outcome).toBe("acquired");
  });

  it("reclaims the spawn lock when the recorded holder pid is dead", async () => {
    const { getSpawnLockPath, acquireSpawnLock } = await freshLockModule();
    const lockPath = getSpawnLockPath();
    const deadPid = 999_999_999;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }), "utf8");

    const result = acquireSpawnLock();
    expect(result.outcome).toBe("acquired");
  });
});

describe("data-dir-lock — age expiry (spawn lock only)", () => {
  it("acquireSpawnLock reclaims a lock older than the stale threshold, even with an alive holder", async () => {
    const { getSpawnLockPath, acquireSpawnLock } = await freshLockModule();
    const lockPath = getSpawnLockPath();
    // Review F8: the spawn-lock staleness threshold is 120 s, not 30 s — the
    // lock is released only AFTER ensureRunning()'s health wait, so the hold is
    // the caller's whole timeout budget (up to 30 s in-tree). 10 min is
    // unambiguously past it.
    const oldTimestamp = new Date(Date.now() - 600_000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: LIVE_PID, acquiredAt: oldTimestamp }), "utf8");

    const result = acquireSpawnLock();
    expect(result.outcome).toBe("acquired");
  });

  it("acquireSpawnLock stays contended when younger than the stale threshold with an alive holder", async () => {
    const { getSpawnLockPath, acquireSpawnLock } = await freshLockModule();
    const lockPath = getSpawnLockPath();
    const recentTimestamp = new Date(Date.now() - 1_000).toISOString(); // 1s ago — far inside the 120s threshold
    writeFileSync(lockPath, JSON.stringify({ pid: LIVE_PID, acquiredAt: recentTimestamp }), "utf8");

    const result = acquireSpawnLock();
    expect(result.outcome).toBe("contended");
    expect(result.heldByPid).toBe(LIVE_PID);
  });

  it("acquireDataDirOwnership NEVER expires by age, even when far older than the spawn-lock threshold", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();
    // 10 days old — legitimately long-lived ownership must not be reclaimed by age.
    // (Age is not the ownership lock's staleness signal at all; pid liveness +
    // process start time are — see the PID-recycling tests below.)
    const veryOldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: LIVE_PID, acquiredAt: veryOldTimestamp }), "utf8");

    const result = acquireDataDirOwnership();
    expect(result.outcome).toBe("contended");
    expect(result.heldByPid).toBe(LIVE_PID);
  });
});

describe("data-dir-lock — errno discrimination", () => {
  it("EEXIST (contended holder) and a real EACCES (unavailable) are distinct outcomes", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();

    // Sanity: EEXIST path already covered above, but re-assert the shape here
    // alongside the EACCES case so both are visible together.
    const lockPath = getOwnerLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: LIVE_PID, acquiredAt: new Date().toISOString() }), "utf8");
    const contended = acquireDataDirOwnership();
    expect(contended.outcome).toBe("contended");
    expect(contended.error).toBeUndefined();
  });

  it("an EACCES on the lock create reports 'unavailable' with the errno attached, not 'contended'", async () => {
    // Review F5: this used to chmod a scratch dir to 0o555 and expect the
    // create to fail. That cannot hold on two of the three supported
    // platforms: on Windows chmod only toggles the read-only bit and does not
    // block file creation in a directory, and under root the permission bits
    // are ignored outright — the assertion would fail on Windows CI and in any
    // rootful container. Use the SCRYBE_TEST_FORCE_LOCK_ERRNO seam that
    // data-dir-lock.ts ships precisely for this (and that
    // tests/daemon-ownership.test.ts already uses at the integration level):
    // it exercises the same errno-discrimination branch deterministically,
    // everywhere.
    const { acquireDataDirOwnership } = await freshLockModule();
    process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"] = "EACCES";
    try {
      const result = acquireDataDirOwnership();
      expect(result.outcome).toBe("unavailable");
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe("EACCES");
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
    }
  });

  it("a forced EEXIST is still classified as 'contended', never as 'unavailable'", async () => {
    const { acquireSpawnLock } = await freshLockModule();
    process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"] = "EEXIST";
    try {
      const result = acquireSpawnLock();
      expect(result.outcome).toBe("contended");
      expect(result.error).toBeUndefined();
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
    }
  });
});

describe("data-dir-lock — data dir does not exist yet (review F9)", () => {
  /**
   * The mandatory `mkdirSync(dataDir)`-before-lock originally lived ONLY in
   * runDaemon(). checkAndMigrate()'s other two callers (cli.ts — i.e. EVERY
   * CLI invocation — and mcp-server.ts) had nothing creating the data dir, so
   * on a fresh install `tryCreateLock` got ENOENT → "unavailable" → fail-open,
   * and the DESTRUCTIVE v1→v2 migration ran completely unlocked. It was
   * structurally invisible to the existing tests: every one of them builds its
   * data dir with `mkdtempSync`, which pre-creates it.
   *
   * These tests therefore point SCRYBE_DATA_DIR at a path that does NOT exist.
   */
  async function withMissingDataDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const { vi } = await import("vitest");
    const missing = join(process.env["SCRYBE_DATA_DIR"]!, "never-created", "nested");
    expect(existsSync(missing)).toBe(false);
    const orig = process.env["SCRYBE_DATA_DIR"];
    process.env["SCRYBE_DATA_DIR"] = missing;
    vi.resetModules();
    try {
      return await fn(missing);
    } finally {
      process.env["SCRYBE_DATA_DIR"] = orig;
      vi.resetModules();
    }
  }

  it("acquireMigrationLock creates the data dir instead of failing open with ENOENT", async () => {
    await withMissingDataDir(async (dir) => {
      const { acquireMigrationLock, getMigrateLockPath } = await import("../src/daemon/data-dir-lock.js");
      const result = acquireMigrationLock();
      expect(result.outcome).toBe("acquired");
      expect(result.error).toBeUndefined();
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(getMigrateLockPath())).toBe(true);
    });
  });

  it("acquireDataDirOwnership and acquireSpawnLock do the same", async () => {
    await withMissingDataDir(async () => {
      const { acquireDataDirOwnership, acquireSpawnLock } = await import("../src/daemon/data-dir-lock.js");
      expect(acquireDataDirOwnership().outcome).toBe("acquired");
      expect(acquireSpawnLock().outcome).toBe("acquired");
    });
  });
});

describe("data-dir-lock — PID recycling (review F11)", () => {
  it("a live pid whose recorded start time does not match is treated as stale, not as a live holder", async () => {
    if (process.platform !== "linux") return; // /proc-based; degrades elsewhere by design
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();

    // The holder is alive, but the recorded start time is deliberately
    // impossible — exactly the shape of "the daemon died hard and the OS handed
    // its pid to some other long-lived process". Without the start-time
    // cross-check this lock would read `contended` forever and every future
    // daemon would exit(0) silently: a permanent outage curable only by
    // hand-deleting it.
    writeFileSync(lockPath, JSON.stringify({
      pid: LIVE_PID,
      acquiredAt: new Date().toISOString(),
      startTicks: 999_999_999,
    }), "utf8");

    const result = acquireDataDirOwnership();
    expect(result.outcome).toBe("acquired");
  });

  it("a live pid whose recorded start time MATCHES is still contended (no false reclaim)", async () => {
    if (process.platform !== "linux") return;
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();

    // Read the live holder's real start time the same way the implementation does.
    const stat = readFileSync(`/proc/${LIVE_PID}/stat`, "utf8");
    const realStartTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]);
    expect(Number.isFinite(realStartTicks)).toBe(true);

    writeFileSync(lockPath, JSON.stringify({
      pid: LIVE_PID,
      acquiredAt: new Date().toISOString(),
      startTicks: realStartTicks,
    }), "utf8");

    const result = acquireDataDirOwnership();
    expect(result.outcome).toBe("contended");
    expect(result.heldByPid).toBe(LIVE_PID);
  });

  it("a lock written without startTicks still behaves as before (graceful degradation)", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    writeFileSync(getOwnerLockPath(), JSON.stringify({ pid: LIVE_PID, acquiredAt: new Date().toISOString() }), "utf8");
    expect(acquireDataDirOwnership().outcome).toBe("contended");
  });
});

describe("data-dir-lock — release safety (review F17b)", () => {
  it("does NOT release a lock it cannot prove is its own", async () => {
    const { getMigrateLockPath, acquireMigrationLock, releaseMigrationLock } = await freshLockModule();
    const lockPath = getMigrateLockPath();

    // A truncated lock left by a LIVE foreign daemon (e.g. killed mid-write on
    // the O_EXCL fallback path). `readLock()` returns null for it. Treating
    // "unreadable" as "safe to unlink" would hand the lock to us while the
    // real holder is still running.
    writeFileSync(lockPath, "", "utf8");
    releaseMigrationLock();
    expect(existsSync(lockPath)).toBe(true);

    // It is still reclaimable through the normal acquire path (clearIfStale
    // deletes it and immediately re-creates our own), so nothing wedges.
    expect(acquireMigrationLock().outcome).toBe("acquired");
  });
});

describe("data-dir-lock — orphaned temp-file sweep (review F17a)", () => {
  it("removes stale <lock>.tmp.<deadpid>.<uuid> staging files on acquire", async () => {
    const { getOwnerLockPath, acquireDataDirOwnership } = await freshLockModule();
    const lockPath = getOwnerLockPath();
    const dataDir = dirname(lockPath);

    // A process killed between writeFileSync(tmp) and its finally-unlink
    // leaves these behind, and nothing in the product sweeps the data-dir root
    // (`scrybe gc` is scoped to LanceDB tables + the registry) — they grow
    // without bound.
    const orphan = join(dataDir, `${basename(lockPath)}.tmp.999999999.${"a".repeat(8)}`);
    writeFileSync(orphan, "{}", "utf8");
    // A live-pid one (ours) must be left strictly alone.
    const mine = join(dataDir, `${basename(lockPath)}.tmp.${process.pid}.inflight`);
    writeFileSync(mine, "{}", "utf8");

    expect(acquireDataDirOwnership().outcome).toBe("acquired");

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });
});

/**
 * Review F14. The previous test here claimed to prove that "a relative
 * SCRYBE_DATA_DIR + a differing cwd still resolve to one lock path". It did
 * not: it picked "." from one directory and ".." from another — two different
 * relative strings hand-engineered to denote the SAME directory — and then
 * asserted they denote the same directory. Tautological, and the hazard it
 * named is not actually cured by `resolve()` (which anchors to cwd, i.e. to
 * the cause). These tests assert only what normalisation genuinely buys, plus
 * the real limitation, so nobody re-derives a false guarantee from them.
 */
describe("data-dir-lock — path normalisation", () => {
  async function lockPathFor(dataDir: string, cwd?: string): Promise<string> {
    const { vi } = await import("vitest");
    const origCwd = process.cwd();
    const origDataDir = process.env["SCRYBE_DATA_DIR"];
    try {
      if (cwd) process.chdir(cwd);
      process.env["SCRYBE_DATA_DIR"] = dataDir;
      vi.resetModules();
      const mod = await import("../src/daemon/data-dir-lock.js");
      return mod.getOwnerLockPath();
    } finally {
      process.chdir(origCwd);
      process.env["SCRYBE_DATA_DIR"] = origDataDir;
      vi.resetModules();
    }
  }

  it("collapses a symlinked spelling of the data dir onto the same lock path", async () => {
    if (process.platform === "win32") return; // symlink creation needs elevation on Windows
    const absBase = realpathSync(process.env["SCRYBE_DATA_DIR"]!);
    const real = join(absBase, "real-data-dir");
    const link = join(absBase, "link-to-data-dir");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, "dir");

    expect(await lockPathFor(link)).toBe(await lockPathFor(real));
  });

  it("normalises redundant absolute spellings (trailing slash, '.', '..') onto one lock path", async () => {
    const absBase = realpathSync(process.env["SCRYBE_DATA_DIR"]!);
    const sub = join(absBase, "sub");
    mkdirSync(sub, { recursive: true });

    const canonical = await lockPathFor(sub);
    expect(await lockPathFor(`${sub}/`)).toBe(canonical);
    expect(await lockPathFor(join(sub, "."))).toBe(canonical);
    expect(await lockPathFor(join(sub, "nested", ".."))).toBe(canonical);
  });

  it("DOCUMENTED LIMITATION: a relative SCRYBE_DATA_DIR still diverges across cwds", async () => {
    // `resolve()` anchors to process.cwd(), so two processes with different
    // working directories and the SAME relative SCRYBE_DATA_DIR genuinely mean
    // two different directories — and get two different lock files. Normalising
    // cannot fix this and must not pretend to; it is a product-wide footgun
    // (indexes, registry and the pidfile diverge identically), not a lock bug.
    const absBase = realpathSync(process.env["SCRYBE_DATA_DIR"]!);
    const cwdA = join(absBase, "cwd-a");
    const cwdB = join(absBase, "cwd-b");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });

    const pathA = await lockPathFor("./store", cwdA);
    const pathB = await lockPathFor("./store", cwdB);
    expect(pathA).not.toBe(pathB);
    expect(pathA).toBe(join(cwdA, "store", "daemon-owner.lock"));
  });
});

describe("data-dir-lock — locking probe (review F12)", () => {
  it("reports atomic hard-link locking on a normal local filesystem", async () => {
    const { probeDataDirLocking } = await freshLockModule();
    const probe = probeDataDirLocking();
    expect(probe.ok).toBe(true);
    expect(probe.mode).toBe("link");
  });

  it("reports 'none' when the filesystem cannot arbitrate at all", async () => {
    const { probeDataDirLocking } = await freshLockModule();
    process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"] = "EROFS";
    try {
      const probe = probeDataDirLocking();
      expect(probe.ok).toBe(false);
      expect(probe.mode).toBe("none");
      expect(probe.errorCode).toBe("EROFS");
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LOCK_ERRNO"];
    }
  });

  it("falls back to a bare O_EXCL create when the filesystem cannot hard-link, instead of silently disabling all locking", async () => {
    // exFAT, many SMB-mounted home dirs and some FUSE mounts fail link() with
    // EPERM/ENOSYS/EXDEV/ENOTSUP. Before the fallback, any of those turned
    // "unavailable" → fail-open on ALL THREE locks: the whole change became a
    // no-op with no signal anywhere except daemon-log.jsonl.
    const { acquireDataDirOwnership, getOwnerLockPath, probeDataDirLocking, getLockingMode } = await freshLockModule();
    process.env["SCRYBE_TEST_FORCE_LINK_ERRNO"] = "EPERM";
    try {
      const result = acquireDataDirOwnership();
      expect(result.outcome).toBe("acquired");
      expect(getLockingMode()).toBe("o_excl-fallback");

      // The lock is a real, parseable, pid-stamped lock — contention still works.
      const body = JSON.parse(readFileSync(getOwnerLockPath(), "utf8"));
      expect(body.pid).toBe(process.pid);

      expect(probeDataDirLocking()).toMatchObject({ ok: true, mode: "o_excl-fallback" });
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LINK_ERRNO"];
    }
  });

  it("still reports 'unavailable' for a link errno that is NOT a filesystem-capability signal", async () => {
    const { acquireDataDirOwnership } = await freshLockModule();
    process.env["SCRYBE_TEST_FORCE_LINK_ERRNO"] = "ENOSPC";
    try {
      const result = acquireDataDirOwnership();
      expect(result.outcome).toBe("unavailable");
      expect(result.error?.code).toBe("ENOSPC");
    } finally {
      delete process.env["SCRYBE_TEST_FORCE_LINK_ERRNO"];
    }
  });

  it("leaves no probe artifact behind", async () => {
    const { probeDataDirLocking } = await freshLockModule();
    probeDataDirLocking();
    expect(existsSync(join(realpathSync(process.env["SCRYBE_DATA_DIR"]!), "daemon-probe.lock"))).toBe(false);
  });
});

/**
 * Review G2 — the reclaim itself must be atomic.
 *
 * The original primitive reclaimed a stale lock with a bare read-then-unlink:
 *
 *   A: readLock() → holder is dead → unlinkSync(path) → linkSync(tmp, path) ✓ "acquired"
 *   B: readLock() → holder is dead → ...delayed...
 *   B:                                unlinkSync(path)   ← deletes A's FRESH lock
 *   B:                                linkSync(tmp, path) ✓ "acquired"
 *
 * Both processes end up believing they own the data dir — two daemons on one
 * LanceDB dir, in exactly the startup timing the incident lived in. The FIRST
 * blind review missed this, and no test could have caught it: every existing
 * lock test is single-process, where the interleaving cannot occur.
 *
 * This test spawns TWO REAL processes and uses SCRYBE_TEST_RECLAIM_DELAY_MS to
 * park the first one inside the read→unlink window while the second one runs
 * the whole reclaim. Without the `<lock>.reclaim` mutex + re-verify, both
 * report `acquired` and this fails.
 */
describe("data-dir-lock — reclaim is atomic across processes (review G2)", () => {
  function runHarness(dataDir: string, reclaimDelayMs?: number): Promise<{ pid: number; outcome: string; heldByPid?: number }> {
    const harness = join(process.cwd(), "tests/helpers/acquire-ownership-harness.mjs");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [harness], {
        env: {
          ...process.env,
          SCRYBE_DATA_DIR: dataDir,
          ...(reclaimDelayMs ? { SCRYBE_TEST_RECLAIM_DELAY_MS: String(reclaimDelayMs) } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (c) => { out += c.toString(); });
      child.once("error", reject);
      child.once("exit", () => {
        try { resolve(JSON.parse(out.trim())); } catch (e) { reject(new Error(`bad harness output: ${out}`)); }
      });
    });
  }

  it("two processes reclaiming ONE stale lock: exactly one ends up owning it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scrybe-reclaim-race-"));
    try {
      const lockPath = join(dataDir, "daemon-owner.lock");
      // A stale lock: a pid this large is not a live process anywhere.
      writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, acquiredAt: new Date().toISOString() }), "utf8");

      // A parks for 1.5 s having already decided the lock is stale; B starts
      // 300 ms later with no delay and runs the entire reclaim inside A's window.
      const a = runHarness(dataDir, 1500);
      await new Promise((r) => setTimeout(r, 300));
      const b = runHarness(dataDir);
      const [ra, rb] = await Promise.all([a, b]);

      const acquired = [ra, rb].filter((r) => r.outcome === "acquired");
      expect(
        acquired.length,
        `both processes were granted the same lock: ${JSON.stringify([ra, rb])}`,
      ).toBe(1);

      // And the surviving lock file names that one winner — not a loser that
      // deleted the winner's lock and wrote its own on top.
      const finalLock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(finalLock.pid).toBe(acquired[0]!.pid);

      // The reclaim mutex must not leak.
      expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
