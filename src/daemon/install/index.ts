import { isContainer } from "../container-detect.js";

export type InstallMethod =
  | "windows-schtasks" | "windows-registry"
  | "macos-launchd"
  | "linux-systemd" | "linux-cron";

export interface InstallStatus {
  installed: boolean;
  method?: InstallMethod;
  detail?: {
    taskName?: string;
    plistPath?: string;
    unitPath?: string;
    cronEntry?: string;
  };
  installedAt?: Date;
}

export async function getInstallStatus(): Promise<InstallStatus> {
  if (isContainer()) return { installed: false };

  if (process.platform === "win32") {
    const { getStatus } = await import("./windows.js");
    return getStatus();
  }
  if (process.platform === "darwin") {
    const { getStatus } = await import("./macos.js");
    return getStatus();
  }
  // linux
  const { detectLinuxInitSystem } = await import("./detect-init-system.js");
  if (detectLinuxInitSystem() === "systemd") {
    const { getStatus } = await import("./linux-systemd.js");
    return getStatus();
  }
  const { getStatus } = await import("./linux-cron.js");
  return getStatus();
}

/**
 * Installs OS-level autostart for the daemon.
 * Soft-fails on platform errors (throws so callers can catch and print remediation).
 */
export async function installAutostart(opts?: { force?: boolean }): Promise<InstallStatus> {
  if (isContainer()) {
    throw new Error("Container environment — OS-level autostart is not supported");
  }

  if (process.platform === "win32") {
    const { install } = await import("./windows.js");
    return install(opts);
  }
  if (process.platform === "darwin") {
    const { install } = await import("./macos.js");
    return install(opts);
  }
  const { detectLinuxInitSystem } = await import("./detect-init-system.js");
  if (detectLinuxInitSystem() === "systemd") {
    const { install } = await import("./linux-systemd.js");
    return install(opts);
  }
  const { install } = await import("./linux-cron.js");
  return install();
}

export async function uninstallAutostart(): Promise<{ removed: boolean; method?: InstallMethod }> {
  if (isContainer()) return { removed: false };

  if (process.platform === "win32") {
    const { uninstall } = await import("./windows.js");
    return uninstall();
  }
  if (process.platform === "darwin") {
    const { uninstall } = await import("./macos.js");
    return uninstall();
  }
  const { detectLinuxInitSystem } = await import("./detect-init-system.js");
  if (detectLinuxInitSystem() === "systemd") {
    const { uninstall } = await import("./linux-systemd.js");
    return uninstall();
  }
  const { uninstall } = await import("./linux-cron.js");
  return uninstall();
}
