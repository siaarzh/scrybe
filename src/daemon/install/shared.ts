import { writeFileSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../../config.js";

export const MARKER_TASK_NAME = "scrybe-daemon";
export const MARKER_PLIST_ID  = "com.scrybe.daemon";
export const MARKER_UNIT_NAME = "scrybe";
export const MARKER_CRON_COMMENT = "# scrybe-managed: do not edit this line";

/**
 * Writes a launcher script to DATA_DIR that sets SCRYBE_DAEMON_KEEP_ALIVE=1
 * and starts the daemon. OS autostart entries invoke this script so the daemon
 * knows it should stay running regardless of client count.
 *
 * Returns the absolute path to the script.
 */
export function writeLauncherScript(overrides?: { execPath?: string; scriptPath?: string }): string {
  const node   = overrides?.execPath   ?? process.execPath;
  const script = overrides?.scriptPath ?? process.argv[1]!;
  const dir    = config.dataDir;
  mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") {
    const path = join(dir, "daemon-autostart.cmd");
    writeFileSync(path, [
      "@echo off",
      "set SCRYBE_DAEMON_KEEP_ALIVE=1",
      `"${node}" "${script}" daemon start`,
    ].join("\r\n") + "\r\n", "utf8");
    return path;
  }

  const path = join(dir, "daemon-autostart.sh");
  writeFileSync(path, [
    "#!/bin/sh",
    "export SCRYBE_DAEMON_KEEP_ALIVE=1",
    `exec "${node}" "${script}" daemon start`,
  ].join("\n") + "\n", "utf8");
  try { chmodSync(path, 0o755); } catch { /* ignore on platforms that don't support it */ }
  return path;
}
