import { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { writeLauncherScript, MARKER_UNIT_NAME } from "./shared.js";
import type { InstallStatus, InstallMethod } from "./index.js";

function getUnitDir(): string {
  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(xdgConfig, "systemd", "user");
}

function getUnitPath(): string {
  return join(getUnitDir(), `${MARKER_UNIT_NAME}.service`);
}

function buildUnit(launcherScript: string): string {
  return `[Unit]
Description=Scrybe code indexer daemon
After=network.target

[Service]
Type=simple
ExecStart=${launcherScript}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export async function install(opts?: { force?: boolean }): Promise<InstallStatus> {
  const unitPath = getUnitPath();
  if (!opts?.force) {
    const existing = await getStatus();
    if (existing.installed) return existing;
  }

  const launcher = writeLauncherScript();
  mkdirSync(getUnitDir(), { recursive: true });
  writeFileSync(unitPath, buildUnit(launcher), "utf8");

  spawnSync("systemctl", ["--user", "daemon-reload"],
    { stdio: "ignore", timeout: 5_000 });
  spawnSync("systemctl", ["--user", "enable", "--now", `${MARKER_UNIT_NAME}.service`],
    { stdio: "ignore", timeout: 10_000 });

  return { installed: true, method: "linux-systemd", detail: { unitPath } };
}

export async function uninstall(): Promise<{ removed: boolean; method?: InstallMethod }> {
  const unitPath = getUnitPath();
  if (!existsSync(unitPath)) return { removed: false };

  spawnSync("systemctl", ["--user", "disable", "--now", `${MARKER_UNIT_NAME}.service`],
    { stdio: "ignore", timeout: 10_000 });
  try { unlinkSync(unitPath); } catch { /* ignore */ }
  spawnSync("systemctl", ["--user", "daemon-reload"],
    { stdio: "ignore", timeout: 5_000 });

  return { removed: true, method: "linux-systemd" };
}

export async function getStatus(): Promise<InstallStatus> {
  const unitPath = getUnitPath();
  if (!existsSync(unitPath)) return { installed: false };

  let installedAt: Date | undefined;
  try { installedAt = statSync(unitPath).mtime; } catch { /* ignore */ }

  return { installed: true, method: "linux-systemd", detail: { unitPath }, installedAt };
}
