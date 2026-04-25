/**
 * Unit tests for LifecycleManager using fake timers.
 * Covers the state machine: no-client-ever, serving, grace, always-on.
 *
 * Timer constants are read from env vars at LifecycleManager construction time,
 * so we can set them before `new LifecycleManager()` without module reloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleManager } from "../src/daemon/lifecycle.js";

const TIMERS = {
  SCRYBE_DAEMON_HEARTBEAT_STALE_MS:  "100",
  SCRYBE_DAEMON_IDLE_GRACE_MS:       "200",
  SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "300",
};

function setTimerEnv(): void {
  for (const [k, v] of Object.entries(TIMERS)) process.env[k] = v;
}

function clearTimerEnv(): void {
  for (const k of Object.keys(TIMERS)) delete process.env[k];
}

describe("LifecycleManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env["SCRYBE_DAEMON_KEEP_ALIVE"];
    setTimerEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_KEEP_ALIVE"];
    clearTimerEnv();
  });

  it("emits shutdown(no-client-ever) if no client registers within timeout", () => {
    const lc = new LifecycleManager();
    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    vi.advanceTimersByTime(299);
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(handler).toHaveBeenCalledWith("no-client-ever");

    lc.stop();
  });

  it("cancels no-client-ever timer when first client registers", () => {
    const lc = new LifecycleManager();
    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    vi.advanceTimersByTime(100);
    lc.registerOrUpdate({ clientId: "c1", pid: 100 });

    vi.advanceTimersByTime(300); // past no-client-ever timeout
    expect(handler).not.toHaveBeenCalled();

    lc.stop();
  });

  it("emits shutdown(grace) after grace period with no clients", () => {
    const lc = new LifecycleManager();
    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    lc.registerOrUpdate({ clientId: "c1", pid: 1 });
    lc.unregister("c1");
    expect(lc.getClientCount()).toBe(0);

    vi.advanceTimersByTime(199);
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(handler).toHaveBeenCalledWith("grace");

    lc.stop();
  });

  it("cancels grace timer when a client re-registers", () => {
    const lc = new LifecycleManager();
    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    lc.registerOrUpdate({ clientId: "c1", pid: 1 });
    lc.unregister("c1");

    vi.advanceTimersByTime(100); // halfway through grace
    lc.registerOrUpdate({ clientId: "c1", pid: 1 }); // re-register

    vi.advanceTimersByTime(300); // past grace timeout
    expect(handler).not.toHaveBeenCalled();

    lc.stop();
  });

  it("prunes stale clients and enters grace", () => {
    const lc = new LifecycleManager();
    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    lc.registerOrUpdate({ clientId: "c1", pid: 1 });
    expect(lc.getClientCount()).toBe(1);

    // Advance past the 100 ms stale threshold; prune manually
    vi.advanceTimersByTime(101);
    lc.pruneStaleClients();
    expect(lc.getClientCount()).toBe(0);

    vi.advanceTimersByTime(201); // past grace
    expect(handler).toHaveBeenCalledWith("grace");

    lc.stop();
  });

  it("does not emit shutdown when SCRYBE_DAEMON_KEEP_ALIVE=1", () => {
    process.env["SCRYBE_DAEMON_KEEP_ALIVE"] = "1";
    const lc = new LifecycleManager();
    expect(lc.isAlwaysOn()).toBe(true);

    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    vi.advanceTimersByTime(1000);
    expect(handler).not.toHaveBeenCalled();

    lc.stop();
  });

  it("gracePeriodRemainingMs returns null when not in grace", () => {
    const lc = new LifecycleManager();
    lc.start();
    expect(lc.gracePeriodRemainingMs()).toBeNull();
    lc.stop();
  });

  it("gracePeriodRemainingMs returns a non-negative number when in grace", () => {
    const lc = new LifecycleManager();
    lc.start();
    lc.registerOrUpdate({ clientId: "c1", pid: 1 });
    lc.unregister("c1");
    const rem = lc.gracePeriodRemainingMs();
    expect(rem).not.toBeNull();
    expect(rem!).toBeGreaterThanOrEqual(0);
    lc.stop();
  });

  it("multiple clients — grace only starts when ALL unregister", () => {
    const lc = new LifecycleManager();
    const handler = vi.fn();
    lc.on("shutdown", handler);
    lc.start();

    lc.registerOrUpdate({ clientId: "c1", pid: 1 });
    lc.registerOrUpdate({ clientId: "c2", pid: 2 });

    lc.unregister("c1"); // one client still active
    vi.advanceTimersByTime(300);
    expect(handler).not.toHaveBeenCalled();

    lc.unregister("c2"); // now empty → grace starts
    vi.advanceTimersByTime(201);
    expect(handler).toHaveBeenCalledWith("grace");

    lc.stop();
  });
});
