/**
 * Unit tests for the always-on wizard prompt (Step 4.5).
 * Mocks installAutostart so no real OS changes are made.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// The wizard uses dynamic imports internally — we test the install dispatch path
// by importing the install module and verifying its exported interface.

describe("autostart install interface", () => {
  afterEach(() => vi.resetModules());

  it("getInstallStatus returns { installed: false } in container env", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => true,
    }));
    const { getInstallStatus } = await import("../src/daemon/install/index.js");
    const result = await getInstallStatus();
    expect(result.installed).toBe(false);
    vi.resetModules();
  });

  it("installAutostart throws in container env", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => true,
    }));
    const { installAutostart } = await import("../src/daemon/install/index.js");
    await expect(installAutostart()).rejects.toThrow("Container");
    vi.resetModules();
  });

  it("uninstallAutostart returns { removed: false } in container env", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => true,
    }));
    const { uninstallAutostart } = await import("../src/daemon/install/index.js");
    const result = await uninstallAutostart();
    expect(result.removed).toBe(false);
    vi.resetModules();
  });
});

describe("launcher script", () => {
  afterEach(() => vi.resetModules());

  it("writeLauncherScript creates a file containing SCRYBE_DAEMON_KEEP_ALIVE=1", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const tmpDir = mkdtempSync(join(tmpdir(), "scrybe-launcher-test-"));
    try {
      vi.doMock("../src/config.js", () => ({
        config: { dataDir: tmpDir },
        VERSION: "test",
      }));
      const { writeLauncherScript } = await import("../src/daemon/install/shared.js");
      const scriptPath = writeLauncherScript({
        execPath: process.execPath,
        scriptPath: "/fake/dist/index.js",
      });
      const content = readFileSync(scriptPath, "utf8");
      expect(content).toContain("SCRYBE_DAEMON_KEEP_ALIVE");
      expect(content).toContain("daemon start");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
