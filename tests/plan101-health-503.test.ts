/**
 * Plan 101 Phase 2 — /health non-2xx unit test.
 *
 * Verifies the HTTP branching added at http-server.ts's /health handler:
 *   - isDegraded() true  → 503 { ready: false, reason: "build-missing", ... }
 *   - isDegraded() false → unchanged 200 { ready: true, ... }
 *
 * `../src/daemon/build-integrity.js` is mocked so this test controls the
 * signal directly, independent of any real build-integrity timing. The HTTP
 * server binds an ephemeral port (SCRYBE_DAEMON_PORT=0) — no real sockets or
 * the shared daemon's port are touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../src/daemon/build-integrity.js", () => ({
  isDegraded: vi.fn(() => false),
  checkOnce: vi.fn(() => true),
  startBuildIntegrityCheck: vi.fn(() => () => {}),
}));

// ─── Setup ──────────────────────────────────────────────────────────────

const originalPortEnv = process.env["SCRYBE_DAEMON_PORT"];

beforeEach(() => {
  process.env["SCRYBE_DAEMON_PORT"] = "0"; // ephemeral — never touches the real daemon's port
});

afterEach(async () => {
  const { stopHttpServer } = await import("../src/daemon/http-server.js");
  await stopHttpServer();
  if (originalPortEnv === undefined) delete process.env["SCRYBE_DAEMON_PORT"];
  else process.env["SCRYBE_DAEMON_PORT"] = originalPortEnv;
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe("GET /health — build-integrity branching (D2)", () => {
  it("returns 200 {ready:true} when isDegraded() is false", async () => {
    const { isDegraded } = await import("../src/daemon/build-integrity.js");
    vi.mocked(isDegraded).mockReturnValue(false);

    const { startHttpServer } = await import("../src/daemon/http-server.js");
    const { port } = await startHttpServer({ startedAt: new Date() });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(body.ready).toBe(true);
  });

  it("returns 503 {ready:false, reason:'build-missing'} when isDegraded() is true", async () => {
    const { isDegraded } = await import("../src/daemon/build-integrity.js");
    vi.mocked(isDegraded).mockReturnValue(true);

    const { startHttpServer } = await import("../src/daemon/http-server.js");
    const { port } = await startHttpServer({ startedAt: new Date() });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(res.ok).toBe(false); // this is the signal pidfile.ts:61 maps to "refused"
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("build-missing");
  });
});
