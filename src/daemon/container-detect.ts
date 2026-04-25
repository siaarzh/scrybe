import { existsSync, readFileSync } from "fs";

/**
 * Returns true if the current process is running inside a container.
 * Used by the MCP server to skip auto-spawning the daemon — containers manage
 * their own process lifecycle.
 */
export function isContainer(): boolean {
  // Docker / OCI
  if (existsSync("/.dockerenv")) return true;

  // cgroup v1 (Docker, Kubernetes, LXC)
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|lxc/.test(cgroup)) return true;
  } catch { /* not Linux or /proc not available */ }

  // WSL2 — treat as container; OS-level autostart (M-D11.2) is skipped here too
  if (process.env["WSL_DISTRO_NAME"]) return true;

  return false;
}
