import { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { writeLauncherScript, MARKER_PLIST_ID } from "./shared.js";
import type { InstallStatus, InstallMethod } from "./index.js";

function getPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${MARKER_PLIST_ID}.plist`);
}

function getLaunchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function buildPlist(launcherScript: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MARKER_PLIST_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${launcherScript}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>/tmp/${MARKER_PLIST_ID}.err</string>
</dict>
</plist>
`;
}

function getUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

export async function install(opts?: { force?: boolean }): Promise<InstallStatus> {
  const plistPath = getPlistPath();
  if (!opts?.force) {
    const existing = await getStatus();
    if (existing.installed) return existing;
  }

  const launcher = writeLauncherScript();
  mkdirSync(getLaunchAgentsDir(), { recursive: true });
  writeFileSync(plistPath, buildPlist(launcher), "utf8");

  // Unload first (for --force reinstall) then bootstrap
  spawnSync("launchctl", ["bootout", `gui/${getUid()}`, plistPath],
    { stdio: "ignore", timeout: 5_000 });
  spawnSync("launchctl", ["bootstrap", `gui/${getUid()}`, plistPath],
    { stdio: "ignore", timeout: 10_000 });

  return { installed: true, method: "macos-launchd", detail: { plistPath } };
}

export async function uninstall(): Promise<{ removed: boolean; method?: InstallMethod }> {
  const plistPath = getPlistPath();
  if (!existsSync(plistPath)) return { removed: false };

  spawnSync("launchctl", ["bootout", `gui/${getUid()}`, plistPath],
    { stdio: "ignore", timeout: 10_000 });
  try { unlinkSync(plistPath); } catch { /* ignore */ }

  return { removed: true, method: "macos-launchd" };
}

export async function getStatus(): Promise<InstallStatus> {
  const plistPath = getPlistPath();
  if (!existsSync(plistPath)) return { installed: false };

  let installedAt: Date | undefined;
  try { installedAt = statSync(plistPath).mtime; } catch { /* ignore */ }

  return { installed: true, method: "macos-launchd", detail: { plistPath }, installedAt };
}
