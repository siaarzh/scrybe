// scripts/pre-install.js
// Zero-deps. Runs before npm unpacks new files.
// Stops any running scrybe daemon so file replacement succeeds on Windows.
// Always exits 0 — never blocks install.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

async function main() {
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

  // Wait up to 5s for PID to exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; } // ESRCH = gone
    await new Promise(r => setTimeout(r, 200));
  }

  // Force-kill as last resort
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

main().catch(() => {}).finally(() => process.exit(0));
