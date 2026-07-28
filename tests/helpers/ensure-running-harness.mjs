#!/usr/bin/env node
/**
 * Plan 108 slice 2 — real-process harness for spawn-serialisation tests.
 *
 * Runs `ensureRunning()` from the COMPILED dist build in its own OS process,
 * then prints the JSON result to stdout. Tests spawn N of these concurrently
 * against the same SCRYBE_DATA_DIR to reproduce the incident's actual shape:
 * N independent processes (pmux sessions / CLI invocations / the MCP shim)
 * racing ensureRunning(), not N calls within one process. An in-process mock
 * cannot exercise the cross-process spawn lock this slice adds — slice 1's
 * TOCTOU was only caught by real process stress, and the same applies here.
 *
 * Usage: node ensure-running-harness.mjs [timeoutMs]
 * Env:   SCRYBE_DATA_DIR (required), SCRYBE_SKIP_MIGRATION=1 (recommended)
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distClientPath = join(__dirname, "..", "..", "dist", "daemon", "client.js");
const distEntryPath = join(__dirname, "..", "..", "dist", "index.js");

const timeoutMs = Number(process.argv[2] ?? 5000);

// spawnDaemonDetached() (invoked internally by ensureRunning()) defaults its
// entry script to process.argv[1] — the real CLI's entry point in
// production. This harness process's own argv[1] is this file, not
// dist/index.js, so without this override a spawned "daemon" would just
// re-run the harness itself instead of starting a real daemon. Set argv[1]
// to the real dist entry point before calling ensureRunning() so it exercises
// the exact same spawnDaemonDetached({}) call production code makes.
process.argv[1] = distEntryPath;

try {
  const { ensureRunning } = await import(distClientPath);
  const result = await ensureRunning(timeoutMs);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
} catch (err) {
  process.stdout.write(
    JSON.stringify({ ok: false, reason: "exception", message: err instanceof Error ? err.message : String(err) }) + "\n"
  );
  process.exit(1);
}
