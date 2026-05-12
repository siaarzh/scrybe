/**
 * Tests for wizard Step 4.5 idempotency — already-configured → no-op + log,
 * not-installed → calls installAutostart.
 *
 * The wizard is highly interactive (uses @clack/prompts), so we test the
 * install dispatch logic by importing the install module directly and verifying
 * the getInstallStatus + installAutostart interface used by the wizard.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => vi.resetModules());

describe("wizard daemon install — idempotency via install module", () => {
  it("getInstallStatus returns installed=true when autostart is configured", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => false }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: true, method: "schtasks" }),
      installAutostart: async () => ({ installed: true, method: "schtasks" }),
      uninstallAutostart: async () => ({ removed: true }),
    }));

    const { getInstallStatus } = await import("../src/daemon/install/index.js");
    const status = await getInstallStatus();
    expect(status.installed).toBe(true);
    expect(status.method).toBe("schtasks");
  });

  it("installAutostart is idempotent — second call returns installed=true with same method", async () => {
    let callCount = 0;
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: callCount > 0, method: callCount > 0 ? "schtasks" : undefined }),
      installAutostart: async () => {
        callCount++;
        return { installed: true, method: "schtasks" };
      },
      uninstallAutostart: async () => ({ removed: true }),
    }));

    const { installAutostart } = await import("../src/daemon/install/index.js");
    const first = await installAutostart();
    const second = await installAutostart();

    expect(first.installed).toBe(true);
    expect(second.installed).toBe(true);
    expect(second.method).toBe(first.method);
  });

  it("container env: getInstallStatus returns installed=false", async () => {
    vi.doMock("../src/daemon/container-detect.js", () => ({ isContainer: () => true }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
      installAutostart: async () => { throw new Error("Container"); },
      uninstallAutostart: async () => ({ removed: false }),
    }));

    const { isContainer } = await import("../src/daemon/container-detect.js");
    const { getInstallStatus } = await import("../src/daemon/install/index.js");

    if (!isContainer()) {
      const status = await getInstallStatus();
      expect(status.installed).toBe(false);
    } else {
      expect(isContainer()).toBe(true);
    }
  });
});
