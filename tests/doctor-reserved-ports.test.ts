/**
 * Windows reserved TCP port range check for `scrybe doctor` (GitHub #100).
 *
 * Drives the pure parser/lookup functions directly with injected `netsh`
 * output — no real `netsh` invocation, no real sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseExcludedPortRanges, findContainingRange } from "../src/onboarding/windows-reserved-ports.js";
import { evaluateReservedPortCheck } from "../src/onboarding/doctor.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
}));

// bindSticky's fallback path calls diagEmit — mocked here so the diagEmit
// assertions below don't touch the real daemon-log.jsonl.
const diagEmitMock = vi.hoisted(() => vi.fn());
vi.mock("../src/daemon/events.js", () => ({
  diagEmit: diagEmitMock,
}));

const SAMPLE_NETSH_OUTPUT = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
     50000       50059    *
     58400       58500
     60000       60100    *

* - Administered port exclusions.

`;

describe("parseExcludedPortRanges", () => {
  it("parses start/end pairs out of real netsh table output", () => {
    const ranges = parseExcludedPortRanges(SAMPLE_NETSH_OUTPUT);
    expect(ranges).toEqual([
      { start: 50000, end: 50059 },
      { start: 58400, end: 58500 },
      { start: 60000, end: 60100 },
    ]);
  });

  it("returns an empty array for unparseable output", () => {
    const ranges = parseExcludedPortRanges("The requested operation requires elevation.\r\n");
    expect(ranges).toEqual([]);
  });

  it("returns an empty array for empty output", () => {
    expect(parseExcludedPortRanges("")).toEqual([]);
  });
});

describe("findContainingRange", () => {
  const ranges = parseExcludedPortRanges(SAMPLE_NETSH_OUTPUT);

  it("finds the range containing a port inside a listed block — warn case", () => {
    // 58451 is the daemon's default port; this is the condition the doctor
    // check reports as `warn`.
    const hit = findContainingRange(ranges, 58451);
    expect(hit).toEqual({ start: 58400, end: 58500 });
  });

  it("finds no range for a port outside every listed block", () => {
    // Chosen behaviour: a port clear of every reserved range produces `ok`
    // in the doctor check (not a missing row) — asserted here at the
    // lookup-function level, since that's what the doctor check branches on.
    const hit = findContainingRange(ranges, 12345);
    expect(hit).toBeUndefined();
  });

  it("treats range boundaries as inclusive", () => {
    expect(findContainingRange(ranges, 58400)).toEqual({ start: 58400, end: 58500 });
    expect(findContainingRange(ranges, 58500)).toEqual({ start: 58400, end: 58500 });
    expect(findContainingRange(ranges, 58399)).toBeUndefined();
    expect(findContainingRange(ranges, 58501)).toBeUndefined();
  });
});

describe("detectReservedPortRanges — platform gating", () => {
  it("on a non-Windows platform, the check must not run at all", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { detectReservedPortRanges } = await import("../src/onboarding/windows-reserved-ports.js");
      const report = detectReservedPortRanges();
      expect(report.skip).toBe(true);
      expect(report.skipReason).toBe("non-windows");
      expect(report.ranges).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("detectReservedPortRanges — Windows, netsh output injected", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  it("real-shaped netsh output parses into ranges (no real netsh invoked)", async () => {
    execFileSyncMock.mockReturnValue(SAMPLE_NETSH_OUTPUT);
    try {
      const { detectReservedPortRanges } = await import("../src/onboarding/windows-reserved-ports.js");
      const report = detectReservedPortRanges();
      expect(report.skip).toBe(false);
      expect(report.ranges).toContainEqual({ start: 58400, end: 58500 });
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "netsh",
        ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
        expect.objectContaining({ windowsHide: true })
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("unparseable netsh output produces exactly one skip report", async () => {
    execFileSyncMock.mockReturnValue("The requested operation requires elevation.\r\n");
    try {
      const { detectReservedPortRanges } = await import("../src/onboarding/windows-reserved-ports.js");
      const report = detectReservedPortRanges();
      expect(report.skip).toBe(true);
      expect(report.skipReason).toBe("unparseable");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("header-only netsh output (zero reservations) parses cleanly, not as unparseable", async () => {
    // A machine with no reserved ranges still prints the header + separator,
    // just no data rows. Empty ranges here is a healthy `ok`, not a parse
    // failure — GitHub issue #100.
    const HEADER_ONLY_OUTPUT = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------

`;
    execFileSyncMock.mockReturnValue(HEADER_ONLY_OUTPUT);
    try {
      const { detectReservedPortRanges } = await import("../src/onboarding/windows-reserved-ports.js");
      const report = detectReservedPortRanges();
      expect(report.skip).toBe(false);
      expect(report.ranges).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("netsh missing/timing out produces exactly one skip report", async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("ENOENT"); });
    try {
      const { detectReservedPortRanges } = await import("../src/onboarding/windows-reserved-ports.js");
      const report = detectReservedPortRanges();
      expect(report.skip).toBe(true);
      expect(report.skipReason).toBe("netsh-unavailable");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

// ─── evaluateReservedPortCheck — mode selection must match startHttpServer ──
//
// startHttpServer (http-server.ts) branches on `portEnv != null` alone, with
// no fallback on that path — see GitHub issue #100. These tests drive the
// same four SCRYBE_DAEMON_PORT shapes the daemon can see and assert doctor
// reports on exactly the candidate(s) the daemon will actually try.

describe("evaluateReservedPortCheck — SCRYBE_DAEMON_PORT unset", () => {
  const RANGES = [{ start: 58400, end: 58500 }];

  it("reports warn when the pidfile port is reserved", () => {
    const row = evaluateReservedPortCheck(undefined, 58450, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("58450");
    expect(row.message).toContain("bind a different port instead");
  });

  it("reports warn when only DEFAULT_PORT (58451) is reserved", () => {
    const row = evaluateReservedPortCheck(undefined, 12345, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("58451");
  });

  it("reports ok when both candidates are clear", () => {
    const row = evaluateReservedPortCheck(undefined, 12345, 58451, [{ start: 1, end: 100 }]);
    expect(row.status).toBe("ok");
  });
});

describe("evaluateReservedPortCheck — SCRYBE_DAEMON_PORT set to a valid port", () => {
  const RANGES = [{ start: 58400, end: 58500 }];

  it("valid and reserved → warn naming the sole candidate, no fallback wording", () => {
    const row = evaluateReservedPortCheck("58450", 12345, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("58450");
    expect(row.message).toContain("FAIL to start");
    expect(row.message).toContain("no fallback");
  });

  it("valid and clear → ok", () => {
    const row = evaluateReservedPortCheck("9999", 12345, 58451, RANGES);
    expect(row.status).toBe("ok");
  });
});

describe("evaluateReservedPortCheck — SCRYBE_DAEMON_PORT=0", () => {
  it("reports ok — the daemon takes an OS-assigned port, so no candidate can be reserved", () => {
    // Even with the pidfile port and DEFAULT_PORT both inside a reserved
    // range, "0" must still report ok: the daemon never tries either.
    const row = evaluateReservedPortCheck("0", 58450, 58451, [{ start: 1, end: 65535 }]);
    expect(row.status).toBe("ok");
    expect(row.message).toContain("0");
    expect(row.message.toLowerCase()).toContain("os-assigned");
  });
});

describe("evaluateReservedPortCheck — SCRYBE_DAEMON_PORT set to an invalid value", () => {
  const RANGES = [{ start: 58400, end: 58500 }];

  it("empty string → warn naming the value, not the two-candidate list", () => {
    const row = evaluateReservedPortCheck("", 58450, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("not a valid port");
    expect(row.message).not.toContain("58450");
    expect(row.message).not.toContain("58451");
  });

  it("non-numeric → warn naming the offending value", () => {
    const row = evaluateReservedPortCheck("abc", 58450, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("abc");
    expect(row.remedy).toBeDefined();
    expect(row.remedy).toContain("1 to 65535");
  });

  it("negative → warn naming the offending value", () => {
    const row = evaluateReservedPortCheck("-1", 58450, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("-1");
  });

  it("above 65535 → warn naming the offending value", () => {
    const row = evaluateReservedPortCheck("70000", 58450, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("70000");
  });

  it("invalid value does not silently fall back to the pidfile/DEFAULT_PORT candidate list", () => {
    // Even though the pidfile port (58450) IS reserved, the row must talk
    // about the broken env value, not the pidfile port.
    const row = evaluateReservedPortCheck("not-a-port", 58450, 58451, RANGES);
    expect(row.message).not.toContain("58450");
    expect(row.remedy).not.toContain("58450");
  });
});

// ─── bindSticky diagEmit — fallback records name refused port, code, next ───
//
// Injected bind failures (never real reserved ports — those move between
// runs) drive bindSticky's two diagEmit call sites directly.

function makeEaccesError(): Error {
  return Object.assign(new Error("listen EACCES :::PORT"), { code: "EACCES" });
}

// The daemon hands parseInt(value, 10) straight to listen(), so the check must
// classify these the same way. A stricter rule — rejecting anything whose text
// is not the number back again — reports a daemon that cannot start while the
// real one starts fine. See GitHub issue #100.
describe("evaluateReservedPortCheck — values parseInt accepts but strict parsing would not", () => {
  const RANGES = [{ start: 58400, end: 58500 }];

  it("trailing junk is truncated the way the daemon truncates it", () => {
    const row = evaluateReservedPortCheck("58450abc", 12345, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("58450");
    expect(row.message).toContain("falls inside a reserved range");
  });

  it("a leading plus is a valid port, not a misconfiguration", () => {
    const row = evaluateReservedPortCheck("+58450", 12345, 58451, RANGES);
    expect(row.status).toBe("warn");
    expect(row.message).toContain("falls inside a reserved range");
  });

  it("hex notation parses as 0 — the daemon takes an OS-assigned port", () => {
    const row = evaluateReservedPortCheck("0x10", 58450, 58451, RANGES);
    expect(row.status).toBe("ok");
    expect(row.message).toContain("OS-assigned port");
  });

  it("exponent notation parses as its leading digits, not its value", () => {
    // parseInt("1e3", 10) is 1, so the daemon binds port 1 — never 1000.
    const row = evaluateReservedPortCheck("1e3", 58450, 58451, [{ start: 1000, end: 1000 }]);
    expect(row.status).toBe("ok");
    expect(row.message).not.toContain("1000");
  });
});

describe("bindSticky — diagEmit fallback records", () => {
  afterEach(() => {
    diagEmitMock.mockClear();
  });

  it("stale-port fallback emits a record naming the refused port, code, and next port", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const DEFAULT_PORT = 58451;
    const result = await bindSticky({
      tryBind: async (port: number) => {
        if (port === STALE_PORT) throw makeEaccesError();
        return port;
      },
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(DEFAULT_PORT);
    expect(diagEmitMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.bind.fallback",
      detail: expect.objectContaining({
        refusedPort: STALE_PORT,
        code: "EACCES",
        nextPort: DEFAULT_PORT,
      }),
    }));
  });

  it("DEFAULT_PORT fallback emits a record naming the refused port, code, and the ephemeral next port", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const DEFAULT_PORT = 58451;
    const EPHEMERAL = 49999;
    const result = await bindSticky({
      tryBind: async (port: number) => {
        if (port === STALE_PORT || port === DEFAULT_PORT) throw makeEaccesError();
        return port === 0 ? EPHEMERAL : port;
      },
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(EPHEMERAL);
    expect(diagEmitMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.bind.fallback",
      detail: expect.objectContaining({
        refusedPort: DEFAULT_PORT,
        code: "EACCES",
        nextPort: "ephemeral",
      }),
    }));
    // Both fallback sites fired: stale→DEFAULT_PORT, then DEFAULT_PORT→ephemeral.
    expect(diagEmitMock).toHaveBeenCalledTimes(2);
  });
});
