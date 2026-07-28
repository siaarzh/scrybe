#!/usr/bin/env node
/**
 * Ask, from a SEPARATE OS PROCESS, whether one of the data-dir locks is
 * currently held by somebody.
 *
 * Why a child process: the lock primitive is re-entrant within a process (it
 * hands back `acquired` for a lock this process already holds), and a
 * same-process probe that did NOT already hold it would actually TAKE the lock
 * rather than observe it. Only a foreign process sees the true answer.
 *
 * Why this exists at all: under the previous file-based locks, tests could ask
 * "is the lock held?" with `existsSync("daemon-owner.lock")`. A SQLite lock is
 * an open write transaction, not a file — the database file is a token that
 * persists across acquire and release — so lock-file presence answers nothing.
 * The observable property is whether a competitor can acquire it, which is also
 * the only property production code actually depends on.
 *
 * Acquires and immediately releases (by exiting), so probing never leaves a
 * lock held. Prints `{ outcome, heldByPid? }` on one line of stdout.
 *
 * Usage: node lock-probe.mjs <owner|spawn|migrate>
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
  if (!fn) throw new Error(`unknown lock "${name}" (expected one of ${Object.keys(ACQUIRERS).join(", ")})`);
  const mod = await import(distLockPath);
  const result = mod[fn]();
  process.stdout.write(JSON.stringify(result) + "\n");
  // Exiting drops the transaction, so an `acquired` probe releases immediately.
  process.exit(0);
} catch (err) {
  process.stdout.write(
    JSON.stringify({ outcome: "exception", message: err instanceof Error ? err.message : String(err) }) + "\n"
  );
  process.exit(1);
}
