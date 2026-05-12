/**
 * Unit tests for windows-av.ts
 *
 * Tests cover:
 * - decodeProductState() bitfield decoder with the two known repro fixtures
 * - detectWindowsAv() non-Windows skip behaviour
 * - detectWindowsAv() mocked Windows scenarios (defender active/skip, MBAM)
 * - doctor.ts integration: env.windows_av.* rows via runDoctor() fixture mock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── bitfield decoder unit tests (platform-independent) ───────────────────────

// Import the module directly — these tests run on all platforms
import { decodeProductState } from "../src/onboarding/windows-av.js";

describe("decodeProductState — bitfield decoder", () => {
  /**
   * Fixture 397312 (decimal) = 0x61000
   * Bit 12 (0x1000) set   → real-time enabled
   * Bit 4  (0x0010) unset → signatures bit not set in MBAM's encoding
   *
   * This is the MBAM active+real-time fixture from the session.
   * "active+real-time+current" in the plan refers to the product being active
   * and in real-time mode — not that bit 4 is set (MBAM does not use that bit).
   */
  it("397312 → real-time enabled, signatures bit unset (MBAM fixture)", () => {
    const result = decodeProductState(397312);
    expect(result.realTimeEnabled).toBe(true);
    expect(result.signaturesUpToDate).toBe(false);
  });

  /**
   * Fixture 393472 (decimal) = 0x60100
   * Bit 12 (0x1000) NOT set → real-time disabled
   * Bit 4  (0x0010) NOT set → signatures not up-to-date
   * (Note: 0x60100 & 0x1000 = 0, 0x60100 & 0x10 = 0)
   * This is the Defender registered but real-time off fixture from the session.
   */
  it("393472 → real-time disabled, signatures not up-to-date (Defender-passive fixture)", () => {
    const result = decodeProductState(393472);
    expect(result.realTimeEnabled).toBe(false);
    expect(result.signaturesUpToDate).toBe(false);
  });

  it("0 → both false", () => {
    const result = decodeProductState(0);
    expect(result.realTimeEnabled).toBe(false);
    expect(result.signaturesUpToDate).toBe(false);
  });

  it("0x1010 → both true", () => {
    const result = decodeProductState(0x1010);
    expect(result.realTimeEnabled).toBe(true);
    expect(result.signaturesUpToDate).toBe(true);
  });

  it("0x1000 → real-time on, signatures off", () => {
    const result = decodeProductState(0x1000);
    expect(result.realTimeEnabled).toBe(true);
    expect(result.signaturesUpToDate).toBe(false);
  });

  it("0x0010 → real-time off, signatures on", () => {
    const result = decodeProductState(0x0010);
    expect(result.realTimeEnabled).toBe(false);
    expect(result.signaturesUpToDate).toBe(true);
  });
});

// ── detectWindowsAv() non-Windows skip ───────────────────────────────────────

describe("detectWindowsAv — non-Windows", () => {
  it("returns skip=true on non-win32 platforms", async () => {
    // Mock process.platform to non-win32 if we're actually on Windows
    // The function checks process.platform at call time so we can vi.spyOn
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const { detectWindowsAv } = await import("../src/onboarding/windows-av.js");
      const result = await detectWindowsAv("/tmp/scrybe");
      expect(result.skip).toBe(true);
      expect(result.skipReason).toBe("non-windows");
      expect(result.mbamDetected).toBe(false);
      expect(result.noActiveAv).toBe(false);
    } finally {
      platformSpy.mockRestore();
    }
  });
});

// ── doctor.ts integration tests for env.windows_av.* rows ────────────────────

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-av-doctor-test-"));
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = tmp;
  process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
  process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = "voyage-code-3";
  process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = "1024";
  process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test-key";
  delete process.env["SCRYBE_DOCTOR_AV_MBAM_VERIFIED"];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env["SCRYBE_DATA_DIR"];
  delete process.env["SCRYBE_DOCTOR_AV_MBAM_VERIFIED"];
});

