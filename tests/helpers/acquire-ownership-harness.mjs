#!/usr/bin/env node
/**
 * Review G2 — real-process harness for the reclaim-race test.
 *
 * Calls `acquireDataDirOwnership()` from the COMPILED dist build in its own OS
 * process and prints `{ pid, ...AcquireResult }` to stdout. The double-grant it
 * exercises (two processes both reclaiming ONE stale lock and both getting
 * `acquired`) is only observable across processes: within one process the
 * module-level state and the single-threaded event loop hide it entirely,
 * which is exactly why the first review missed the defect.
 *
 * After printing, the process STAYS ALIVE for `holdMs`. That is load-bearing:
 * a lock whose holder has already exited is legitimately stale, so a harness
 * that exited immediately would let the later process reclaim the earlier
 * one's lock for entirely correct reasons and mask the defect. A real daemon
 * holds its ownership lock for its whole life; the harness must too.
 *
 * Usage: node acquire-ownership-harness.mjs [holdMs]
 * Env:   SCRYBE_DATA_DIR (required), SCRYBE_TEST_RECLAIM_DELAY_MS (optional —
 *        widens the decide→reclaim window so the interleaving is deterministic)
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distLockPath = join(__dirname, "..", "..", "dist", "daemon", "data-dir-lock.js");
const holdMs = Number(process.argv[2] ?? 10_000);

try {
  const { acquireDataDirOwnership } = await import(distLockPath);
  const result = acquireDataDirOwnership();
  process.stdout.write(JSON.stringify({ pid: process.pid, ...result }) + "\n");
  setTimeout(() => process.exit(0), holdMs);
} catch (err) {
  process.stdout.write(
    JSON.stringify({ pid: process.pid, outcome: "exception", message: err instanceof Error ? err.message : String(err) }) + "\n"
  );
  process.exit(1);
}
