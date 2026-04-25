import { spawnSync } from "child_process";

/**
 * Detects whether systemd user units are available on the current Linux system.
 * Falls back to cron if systemd is absent or the --user mode is unavailable
 * (e.g. OpenRC, runit, BusyBox, WSL2 without systemd).
 */
export function detectLinuxInitSystem(): "systemd" | "cron" {
  if (process.platform !== "linux") return "cron";
  try {
    const result = spawnSync(
      "systemctl",
      ["--user", "--no-pager", "status"],
      { stdio: "ignore", timeout: 3000 }
    );
    // exit 0 = running, exit 3 = degraded/inactive — both mean systemd --user is available
    if (!result.error && result.status !== null && result.status < 4) {
      return "systemd";
    }
  } catch { /* systemctl not found */ }
  return "cron";
}