function mockDoctorDeps() {
  vi.doMock("../src/onboarding/validate-provider.js", () => ({
    validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
    validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
  }));
  vi.doMock("../src/daemon/pidfile.js", () => ({
    readPidfile: () => null,
    isDaemonRunning: () => false,
  }));
  vi.doMock("../src/onboarding/mcp-config.js", () => ({
    detectMcpConfigs: () => [],
    readScrybeEntry: () => null,
    proposeScrybeEntry: () => ({}),
  }));
  vi.doMock("../src/daemon/container-detect.js", () => ({
    isContainer: () => false,
  }));
  vi.doMock("../src/daemon/install/index.js", () => ({
    getInstallStatus: async () => ({ installed: false }),
  }));
}

describe("runDoctor — env.windows_av rows (Windows platform fixture)", () => {
  it("emits zero env.windows_av.* rows on non-Windows (mocked)", async () => {
    // Mock platform to non-win32
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();
    const avChecks = report.checks.filter((c) => c.id.startsWith("env.windows_av."));
    expect(avChecks).toHaveLength(0);
  });

  it("emits env.windows_av.defender warn when Defender active and DATA_DIR not excluded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.doMock("../src/onboarding/windows-av.js", () => ({
      detectWindowsAv: async () => ({
        skip: false,
        defender: {
          runningMode: "Normal",
          realTimeEnabled: true,
          exclusions: [],
          dataDir: tmp,
          dataDirExcluded: false,
          registered: true,
          active: true,
        },
        mbamDetected: false,
        noActiveAv: false,
      }),
      AV_README_ANCHOR: "#windows-av",
      decodeProductState: (s: number) => ({ realTimeEnabled: (s & 0x1000) !== 0, signaturesUpToDate: (s & 0x10) !== 0 }),
    }));
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const defRow = report.checks.find((c) => c.id === "env.windows_av.defender");
    expect(defRow).toBeDefined();
    expect(defRow!.status).toBe("warn");
    expect(defRow!.message).toContain("DATA_DIR not in exclusion list");
    expect(defRow!.remedy).toContain("#windows-av");

    // No MBAM → MBAM row should be skip
    const mbamRow = report.checks.find((c) => c.id === "env.windows_av.mbam");
    expect(mbamRow).toBeDefined();
    expect(mbamRow!.status).toBe("skip");

    // repos_tip should appear (at least one warn)
    const tipRow = report.checks.find((c) => c.id === "env.windows_av.repos_tip");
    expect(tipRow).toBeDefined();
    expect(tipRow!.message).toContain("#windows-av");
  });

  it("emits env.windows_av.defender ok when DATA_DIR is excluded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.doMock("../src/onboarding/windows-av.js", () => ({
      detectWindowsAv: async () => ({
        skip: false,
        defender: {
          runningMode: "Normal",
          realTimeEnabled: true,
          exclusions: [tmp],
          dataDir: tmp,
          dataDirExcluded: true,
          registered: true,
          active: true,
        },
        mbamDetected: false,
        noActiveAv: false,
      }),
      AV_README_ANCHOR: "#windows-av",
      decodeProductState: (s: number) => ({ realTimeEnabled: (s & 0x1000) !== 0, signaturesUpToDate: (s & 0x10) !== 0 }),
    }));
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const defRow = report.checks.find((c) => c.id === "env.windows_av.defender");
    expect(defRow).toBeDefined();
    expect(defRow!.status).toBe("ok");

    // No warn → no repos_tip
    const tipRow = report.checks.find((c) => c.id === "env.windows_av.repos_tip");
    expect(tipRow).toBeUndefined();
  });

  it("emits env.windows_av.mbam warn when MBAM detected (no SCRYBE_DOCTOR_AV_MBAM_VERIFIED)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.doMock("../src/onboarding/windows-av.js", () => ({
      detectWindowsAv: async () => ({
        skip: false,
        defender: {
          runningMode: "Not running",
          realTimeEnabled: false,
          exclusions: [],
          dataDir: tmp,
          dataDirExcluded: false,
          registered: true,
          active: false,
        },
        mbamDetected: true,
        noActiveAv: false,
      }),
      AV_README_ANCHOR: "#windows-av",
      decodeProductState: (s: number) => ({ realTimeEnabled: (s & 0x1000) !== 0, signaturesUpToDate: (s & 0x10) !== 0 }),
    }));
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const mbamRow = report.checks.find((c) => c.id === "env.windows_av.mbam");
    expect(mbamRow).toBeDefined();
    expect(mbamRow!.status).toBe("warn");
    expect(mbamRow!.remedy).toContain("#windows-av");

    // Defender not active → skip row
    const defRow = report.checks.find((c) => c.id === "env.windows_av.defender");
    expect(defRow).toBeDefined();
    expect(defRow!.status).toBe("skip");

    // repos_tip should appear (MBAM warn)
    const tipRow = report.checks.find((c) => c.id === "env.windows_av.repos_tip");
    expect(tipRow).toBeDefined();
  });

  it("SCRYBE_DOCTOR_AV_MBAM_VERIFIED=1 downgrades MBAM row from warn to ok", async () => {
    process.env["SCRYBE_DOCTOR_AV_MBAM_VERIFIED"] = "1";
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.doMock("../src/onboarding/windows-av.js", () => ({
      detectWindowsAv: async () => ({
        skip: false,
        defender: {
          runningMode: "Not running",
          realTimeEnabled: false,
          exclusions: [],
          dataDir: tmp,
          dataDirExcluded: false,
          registered: true,
          active: false,
        },
        mbamDetected: true,
        noActiveAv: false,
      }),
      AV_README_ANCHOR: "#windows-av",
      decodeProductState: (s: number) => ({ realTimeEnabled: (s & 0x1000) !== 0, signaturesUpToDate: (s & 0x10) !== 0 }),
    }));
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const mbamRow = report.checks.find((c) => c.id === "env.windows_av.mbam");
    expect(mbamRow).toBeDefined();
    expect(mbamRow!.status).toBe("ok");
    expect(mbamRow!.message).toContain("SCRYBE_DOCTOR_AV_MBAM_VERIFIED=1");
  });

  it("emits env.windows_av.no_active_av ok when Defender off and no other AV active", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.doMock("../src/onboarding/windows-av.js", () => ({
      detectWindowsAv: async () => ({
        skip: false,
        defender: {
          runningMode: "Not running",
          realTimeEnabled: false,
          exclusions: [],
          dataDir: tmp,
          dataDirExcluded: false,
          registered: true,
          active: false,
        },
        mbamDetected: false,
        noActiveAv: true,
      }),
      AV_README_ANCHOR: "#windows-av",
      decodeProductState: (s: number) => ({ realTimeEnabled: (s & 0x1000) !== 0, signaturesUpToDate: (s & 0x10) !== 0 }),
    }));
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const noAvRow = report.checks.find((c) => c.id === "env.windows_av.no_active_av");
    expect(noAvRow).toBeDefined();
    expect(noAvRow!.status).toBe("ok");

    // No warn → no repos_tip
    const tipRow = report.checks.find((c) => c.id === "env.windows_av.repos_tip");
    expect(tipRow).toBeUndefined();
  });

  it("emits single skip row when PowerShell times out", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.doMock("../src/onboarding/windows-av.js", () => ({
      detectWindowsAv: async () => ({
        skip: true,
        skipReason: "powershell-timeout-or-error",
        mbamDetected: false,
        noActiveAv: false,
      }),
      AV_README_ANCHOR: "#windows-av",
      decodeProductState: (s: number) => ({ realTimeEnabled: (s & 0x1000) !== 0, signaturesUpToDate: (s & 0x10) !== 0 }),
    }));
    mockDoctorDeps();
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const avChecks = report.checks.filter((c) => c.id.startsWith("env.windows_av."));
    expect(avChecks).toHaveLength(1);
    expect(avChecks[0]!.status).toBe("skip");
    expect(avChecks[0]!.id).toBe("env.windows_av.defender");
  });
});
