/**
 * The always-on systemd unit must carry its OWN memory cap.
 *
 * The unit's ExecStart runs the launcher, which execs `daemon start` and calls
 * runDaemon() in-process — `spawnDaemonDetached()` and therefore the
 * `systemd-run --user -p MemoryMax=` wrapper are never involved. Without an
 * explicit MemoryMax= in the generated unit, the always-on deployment is the
 * one deployment with no containment at all, while `scrybe doctor`'s
 * spawn-time prediction cheerfully reports "capped".
 */
import { describe, it, expect } from "vitest";

const LINUX_ONLY = process.platform !== "linux";

describe.skipIf(LINUX_ONLY)("generated systemd user unit", () => {
  async function unitText(): Promise<string> {
    const { buildUnit } = await import("../src/daemon/install/linux-systemd.js");
    return buildUnit("/home/u/.local/share/scrybe/daemon-launcher.sh");
  }

  function section(text: string, name: string): string {
    const start = text.indexOf(`[${name}]`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + name.length + 2);
    const next = rest.search(/^\[/m);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("caps memory in [Service], from the same knob the spawn wrapper uses", async () => {
    const service = section(await unitText(), "Service");
    // Default SCRYBE_DAEMON_CGROUP_MAX_MB is a positive number of MB.
    expect(service).toMatch(/^MemoryMax=\d+M$/m);
  });

  it("denies swap so a runaway cannot merely spill instead of dying", async () => {
    expect(section(await unitText(), "Service")).toMatch(/^MemorySwapMax=0$/m);
  });

  it("keeps the restart-loop bound in [Unit], not [Service]", async () => {
    const text = await unitText();
    const unit = section(text, "Unit");
    expect(unit).toMatch(/^StartLimitIntervalSec=\d+$/m);
    expect(unit).toMatch(/^StartLimitBurst=\d+$/m);
    expect(section(text, "Service")).not.toMatch(/^StartLimit/m);
  });

  it("keeps ExecStart / Restart / [Install] intact", async () => {
    const text = await unitText();
    expect(text).toContain("ExecStart=/home/u/.local/share/scrybe/daemon-launcher.sh");
    expect(section(text, "Service")).toMatch(/^Restart=on-failure$/m);
    expect(section(text, "Install")).toMatch(/^WantedBy=default\.target$/m);
  });

  it("emits no MemoryMax when the cap is switched off in config", async () => {
    const prev = process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"];
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "0";
    try {
      // isolate.ts calls vi.resetModules() before each test, so config.ts is
      // re-evaluated against the env set above on this import.
      const { buildUnit } = await import("../src/daemon/install/linux-systemd.js");
      const text = buildUnit("/tmp/launcher.sh");
      expect(text).not.toMatch(/^MemoryMax=/m);
      expect(text).not.toMatch(/^MemorySwapMax=/m);
      expect(text).toContain("Memory cap disabled");
    } finally {
      if (prev === undefined) delete process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"];
      else process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = prev;
    }
  });
});
