#!/usr/bin/env node
/**
 * Hold one of the data-dir locks in a REAL, foreign OS process until killed.
 *
 * A SQLite lock is an open write transaction owned by a process, so it cannot
 * be faked by writing a file: the only way for a test to create a genuinely
 * held lock is to have another process hold it. That is also what makes the
 * crash-release property testable — SIGKILL this process and the lock is gone,
 * with no cleanup code anywhere having run.
 *
 * Prints `{ pid, ...AcquireResult }` on one line of stdout once the lock is
 * taken, then stays alive indefinitely. The caller kills it.
 *
 * Usage: node lock-holder.mjs <owner|spawn|migrate>
 * Env:   SCRYBE_DATA_DIR (required)
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distLockPath = join(__dirname, "..", "..", "dist", "daemon", "data-dir-lock.js");

const name = process.argv[2];
const ACQUIRERS = {
  owner: "acquireDataDirOwnership",
  spawn: "acquireSpawnLock",
  migrate: "acquireMigrationLock",
};

try {
  const fn = ACQUIRERS[name];
  if (!fn) throw new Error(`unknown lock "${name}"`);
  const mod = await import(distLockPath);
  const result = mod[fn]();
  process.stdout.write(JSON.stringify({ pid: process.pid, ...result }) + "\n");
  // Hold forever. The lock lives exactly as long as this process does.
  setInterval(() => {}, 1000);
} catch (err) {
  process.stdout.write(
    JSON.stringify({ pid: process.pid, outcome: "exception", message: err instanceof Error ? err.message : String(err) }) + "\n"
  );
  process.exit(1);
}
