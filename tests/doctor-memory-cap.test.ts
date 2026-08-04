/**
 * `scrybe doctor` — the daemon.memory_cap row.
 *
 * The row must report what is ACTUALLY true of the running daemon, not what
 * would happen if doctor spawned one right now. The two genuinely diverge: an
 * always-on systemd install runs runDaemon() in-process from its unit and never
 * touches the systemd-run spawn wrapper, so a prediction based on
 * "systemd-run is on PATH and there's a user bus" would report a kernel-enforced
 * cap for a completely uncapped daemon — protection claimed but not provided.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-doctor-memcap-test-"));
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = tmp;
  process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
  process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = "voyage-code-3";
  process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = "1024";
  process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test-key";
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env["SCRYBE_DATA_DIR"];
});

/** Keeps the unrelated daemon rows quiet and deterministic. */
function mockAmbient(): void {
  vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
  vi.doMock("../src/daemon/install/index.js", () => ({
    getInstallStatus: async () => ({ installed: false }),
    installAutostart: async () => ({ installed: true, method: "linux-systemd" }),
    uninstallAutostart: async () => ({ removed: true }),
  }));
}

function mockPidfile(opts: { pid: number | null; alive?: boolean }): void {
  vi.doMock("../src/daemon/pidfile.js", () => ({
    readPidfile: () => (opts.pid === null ? null : { pid: opts.pid, port: 9876, version: "0.47.1" }),
    isPidAlive: () => opts.alive ?? true,
    isDaemonRunning: async () => ({ running: false, data: null }),
  }));
}

/** The PREDICTION source — must never be consulted while a daemon is running. */
function mockPrediction(status: unknown, spy?: () => void): void {
  vi.doMock("../src/daemon/spawn-detached.js", () => ({
    describeDaemonMemoryCap: () => { spy?.(); return status; },
    spawnDaemonDetached: () => {},
    daemonSpawnEnv: (base: NodeJS.ProcessEnv) => base,
    buildSystemdRunArgs: () => [],
    makeDaemonUnitName: () => "test.service",
  }));
}

/** The OBSERVATION source — this pid's real cgroup memory.max. */
function mockObservation(limit: unknown): void {
  vi.doMock("../src/daemon/cgroup-stats.js", () => ({
    readCgroupMemoryLimitForPid: () => limit,
    readCgroupMemoryStats: () => null,
    resolveOwnCgroupPath: () => null,
    resolveCgroupPathForPid: () => null,
    resolveCgroupPathFromProcFile: () => null,
  }));
}

async function memoryCapRow() {
  const { runDoctor } = await import("../src/onboarding/doctor.js");
  const report = await runDoctor();
  const row = report.checks.find((c) => c.id === "daemon.memory_cap");
  expect(row).toBeDefined();
  return row!;
}

