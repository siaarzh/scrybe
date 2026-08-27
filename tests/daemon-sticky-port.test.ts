/**
 * Daemon sticky port — bindSticky bind-order logic.
 * Drives the real bindSticky via its injected tryBind + readPidfilePort
 * parameters (GitHub #100) — no real sockets or live-daemon ports touched.
 *
 * (1) Stale pidfile port free → daemon binds it.
 * (2) Stale port occupied (EADDRINUSE) → falls through to DEFAULT_PORT/ephemeral.
 * (3) SCRYBE_DAEMON_PORT set → daemon binds exactly that port (verified through
 *     startHttpServer, not by inspection).
 * (4) Missing/corrupt pidfile → binds DEFAULT_PORT.
 * (5) Stale/default port fails with EACCES (the Windows reserved-port case,
 *     GitHub #100) → falls through the same as EADDRINUSE.
 * (6) A non-retryable error code (e.g. EPERM) aborts instead of falling
 *     through — this is what stops RETRYABLE_BIND_ERROR_CODES being widened
 *     carelessly later.
 *
 * NOTE: Tests never bind the real DEFAULT_PORT 58451 — all port numbers are
 * either injected mock values or real ephemeral ports obtained from the OS via
 * the injected tryBind stubs (or, for the real-socket tests below, via an
 * ephemeral pidfile port / SCRYBE_DAEMON_PORT so the real tryBind never
 * reaches 58451 either).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 58451;

function makeAddrinuseError(): Error {
  return Object.assign(new Error("listen EADDRINUSE :::PORT"), { code: "EADDRINUSE" });
}

/** Windows reserved-port case (GitHub #100) — mirrors makeAddrinuseError(). */
function makeEaccesError(): Error {
  return Object.assign(new Error("listen EACCES :::PORT"), { code: "EACCES" });
}

/** A bind error whose code is NOT in RETRYABLE_BIND_ERROR_CODES — must abort, never fall through. */
function makeEpermError(): Error {
  return Object.assign(new Error("listen EPERM :::PORT"), { code: "EPERM" });
}

/** Grab a free ephemeral port from the OS and release it immediately. */
async function grabFreePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/**
 * Build a stub tryBind that succeeds (returns the given port) or fails with
 * EADDRINUSE for ports in the `occupied` set.
 * Port 0 is treated as "give me an ephemeral port" and returns a fixed test value.
 */
function makeTryBindStub(occupied: Set<number>, ephemeralResult = 49999): (port: number) => Promise<number> {
  return async (port: number) => {
    if (port === 0) return ephemeralResult;
    if (occupied.has(port)) throw makeAddrinuseError();
    return port;
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bindSticky — bind order logic", () => {
  it("(1) stale pidfile port free → binds stale port", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const result = await bindSticky({
      tryBind: makeTryBindStub(new Set()),  // nothing occupied
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(STALE_PORT);
  });

  it("(2) stale port occupied → falls through to DEFAULT_PORT", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const result = await bindSticky({
      tryBind: makeTryBindStub(new Set([STALE_PORT])),  // stale port occupied
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(DEFAULT_PORT);
  });

  it("(2b) stale port AND default port occupied → falls through to ephemeral", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const EPHEMERAL = 49999;
    const result = await bindSticky({
      tryBind: makeTryBindStub(new Set([STALE_PORT, DEFAULT_PORT]), EPHEMERAL),
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(EPHEMERAL);
  });

  it("(5) stale port fails with EACCES → falls through to DEFAULT_PORT", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const result = await bindSticky({
      tryBind: async (port: number) => {
        if (port === STALE_PORT) throw makeEaccesError();
        return port;
      },
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(DEFAULT_PORT);
  });

  it("(5b) stale port AND default port fail with EACCES → falls through to ephemeral", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const EPHEMERAL = 49999;
    const result = await bindSticky({
      tryBind: async (port: number) => {
        if (port === STALE_PORT || port === DEFAULT_PORT) throw makeEaccesError();
        return port === 0 ? EPHEMERAL : port;
      },
      readPidfilePort: () => STALE_PORT,
    });

    expect(result).toBe(EPHEMERAL);
  });

  it("(6) non-retryable error code (EPERM) aborts instead of falling through", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const STALE_PORT = 37603;
    const attempts: number[] = [];
    const promise = bindSticky({
      tryBind: async (port: number) => {
        attempts.push(port);
        throw makeEpermError();
      },
      readPidfilePort: () => STALE_PORT,
    });

    await expect(promise).rejects.toMatchObject({ code: "EPERM" });
    // Aborted on the first (stale-port) attempt — never reached DEFAULT_PORT.
    expect(attempts).toEqual([STALE_PORT]);
  });

  it("(4) missing pidfile (null) → binds DEFAULT_PORT", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const result = await bindSticky({
      tryBind: makeTryBindStub(new Set()),
      readPidfilePort: () => null,
    });

    expect(result).toBe(DEFAULT_PORT);
  });

  it("(4b) corrupt pidfile (throws) → binds DEFAULT_PORT", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const result = await bindSticky({
      tryBind: makeTryBindStub(new Set()),
      readPidfilePort: () => { throw new SyntaxError("corrupt"); },
    });

    expect(result).toBe(DEFAULT_PORT);
  });

  it("(4c) pidfile port=0 (mid-write) → binds DEFAULT_PORT", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    const result = await bindSticky({
      tryBind: makeTryBindStub(new Set()),
      readPidfilePort: () => 0,  // port 0 = not yet written
    });

    expect(result).toBe(DEFAULT_PORT);
  });

  // A failing expect() below must not skip stopHttpServer() — that would
  // leave a listening socket open for the rest of the run. Tear down in
  // afterEach (which always runs, pass or fail) instead of after the assertion.
  afterEach(async () => {
    const { stopHttpServer } = await import("../src/daemon/http-server.js");
    await stopHttpServer();
  });

  it("(3) SCRYBE_DAEMON_PORT set → daemon binds exactly that port", async () => {
    const originalPortEnv = process.env["SCRYBE_DAEMON_PORT"];
    const freePort = await grabFreePort();
    process.env["SCRYBE_DAEMON_PORT"] = String(freePort);

    try {
      const { startHttpServer } = await import("../src/daemon/http-server.js");
      const { port } = await startHttpServer({ startedAt: new Date() });

      expect(port).toBe(freePort);
    } finally {
      if (originalPortEnv === undefined) delete process.env["SCRYBE_DAEMON_PORT"];
      else process.env["SCRYBE_DAEMON_PORT"] = originalPortEnv;
    }
  });

  it("stale port equals DEFAULT_PORT → skips stale-port attempt and tries DEFAULT_PORT only once", async () => {
    const { bindSticky } = await import("../src/daemon/http-server.js");

    // If stale port happens to equal DEFAULT_PORT (e.g. daemon had been on 58451
    // before), bindSticky should not try DEFAULT_PORT twice.
    // The code: stalePort !== DEFAULT_PORT → null, so stale port is skipped.
    const bindAttempts: number[] = [];
    const tb = async (port: number) => {
      bindAttempts.push(port);
      return port;
    };

    const result = await bindSticky({
      tryBind: tb,
      readPidfilePort: () => DEFAULT_PORT,  // stale == DEFAULT_PORT → excluded from stalePort
    });

    expect(result).toBe(DEFAULT_PORT);
    // Should only attempt DEFAULT_PORT once, not twice
    expect(bindAttempts).toEqual([DEFAULT_PORT]);
  });
});

