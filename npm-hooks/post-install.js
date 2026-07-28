// npm-hooks/post-install.js
// Zero-deps. Runs after npm installs/updates the package.
// Spawns the new daemon so the first CLI/MCP call after upgrade hits a warm daemon.
// Always exits 0 — never blocks install.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
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
// modes — see Plan 102 "Spike results". Bias is to SKIP on ambiguity (D3): a false SKIP just
// costs a cold daemon start on the next call; a false SPAWN hijacks the user's shared daemon.
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

function isContainer() {
  // Match src/daemon/container-detect.ts logic
  if (existsSync("/.dockerenv")) return true;
  if (existsSync("/proc/1/cgroup")) {
    try {
      const cg = readFileSync("/proc/1/cgroup", "utf8");
      if (cg.includes("docker") || cg.includes("kubepods")) return true;
    } catch { /* ignore */ }
  }
  if (process.env.WSL_DISTRO_NAME) return true;
  return false;
}

async function isDaemonAlreadyRunning(dataDir) {
  const pidfile = join(dataDir, "daemon.pid");
  if (!existsSync(pidfile)) return false;
  try {
    const data = JSON.parse(readFileSync(pidfile, "utf8"));
    const port = data?.port;
    if (!port || port <= 0) return false;
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    if (res?.ok !== true) return false;
    // A DRAINING daemon answers /health with 200 (any non-2xx there makes
    // callers SIGKILL it), but it is on its way out and will be gone seconds
    // from now. Treating it as "already running" meant an upgrade spawned
    // nothing and left NO daemon at all (review G5).
    const body = await res.json().catch(() => null);
    return body?.draining !== true;
  } catch {
    return false;
  }
}

async function main() {
  // Resolve the package root from this script's location.
  // This script lives at <pkgRoot>/npm-hooks/post-install.js
  const scriptPath = fileURLToPath(import.meta.url);
  const pkgRoot = join(scriptPath, "..", "..");

  if (isDevCheckout(pkgRoot)) return; // dev checkout / worktree — not a real install (D1)
  if (process.env.SCRYBE_NO_AUTO_DAEMON === "1") return;
  if (isContainer()) return;

  const dataDir = getDataDir();

  // Check if a daemon is already running (e.g. pre-install stop didn't work)
  if (await isDaemonAlreadyRunning(dataDir)) return;

  const distEntry = join(pkgRoot, "dist", "index.js");

  if (!existsSync(distEntry)) return; // dist not present — can't spawn

  // Windows: spawn via wscript.exe + a tiny VBS launcher. wscript.exe is a
  // GUI-subsystem binary, so it allocates no console at all — eliminates the
  // node.exe console flash that `windowsHide: true` cannot fully prevent on
  // Win11 (race between process init and the hide flag taking effect).
  // Mirrors the pattern in src/daemon/spawn-detached.ts; we replicate it
  // inline because this file must stay zero-deps.
  if (process.platform === "win32") {
    const vbs = ensureWindowsLauncherVbs(dataDir);
    const child = spawn("wscript.exe", [vbs, process.execPath, distEntry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        SCRYBE_DATA_DIR: dataDir,
        // No-op on Windows (glibc-only), kept uniform with the POSIX branch below.
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? "2",
        MALLOC_TRIM_THRESHOLD_: process.env.MALLOC_TRIM_THRESHOLD_ ?? "131072",
      },
    });
    child.unref();
    return;
  }

  // POSIX: node spawned with stdio=ignore + detached has no controlling
  // terminal anyway, no flash to worry about.
  //
  // MALLOC_ARENA_MAX / MALLOC_TRIM_THRESHOLD_ cap glibc's per-thread arena
  // hoarding (mirrors daemonSpawnEnv in src/daemon/spawn-detached.ts; inlined
  // here because this file must stay zero-deps). No-op on Windows/musl.
  // glibc reads these at process init, so they must be set before spawn.
  const child = spawn(process.execPath, [distEntry, "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      SCRYBE_DATA_DIR: dataDir,
      MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? "2",
      MALLOC_TRIM_THRESHOLD_: process.env.MALLOC_TRIM_THRESHOLD_ ?? "131072",
    },
  });
  child.unref();
}

// Idempotently writes a VBS launcher into DATA_DIR. The VBS is invoked as:
//   wscript.exe <vbsPath> <nodeExe> <distEntry>
// and runs `<nodeExe> <distEntry> daemon start` via WScript.Shell.Run with
// window mode 0 (hidden) and bWaitOnReturn=False (fire-and-forget).
function ensureWindowsLauncherVbs(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const vbsPath = join(dataDir, "daemon-spawn.vbs");
  if (existsSync(vbsPath)) return vbsPath;
  const vbs = [
    "' Auto-generated by scrybe - launches the daemon with no console flash.",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "Dim cmd",
    "cmd = \"\"\"\" & WScript.Arguments(0) & \"\"\" \"\"\" & WScript.Arguments(1) & \"\"\" daemon start\"",
    "sh.Run cmd, 0, False",
  ].join("\r\n") + "\r\n";
  writeFileSync(vbsPath, vbs, "utf8");
  return vbsPath;
}

main().catch(() => {}).finally(() => process.exit(0));
