/**
 * Real autostart install/uninstall tests — runs against the actual OS.
 * These use the current platform's mechanism (schtasks on Windows, launchd on macOS, etc.).
 *
 * Safe to run on CI (GH runners are ephemeral VMs) and on dev machines
 * (entries are cleaned up in afterAll regardless of test outcome).
 *
 * Skipped in container environments (/.dockerenv / WSL2 without systemd / etc.).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { existsSync } from "fs";

// Detect if we're in a container before requiring any install logic
let containerEnv = false;
try {
  const { isContainer } = await import("../src/daemon/container-detect.js");
  containerEnv = isContainer();
} catch { /* ignore */ }

const SKIP = containerEnv;

describe.skipIf(SKIP)("autostart install/uninstall — real platform", () => {
  // Track installed state so afterAll can always clean up
  let didInstall = false;

  afterAll(async () => {
    if (!didInstall) return;
    try {
      const { uninstallAutostart } = await import("../src/daemon/install/index.js");
      await uninstallAutostart();
    } catch { /* best-effort cleanup */ }
  });

  it("getInstallStatus returns { installed: false } before install", async () => {
    // Pre-condition: uninstall in case a previous test run left debris
    const { uninstallAutostart, getInstallStatus } = await import("../src/daemon/install/index.js");
    await uninstallAutostart().catch(() => {});
    const status = await getInstallStatus();
    expect(status.installed).toBe(false);
  });

  it("installAutostart creates an entry for the current platform", async () => {
    const { installAutostart, getInstallStatus } = await import("../src/daemon/install/index.js");
    const result = await installAutostart();
    didInstall = true;

    expect(result.installed).toBe(true);
    expect(result.method).toBeTruthy();

    // Verify getInstallStatus also sees it
    const status = await getInstallStatus();
    expect(status.installed).toBe(true);
    expect(status.method).toBe(result.method);

    // Verify platform-specific artifact exists
    if (result.detail?.plistPath) {
      expect(existsSync(result.detail.plistPath)).toBe(true);
    }
    if (result.detail?.unitPath) {
      expect(existsSync(result.detail.unitPath)).toBe(true);
    }
  });

  it("installAutostart is idempotent (no --force = no-op, returns same method)", async () => {
    const { installAutostart } = await import("../src/daemon/install/index.js");
    const first  = await installAutostart();
    const second = await installAutostart(); // no --force
    expect(second.installed).toBe(true);
    expect(second.method).toBe(first.method);
  });

  it("uninstallAutostart removes the entry", async () => {
    const { uninstallAutostart, getInstallStatus } = await import("../src/daemon/install/index.js");
    const result = await uninstallAutostart();
    didInstall = false;

    expect(result.removed).toBe(true);
    expect(result.method).toBeTruthy();

    const status = await getInstallStatus();
    expect(status.installed).toBe(false);
  });

  it("uninstallAutostart is idempotent (no entry = { removed: false })", async () => {
    const { uninstallAutostart } = await import("../src/daemon/install/index.js");
    const result = await uninstallAutostart();
    expect(result.removed).toBe(false);
  });
});
