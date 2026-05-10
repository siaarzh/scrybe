/**
 * Tests for daemon.installed and daemon.running doctor rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-doctor-daemon-test-"));
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

async function runFresh() {
  const { runDoctor } = await import("../src/onboarding/doctor.js");
  return runDoctor();
}

describe("daemon.installed row", () => {
  it("is warn when autostart is not configured (non-container)", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => null,
      isDaemonRunning: async () => ({ running: false, data: null }),
    }));

    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "daemon.installed");
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.remedy).toContain("scrybe daemon install");
  });

  it("is ok when autostart is configured (non-container)", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: true, method: "schtasks" }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => null,
      isDaemonRunning: async () => ({ running: false, data: null }),
    }));

    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "daemon.installed");
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.message).toContain("schtasks");
  });

  it("is skip in container environment", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => true }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => null,
      isDaemonRunning: async () => ({ running: false, data: null }),
    }));

    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "daemon.installed");
    expect(check).toBeDefined();
    expect(check!.status).toBe("skip");
  });
});

describe("daemon.running row", () => {
  it("is warn when no pidfile present", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => null,
      isDaemonRunning: async () => ({ running: false, data: null }),
    }));

    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "daemon.running");
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.remedy).toContain("scrybe daemon start");
  });

  it("is ok when pidfile present and health check passes", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: true, method: "schtasks" }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => ({ pid: 12345, port: 9876, version: "0.32.4" }),
      isDaemonRunning: async () => ({ running: true, data: { pid: 12345, port: 9876 } }),
    }));
    vi.doMock("../src/daemon/client.js", () => ({
      DaemonClient: {
        fromPidfile: () => ({
          health: async () => ({ ready: true, version: "0.32.4", uptimeMs: 1000, pid: 12345 }),
        }),
      },
    }));

    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "daemon.running");
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.message).toContain("12345");
    expect(check!.message).toContain("9876");
  });

  it("is fail when pidfile present but health check fails", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: true, method: "schtasks" }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => ({ pid: 12345, port: 9876, version: "0.32.4" }),
      isDaemonRunning: async () => ({ running: false, data: null }),
    }));
    vi.doMock("../src/daemon/client.js", () => ({
      DaemonClient: {
        fromPidfile: () => ({
          health: async () => { throw new Error("ECONNREFUSED"); },
        }),
      },
    }));

    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "daemon.running");
    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    expect(check!.remedy).toContain("scrybe daemon restart");
  });
});