describe("daemon.memory_cap — observed (a daemon is running)", () => {
  it("reports the measured limit of the running daemon, and never consults the prediction", async () => {
    mockAmbient();
    mockPidfile({ pid: 4242, alive: true });
    mockObservation({ state: "limited", limitBytes: 4096 * 1024 * 1024, cgroupPath: "/user.slice/x.service" });
    let predicted = false;
    mockPrediction({ mode: "capped", wrapper: "systemd-run", limitMb: 9999, systemdRunPath: "/usr/bin/systemd-run" },
      () => { predicted = true; });

    const row = await memoryCapRow();
    expect(row.status).toBe("ok");
    expect(row.message).toContain("4242");
    expect(row.message).toContain("4096 MB");
    // The prediction's bogus 9999 must not leak into an observed row.
    expect(row.message).not.toContain("9999");
    expect(row.message).not.toMatch(/would/i);
    expect(row.data?.["observed"]).toBe(true);
    expect(predicted).toBe(false);
  });

  it("WARNS when the running daemon's cgroup is unlimited, even though a fresh spawn would be capped", async () => {
    // This is the always-on install: unit-launched, in-process, uncapped —
    // while systemd-run sits right there on PATH promising a cap.
    mockAmbient();
    mockPidfile({ pid: 4242, alive: true });
    mockObservation({ state: "unlimited", cgroupPath: "/user.slice/scrybe-daemon.service" });
    mockPrediction({ mode: "capped", wrapper: "systemd-run", limitMb: 4096, systemdRunPath: "/usr/bin/systemd-run" });

    const row = await memoryCapRow();
    expect(row.status).toBe("warn");
    expect(row.message).toMatch(/NO memory limit/);
    expect(row.remedy).toBeTruthy();
    expect(row.data?.["observed"]).toBe(true);
  });

  it("says 'unknown' — never 'capped' — when the limit cannot be read", async () => {
    mockAmbient();
    mockPidfile({ pid: 4242, alive: true });
    mockObservation({ state: "unknown", reason: "no-cgroup-v2" });
    mockPrediction({ mode: "capped", wrapper: "systemd-run", limitMb: 4096, systemdRunPath: "/usr/bin/systemd-run" });

    const row = await memoryCapRow();
    expect(row.status).toBe("skip");
    expect(row.message).toMatch(/^Unknown/);
    expect(row.message).not.toMatch(/capped/i);
    // Plain language, never the raw enum tag.
    expect(row.message).not.toContain("no-cgroup-v2");
  });

  it("falls back to the prediction when the pidfile is stale (pid not alive)", async () => {
    mockAmbient();
    mockPidfile({ pid: 4242, alive: false });
    mockObservation({ state: "limited", limitBytes: 1, cgroupPath: "/should-not-be-read" });
    mockPrediction({ mode: "capped", wrapper: "systemd-run", limitMb: 4096, systemdRunPath: "/usr/bin/systemd-run" });

    const row = await memoryCapRow();
    expect(row.data?.["observed"]).toBe(false);
    expect(row.message).toMatch(/would be capped/);
  });
});

describe("daemon.memory_cap — predicted (no daemon running)", () => {
  it("phrases a capped prediction conditionally and marks it unobserved", async () => {
    mockAmbient();
    mockPidfile({ pid: null });
    mockObservation({ state: "unknown", reason: "no-cgroup-v2" });
    mockPrediction({ mode: "capped", wrapper: "systemd-run", limitMb: 4096, systemdRunPath: "/usr/bin/systemd-run" });

    const row = await memoryCapRow();
    expect(row.status).toBe("ok");
    expect(row.message).toContain("No daemon running");
    expect(row.message).toMatch(/would be capped at 4096 MB/);
    expect(row.data?.["observed"]).toBe(false);
  });

  it("warns conditionally when a fresh spawn would be uncapped", async () => {
    mockAmbient();
    mockPidfile({ pid: null });
    mockObservation({ state: "unknown", reason: "no-cgroup-v2" });
    mockPrediction({ mode: "uncapped", reason: "no-user-bus" });

    const row = await memoryCapRow();
    expect(row.status).toBe("warn");
    expect(row.message).toMatch(/would be uncapped/);
    expect(row.remedy).toBeTruthy();
    expect(row.data?.["observed"]).toBe(false);
  });

  it("skips (not warns) where the cap is simply not a platform feature", async () => {
    mockAmbient();
    mockPidfile({ pid: null });
    mockObservation({ state: "unknown", reason: "not-linux" });
    mockPrediction({ mode: "uncapped", reason: "not-linux" });

    const row = await memoryCapRow();
    expect(row.status).toBe("skip");
    expect(row.message).toMatch(/Not applicable/);
  });

  it("degrades to an honest 'could not determine' if the probe itself throws", async () => {
    mockAmbient();
    mockPidfile({ pid: null });
    mockObservation({ state: "unknown", reason: "no-cgroup-v2" });
    vi.doMock("../src/daemon/spawn-detached.js", () => ({
      describeDaemonMemoryCap: () => { throw new Error("probe exploded"); },
      spawnDaemonDetached: () => {},
      daemonSpawnEnv: (base: NodeJS.ProcessEnv) => base,
    }));

    const row = await memoryCapRow();
    expect(row.status).toBe("skip");
    expect(row.message).toContain("Could not determine");
    expect(row.message).toContain("probe exploded");
  });
});
