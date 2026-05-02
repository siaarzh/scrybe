// npm-hooks/post-install.js
// Zero-deps. Runs after npm installs/updates the package.
// Spawns the new daemon so the first CLI/MCP call after upgrade hits a warm daemon.
// Always exits 0 — never blocks install.

import { existsSync, readFileSync } from "node:fs";
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
    return res?.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.SCRYBE_NO_AUTO_DAEMON === "1") return;
  if (isContainer()) return;

  const dataDir = getDataDir();

  // Check if a daemon is already running (e.g. pre-install stop didn't work)
  if (await isDaemonAlreadyRunning(dataDir)) return;

  // Resolve the package dist entry from this script's location.
  // This script lives at <pkgRoot>/npm-hooks/post-install.js
  const scriptPath = fileURLToPath(import.meta.url);
  const pkgRoot = join(scriptPath, "..", "..");
  const distEntry = join(pkgRoot, "dist", "index.js");

  if (!existsSync(distEntry)) return; // dist not present — can't spawn

  // Spawn daemon detached. On Windows, dist/index.js uses src/daemon/spawn-detached.ts
  // which handles the wscript.exe/VBS console-hide pattern via `daemon start`.
  // We just need to fire-and-forget; the spawned process manages itself.
  const child = spawn(process.execPath, [distEntry, "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      SCRYBE_DATA_DIR: dataDir,
    },
  });
  child.unref();
}

main().catch(() => {}).finally(() => process.exit(0));
