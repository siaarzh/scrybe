/**
 * Fix round for Plan 121 — MAJOR 2.
 *
 * `_ensureAttempted` (src/mcp-shim.ts) is meant to latch the auto-spawn
 * attempt to at most once per process. The bug: it was only ever set inside
 * the `unavailable && ...` branch of `resolveShimMode()`, so a WARM first
 * resolution (the common case — the daemon is already running) left it
 * `false` for the rest of the process. Concretely: warm session -> the user
 * deliberately runs `scrybe daemon stop` -> the next tool call fails
 * connect-class and invalidates the cached mode -> the NEXT resolution finds
 * the daemon unavailable for the first time this process has ever observed
 * that, and — with the bug — treats it as its first-ever chance to
 * auto-spawn, respawning the daemon the user just stopped and blocking the
 * call for up to `COLD_START_WAIT_MS`.
 *
 * This test drives `resolveShimMode()` (via the `__testing.getShimMode` /
 * `__testing.invalidateCachedMode` seams added for this fix) through exactly
 * that warm -> stopped sequence and asserts `ensureRunning()` is never
 * called a second time, and the second resolution does not block.
 *
 * Mocking pattern mirrors tests/mcp-shim-port-reresolve.test.ts: pidfile.js
 * and daemon/client.js are mocked at module scope (hoisted), with a small
 * `vi.hoisted()` state object so each test can flip "is the daemon up" and
 * observe the mock's own call count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({ daemonUp: true, port: 45678 }));

vi.mock("../src/daemon/pidfile.js", () => ({
  readPidfile: vi.fn(() =>
    hoisted.daemonUp
      ? { pid: 1, port: hoisted.port, startedAt: "", version: "0.50.0", dataDir: "", execPath: "" }
      : null
  ),
  getPidfilePath: vi.fn().mockReturnValue("/tmp/mcp-shim-ensure-attempted-test.pid"),
  writePidfile: vi.fn(),
  removePidfile: vi.fn(),
  isDaemonRunning: vi.fn().mockResolvedValue({ running: false }),
}));

vi.mock("../src/daemon/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/client.js")>()),
  ensureRunning: vi.fn().mockResolvedValue({ ok: false, reason: "opted-out" }),
  DaemonClient: class {
    static fromPidfile() {
      if (!hoisted.daemonUp) return null;
      return new (class {
        async health() {
          return { ready: true };
        }
      })();
    }
  },
  warnVersionSkewCli: vi.fn(),
}));

function makeManifestResponse(): Response {
  const body = { daemon_version: "0.50.0", tools: [] };
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("resolveShimMode — _ensureAttempted latches on the FIRST call, warm or cold (Plan 121 fix round, MAJOR 2)", () => {
  beforeEach(() => {
    // Fix round 2 (MINOR 3) — tests/isolate.ts's own beforeEach (a
    // setupFiles hook, so it runs BEFORE this one) calls vi.resetModules(),
    // which clears the module-import cache but NOT the mocked
    // ensureRunning/pidfile fns' own call history: vi.mock()'s factory
    // result is memoized independently of the module registry, so every
    // `import("../src/daemon/client.js")` across this whole file — in every
    // test — resolves to the SAME `ensureRunning` vi.fn() instance. Without
    // this, "does not re-trigger ensureRunning..." (which calls it 0 times)
    // and "still only calls ensureRunning at most once..." (which asserts
    // exactly 1) only pass together because of this file's CURRENT test
    // order — reorder or delete the first test and the second one's
    // `toHaveBeenCalledTimes(1)` silently starts asserting a different
    // thing. clearAllMocks() resets call history (counts, args) but keeps
    // the mockResolvedValue/mockImplementation set up in the vi.mock()
    // factory above — exactly what's needed here.
    vi.clearAllMocks();
    hoisted.daemonUp = true;
    hoisted.port = 45678;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("/mcp/manifest")) {
          return makeManifestResponse();
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not re-trigger ensureRunning (or block) on a warm -> stopped transition", async () => {
    const { __testing } = await import("../src/mcp-shim.js");
    const { ensureRunning } = await import("../src/daemon/client.js");

    // First resolution: daemon is warm/healthy. This must resolve "healthy"
    // and must NOT call ensureRunning at all (the happy path never needs to
    // spawn anything).
    const first = await __testing.getShimMode();
    expect(first.kind).toBe("healthy");
    expect(ensureRunning).not.toHaveBeenCalled();

    // The user deliberately stops the daemon. Simulate the D8 invalidation a
    // failed RPC call would perform (see the CallTool healthy branch).
    hoisted.daemonUp = false;
    __testing.invalidateCachedMode();

    const second = await __testing.getShimMode();

    expect(second.kind).toBe("degraded");
    // The core assertion: with the bug, this second resolution is the first
    // time `unavailable` was ever true, so `_ensureAttempted` (never set on
    // the warm first call) would let it call ensureRunning() again — which
    // is exactly the respawn-what-the-user-just-stopped hazard.
    //
    // Fix round 2 (MINOR 4) — this used to also time the call and assert
    // `elapsed < 200`, meant to prove it "did not block waiting on a spawn
    // attempt". That assertion could not fail: `ensureRunning` is mocked to
    // `mockResolvedValue(...)` (resolves on the next microtask, no delay) —
    // so even if the bug called it a second time, elapsed would still read
    // near-zero. `not.toHaveBeenCalled()` above is the assertion that
    // actually distinguishes buggy from fixed; the timing check added
    // nothing and is deleted rather than kept as decoration.
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it("still only calls ensureRunning at most once across repeated cold resolutions", async () => {
    hoisted.daemonUp = false;

    const { __testing } = await import("../src/mcp-shim.js");
    const { ensureRunning } = await import("../src/daemon/client.js");

    const first = await __testing.getShimMode();
    expect(first.kind).toBe("degraded");
    // COLD_START_WAIT_MS > 0 by default, so the FIRST cold resolution should
    // attempt exactly one spawn.
    expect(ensureRunning).toHaveBeenCalledTimes(1);

    // Degraded mode is never cached as terminal — getShimMode() re-resolves
    // on every call while degraded (this is what lets a client polling
    // tools/list notice recovery). A second call must not attempt a second
    // spawn.
    const second = await __testing.getShimMode();
    expect(second.kind).toBe("degraded");
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });
});