// ─── Real socket test — verify no actual DEFAULT_PORT collision ─────────────────

describe("bindSticky — real socket (ephemeral ports only, no DEFAULT_PORT)", () => {
  let servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("with stale port actually occupied, falls through and binds successfully", async () => {
    // Bind a real ephemeral server to grab a port, then use it as "stale"
    const occupier = net.createServer();
    servers.push(occupier);
    await new Promise<void>((r) => occupier.listen(0, "127.0.0.1", r));
    const stalePort = (occupier.address() as net.AddressInfo).port;

    // Now grab another free ephemeral port to use as "DEFAULT_PORT substitute"
    const freeServer = net.createServer();
    servers.push(freeServer);
    await new Promise<void>((r) => freeServer.listen(0, "127.0.0.1", r));
    const freePort = (freeServer.address() as net.AddressInfo).port;
    freeServer.close(); // release it so our tryBind can grab it

    // Build a real tryBind that uses actual sockets
    const realTryBind = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const s = net.createServer();
        const onError = (e: Error) => { s.removeAllListeners(); reject(e); };
        s.once("error", onError);
        s.listen(port, "127.0.0.1", () => {
          s.removeAllListeners("error");
          const p = (s.address() as net.AddressInfo).port;
          servers.push(s);
          resolve(p);
        });
      });

    // Use a stub that fails for stalePort (occupied) and delegates the freePort check
    // to realTryBind logic
    const { bindSticky } = await import("../src/daemon/http-server.js");

    // We simulate: stale port is occupied, DEFAULT substitute is free
    const occupiedSet = new Set([stalePort]);

    const result = await bindSticky({
      tryBind: async (port: number) => {
        if (occupiedSet.has(port)) throw makeAddrinuseError();
        // For DEFAULT_PORT substitute: use freePort to avoid touching 58451
        if (port === DEFAULT_PORT) return freePort;
        return realTryBind(port === 0 ? 0 : port);
      },
      readPidfilePort: () => stalePort,
    });

    // Should have fallen through from occupied stalePort to DEFAULT_PORT (mapped to freePort)
    expect(result).toBe(freePort);
  });
});

// ─── startHttpServer, real tryBind (module-level, closes over _server) ──────────
//
// Every test above injects tryBind, so it never exercises the production
// tryBind closure in http-server.ts — an injected test would still pass even
// if that real socket path were broken. This test drives startHttpServer with
// no SCRYBE_DAEMON_PORT set, so it takes the bindSticky path with the real
// tryBind. To keep it off DEFAULT_PORT (58451 is reserved on this machine and
// must never be touched by a test), the pidfile's stale port is set to a real
// free ephemeral port first, so the real tryBind succeeds on its very first
// attempt and never reaches DEFAULT_PORT.

describe("startHttpServer — real socket path (no injected tryBind)", () => {
  afterEach(async () => {
    const { stopHttpServer } = await import("../src/daemon/http-server.js");
    await stopHttpServer();
  });

  it("binds the stale pidfile port for real and returns a usable port", async () => {
    const freePort = await grabFreePort();

    const { writePidfile } = await import("../src/daemon/pidfile.js");
    const { config, VERSION } = await import("../src/config.js");
    writePidfile({
      pid: process.pid,
      port: freePort,
      startedAt: new Date().toISOString(),
      version: VERSION,
      dataDir: config.dataDir,
      execPath: process.execPath,
    });

    const { startHttpServer } = await import("../src/daemon/http-server.js");
    const { port } = await startHttpServer({ startedAt: new Date() });

    expect(port).toBe(freePort);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
  });
});
