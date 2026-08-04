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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// See lock-probe.mjs: `import()` needs a file:// URL. A bare Windows absolute
// path is parsed as scheme "d:" and rejected by the ESM loader. This one is
// imported, so it must be a URL...
const distClientPath = pathToFileURL(
  join(__dirname, "..", "..", "dist", "daemon", "client.js")
).href;
// ...whereas this one is only assigned to process.argv[1] below, which is a
// plain path, not a specifier. Keep it as a path.
const distEntryPath = join(__dirname, "..", "..", "dist", "index.js");

const timeoutMs = Number(process.argv[2] ?? 5000);

// Pin this harness to the PLAIN detached spawn, unconditionally.
//
// `ensureRunning()` is driven for real here, so on any Linux box with a live
// user bus (a dev machine — `XDG_RUNTIME_DIR` is set) the daemon spawn would
// otherwise go through `systemd-run --user`, creating REAL transient
// `scrybe-daemon-*.service` units on the developer's session, one per harness
// process, several per test. In a CI container the opposite failure applies:
// `XDG_RUNTIME_DIR` exists but the bus is dead, so every spawn burns the
// wrapper timeout before falling back.
//
// Neither outcome is what these tests are about — they assert cross-process
// spawn SERIALISATION, and the wrapper is orthogonal to that. Setting the cap
// to 0 makes `describeDaemonMemoryCap()` return `disabled-by-config` before it
// touches the bus, so the path is identical on every host. Set here rather than
// in the spawning test so it holds however the harness is invoked; the wrapper
// itself is covered by the mocked unit tests in tests/daemon-cgroup-cap.test.ts.
process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "0";

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
