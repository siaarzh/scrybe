// scripts/pre-install.js
// Zero-deps. Runs before npm unpacks new files.
// Stops any running scrybe daemon so file replacement succeeds on Windows.
// Always exits 0 — never blocks install.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function getDataDir() {
  if (process.env.SCRYBE_DATA_DIR) return process.env.SCRYBE_DATA_DIR;
  const home = homedir();
  if (process.platform === "win32") {
    const lad = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(lad, "scrybe", "scrybe");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "scrybe");
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(xdg, "scrybe");
}

// D1 (Plan 102): `.git` at pkgRoot means this is a dev checkout — a clone, a worktree, CI —
// not an installed package. npm tarballs never contain `.git`, so a real `npm i -g` / npx
// install never has one. `existsSync` alone (no isDirectory check) is deliberate: a git
// worktree's `.git` is a *file* (`gitdir: …`), not a directory, and still must be caught
// (this is the exact shape of the 2026-07-17 incident). Spike-verified across 5 real install
// modes — see Plan 102 "Spike results". Bias is to SKIP on ambiguity (D3): the stop this
// hook performs is unconditional (D2) and its own harm independent of post-install ever
// respawning, so a false SKIP (no stop) is far cheaper than a false SPAWN-equivalent
// (killing the user's shared daemon from an unrelated checkout).
//
// SCRYBE_HOOK_ASSUME_INSTALL: internal/test-only escape hatch (D4). npm gives a lifecycle
// hook no channel but the environment to say "this really is an install" — our own hook
// tests invoke the hook against this repo's own root (which has `.git`) and need to force
// the real install path. Deliberately undocumented in docs/configuration.md: it is not a
// knob for end users, only unset in every real install path, and exists solely so the test
// harness can assert pre-Plan-102 behavior without rebuilding fixtures as fake packages.
function isDevCheckout(pkgRoot) {
  if (process.env.SCRYBE_HOOK_ASSUME_INSTALL === "1") return false;
  return existsSync(join(pkgRoot, ".git"));
}

async function main() {
  // Resolve the package root from this script's location.
  // This script lives at <pkgRoot>/npm-hooks/pre-install.js
  const scriptPath = fileURLToPath(import.meta.url);
  const pkgRoot = join(scriptPath, "..", "..");

  if (isDevCheckout(pkgRoot)) return; // dev checkout / worktree — don't touch the shared daemon (D1, D2)

  const pidfile = join(getDataDir(), "daemon.pid");
  if (!existsSync(pidfile)) return;

  let data;
  try { data = JSON.parse(readFileSync(pidfile, "utf8")); } catch { return; }
  const { pid, port, version } = data ?? {};
  if (!pid) return;

  console.log(`[scrybe preinstall] stopping daemon (pid=${pid}, port=${port}, version=${version})…`);

  // Try graceful HTTP shutdown first
  if (port > 0) {
    try {
      await fetch(`http://127.0.0.1:${port}/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      });
    } catch { /* fall through to SIGTERM */ }
  }

  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; } // ESRCH = gone
      await new Promise(r => setTimeout(r, 200));
    }
    try { process.kill(pid, 0); } catch { return true; }
    return false;
  };

  if (await waitForExit(5000)) return;

  // Review G5: this hook is the FOURTH stop path, and it used to end with a
  // single SIGTERM and return immediately. If the /shutdown POST above failed
  // (port 0, daemon busy, wrong port), that one signal merely STARTS the
  // daemon's drain — up to 30 minutes — while npm replaces files underneath a
  // live process, which is the exact Windows file-replacement failure this hook
  // exists to prevent. Force the exit: SIGTERM, wait, then a SECOND SIGTERM,
  // which the daemon's escalation path turns into an immediate exit.
  //
  // Kept inline rather than importing `stopDaemonGracefully` from dist/: this
  // file must stay zero-deps, and at preinstall time dist/ belongs to whichever
  // version npm happens to have staged — importing it is exactly the
  // "run code from an unrelated checkout" hazard that Plan 102 fixed.
  try { process.kill(pid, "SIGTERM"); } catch { return; } // ESRCH = already gone
  if (await waitForExit(5000)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await waitForExit(10000);
}

main().catch(() => {}).finally(() => process.exit(0));
