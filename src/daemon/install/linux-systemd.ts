import { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { config } from "../../config.js";
import { writeLauncherScript, MARKER_UNIT_NAME } from "./shared.js";
import type { InstallStatus, InstallMethod } from "./index.js";

function getUnitDir(): string {
  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(xdgConfig, "systemd", "user");
}

function getUnitPath(): string {
  return join(getUnitDir(), `${MARKER_UNIT_NAME}.service`);
}

/**
 * The always-on deployment does NOT go through `spawnDaemonDetached()`: this
 * unit's ExecStart runs the launcher, which execs `daemon start` and calls
 * `runDaemon()` in-process, so the `systemd-run` wrapper that caps a
 * shim-spawned daemon never applies here. Without an explicit `MemoryMax=` in
 * the unit, the always-on install is the ONE deployment with no containment at
 * all — the exact deployment most likely to hit the multi-GB runaway, since it
 * lives across reboots.
 *
 * Same knob, same semantics as the spawn wrapper (`config.daemonCgroupMaxMb`,
 * `SCRYBE_DAEMON_CGROUP_MAX_MB`), including `MemorySwapMax=0` so a runaway
 * cannot merely spill into swap and take the host down more slowly, and
 * including the 0-disables-it kill switch.
 *
 * Note the value is baked in at INSTALL time. Changing the env var later
 * requires a re-install (`scrybe daemon install --force`) for the unit to pick
 * it up; a unit file cannot read the user's `.env`.
 */
function buildMemoryCapLines(): string {
  const capMb = config.daemonCgroupMaxMb;
  if (!Number.isFinite(capMb) || capMb <= 0) {
    return "# Memory cap disabled (SCRYBE_DAEMON_CGROUP_MAX_MB=0 at install time)\n";
  }
  return `MemoryMax=${Math.floor(capMb)}M\nMemorySwapMax=0\n`;
}

/** Exported for tests — the unit text is the always-on deployment's only containment. */
export function buildUnit(launcherScript: string): string {
  return `[Unit]
Description=Scrybe code indexer daemon
After=network.target
# Bound the restart loop: a cgroup memory cap (companion slice) SIGKILLs the
# daemon, bypassing its graceful self-respawn exit(0) path entirely. With
# RestartSec=5, 6 starts fit in a 30s window — enough slack for ordinary
# transient restarts (e.g. a flaky dependency at boot) — after which systemd
# marks the unit "failed" instead of respawning an OOMing daemon every 5s
# forever against an already memory-starved host.
StartLimitIntervalSec=30
StartLimitBurst=6

[Service]
Type=simple
ExecStart=${launcherScript}
Restart=on-failure
RestartSec=5
${buildMemoryCapLines()}
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
