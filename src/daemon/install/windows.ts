import { spawnSync } from "child_process";
import { writeLauncherScript, MARKER_TASK_NAME } from "./shared.js";
import type { InstallStatus, InstallMethod } from "./index.js";

const REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_KEY  = "Scrybe";

export async function install(opts?: { force?: boolean }): Promise<InstallStatus> {
  if (!opts?.force) {
    const existing = await getStatus();
    if (existing.installed) return existing;
  }

  const launcher = writeLauncherScript();

  // Primary: schtasks /sc ONLOGON
  const create = spawnSync(
    "schtasks",
    ["/create", "/tn", MARKER_TASK_NAME, "/tr", launcher, "/sc", "ONLOGON", "/f"],
    { encoding: "utf8", timeout: 10_000, stdio: "pipe", windowsHide: true }
  );
  if (!create.error && create.status === 0) {
    return { installed: true, method: "windows-schtasks", detail: { taskName: MARKER_TASK_NAME } };
  }

  // Fallback: HKCU\Run registry key
  const reg = spawnSync(
    "reg",
    ["add", REG_PATH, "/v", REG_KEY, "/t", "REG_SZ", "/d", launcher, "/f"],
    { encoding: "utf8", timeout: 5_000, stdio: "pipe", windowsHide: true }
  );
  if (!reg.error && reg.status === 0) {
    return { installed: true, method: "windows-registry", detail: {} };
  }

  throw new Error(
    `Failed to install autostart on Windows.\n` +
    `schtasks: ${create.stderr?.trim() || create.error?.message}\n` +
    `registry: ${reg.stderr?.trim() || reg.error?.message}`
  );
}

export async function uninstall(): Promise<{ removed: boolean; method?: InstallMethod }> {
  const del = spawnSync(
    "schtasks",
    ["/delete", "/tn", MARKER_TASK_NAME, "/f"],
    { encoding: "utf8", timeout: 10_000, stdio: "pipe", windowsHide: true }
  );
  if (!del.error && del.status === 0) {
    return { removed: true, method: "windows-schtasks" };
  }

  const reg = spawnSync(
    "reg",
    ["delete", REG_PATH, "/v", REG_KEY, "/f"],
    { encoding: "utf8", timeout: 5_000, stdio: "pipe", windowsHide: true }
  );
  if (!reg.error && reg.status === 0) {
    return { removed: true, method: "windows-registry" };
  }

  return { removed: false };
}

export async function getStatus(): Promise<InstallStatus> {
  const query = spawnSync(
    "schtasks",
    ["/query", "/tn", MARKER_TASK_NAME, "/fo", "LIST"],
    { encoding: "utf8", timeout: 5_000, stdio: "pipe", windowsHide: true }
  );
  if (!query.error && query.status === 0) {
    return { installed: true, method: "windows-schtasks", detail: { taskName: MARKER_TASK_NAME } };
  }

  const reg = spawnSync(
    "reg",
    ["query", REG_PATH, "/v", REG_KEY],
    { encoding: "utf8", timeout: 3_000, stdio: "pipe", windowsHide: true }
  );
  if (!reg.error && reg.status === 0) {
    return { installed: true, method: "windows-registry", detail: {} };
  }

  return { installed: false };
}
