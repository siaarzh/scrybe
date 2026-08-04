import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, delimiter } from "path";
import {
  describeDaemonMemoryCap,
  buildSystemdRunArgs,
  makeDaemonUnitName,
} from "../src/daemon/spawn-detached.js";

// The wrapper-launch check runs `systemd-run` for real, so both spawn entry
// points are stubbed for the whole file. The pure argv/probe tests below do not
// touch child_process at all.
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  const { EventEmitter } = await import("events");
  return {
    ...original,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      return child;
    }),
    spawnSync: vi.fn(() => ({ status: 0, signal: null, pid: 4242, output: [], stdout: null, stderr: null })),
  };
});

// Plan 109 Phase 3 — the daemon spawn is wrapped in a transient
// `systemd-run --user` service so the kernel refuses an over-budget allocation
// at request time, instead of the 60 s in-process RSS sampler noticing after
// the memory is already taken. Availability is probed without executing
// anything, and every unavailable path must degrade to today's plain spawn.

let binDir: string;
/** An env in which the probe should succeed. */
let goodEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "scrybe-cgroup-cap-"));
  writeFileSync(join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  goodEnv = { PATH: binDir, XDG_RUNTIME_DIR: "/run/user/1000" };
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe("describeDaemonMemoryCap", () => {
  it("reports capped with the configured limit when a user bus and systemd-run exist", () => {
    const status = describeDaemonMemoryCap({ env: goodEnv, platform: "linux", capMb: 4096 });
    expect(status.mode).toBe("capped");
    if (status.mode !== "capped") return;
    expect(status.limitMb).toBe(4096);
    expect(status.wrapper).toBe("systemd-run");
    expect(status.systemdRunPath).toBe(join(binDir, "systemd-run"));
  });

  it("accepts DBUS_SESSION_BUS_ADDRESS as the user-manager marker too", () => {
    const status = describeDaemonMemoryCap({
      env: { PATH: binDir, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      platform: "linux",
      capMb: 4096,
    });
    expect(status.mode).toBe("capped");
  });

  it("is uncapped on non-Linux platforms", () => {
    for (const platform of ["win32", "darwin"] as NodeJS.Platform[]) {
      const status = describeDaemonMemoryCap({ env: goodEnv, platform, capMb: 4096 });
      expect(status).toEqual({ mode: "uncapped", reason: "not-linux" });
    }
  });

  it("is uncapped when the cap is set to 0 (explicit kill switch)", () => {
    const status = describeDaemonMemoryCap({ env: goodEnv, platform: "linux", capMb: 0 });
    expect(status).toEqual({ mode: "uncapped", reason: "disabled-by-config" });
  });

  it("is uncapped when the cap is not a finite number", () => {
    const status = describeDaemonMemoryCap({ env: goodEnv, platform: "linux", capMb: NaN });
    expect(status).toEqual({ mode: "uncapped", reason: "disabled-by-config" });
  });

  it("is uncapped with no user bus (headless cron / container)", () => {
    const status = describeDaemonMemoryCap({
      env: { PATH: binDir },
      platform: "linux",
      capMb: 4096,
    });
    expect(status).toEqual({ mode: "uncapped", reason: "no-user-bus" });
  });

  it("is uncapped when systemd-run is not on PATH", () => {
    const status = describeDaemonMemoryCap({
      env: { PATH: "/nonexistent-a" + delimiter + "/nonexistent-b", XDG_RUNTIME_DIR: "/run/user/1000" },
      platform: "linux",
      capMb: 4096,
    });
    expect(status).toEqual({ mode: "uncapped", reason: "systemd-run-not-found" });
  });

  it("tolerates a missing PATH entirely", () => {
    const status = describeDaemonMemoryCap({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      platform: "linux",
      capMb: 4096,
    });
    expect(status).toEqual({ mode: "uncapped", reason: "systemd-run-not-found" });
  });
});

describe("makeDaemonUnitName", () => {
  it("produces a unique .service name per call", () => {
    const names = new Set(Array.from({ length: 50 }, () => makeDaemonUnitName()));
    expect(names.size).toBe(50);
    for (const n of names) expect(n).toMatch(/^scrybe-daemon-\d+-[0-9a-f]{8}\.service$/);
  });
});

describe("buildSystemdRunArgs", () => {
  const base = {
    node: "/usr/bin/node",
    script: "/opt/scrybe/dist/index.js",
    unitName: "scrybe-daemon-1-deadbeef.service",
    limitMb: 4096,
    env: { PATH: "/usr/bin", MALLOC_ARENA_MAX: "2" } as NodeJS.ProcessEnv,
  };

  it("emits a user-scoped, self-collecting transient unit with the given name", () => {
    const args = buildSystemdRunArgs(base);
    expect(args).toContain("--user");
    expect(args).toContain("--collect");
    expect(args).toContain("--unit=scrybe-daemon-1-deadbeef.service");
  });

  it("caps with MemoryMax and never MemoryHigh", () => {
    const args = buildSystemdRunArgs(base);
    expect(args).toContain("MemoryMax=4096M");
    // MemoryHigh throttles without killing; the daemon's memory is anonymous,
    // so it livelocks in D-state while still holding the lock and listener.
    expect(args.some((a) => a.includes("MemoryHigh"))).toBe(false);
  });

  it("denies swap so a runaway cannot merely spill instead of dying", () => {
    expect(buildSystemdRunArgs(base)).toContain("MemorySwapMax=0");
  });

  it("pins Restart=no — this deployment path has never auto-restarted", () => {
    expect(buildSystemdRunArgs(base)).toContain("Restart=no");
  });

  it("pins KillMode=process, or unit teardown kills the fallback replacement", () => {
    // The default KillMode=control-group SIGKILLs everything left in the
    // cgroup when the unit deactivates. A plain-spawn fallback replacement is
    // in that cgroup (detached gives a new SESSION, not a new cgroup), and the
    // parent exits immediately after spawning it — so on the exact path that
    // exists as the safety net, the host would end up with ZERO daemons.
    expect(buildSystemdRunArgs(base)).toContain("KillMode=process");
  });

  it("ends with the unchanged daemon command line", () => {
    const args = buildSystemdRunArgs(base);
    expect(args.slice(-5)).toEqual([
      "--",
      "/usr/bin/node",
      "/opt/scrybe/dist/index.js",
      "daemon",
      "start",
    ]);
  });

  it("forwards the spawn env by NAME only (a unit inherits the manager's env, not the caller's)", () => {
    // `--setenv=NAME` with no value makes systemd-run take the value from its
    // own environment and pass it over D-Bus. The forwarding stays load-bearing
    // — without it the daemon silently loses MALLOC_ARENA_MAX /
    // MALLOC_TRIM_THRESHOLD_ (ADR-0009) and every SCRYBE_* variable.
    const args = buildSystemdRunArgs(base);
    expect(args).toContain("--setenv=PATH");
    expect(args).toContain("--setenv=MALLOC_ARENA_MAX");
  });

  it("never puts an env VALUE in argv — /proc/<pid>/cmdline is world-readable", () => {
    const args = buildSystemdRunArgs({
      ...base,
      env: {
        SCRYBE_EMBEDDING_API_KEY: "sk-must-never-appear",
        OPENAI_API_KEY: "sk-also-secret",
        PATH: "/usr/bin",
      },
    });
    // The names are forwarded...
    expect(args).toContain("--setenv=SCRYBE_EMBEDDING_API_KEY");
    expect(args).toContain("--setenv=OPENAI_API_KEY");
    // ...and no --setenv argument ever carries an "=" after the name, so no
    // secret can reach cmdline or `systemctl --user show <unit>`.
    for (const arg of args.filter((a) => a.startsWith("--setenv="))) {
      expect(arg.slice("--setenv=".length)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(args.join("\0")).not.toContain("sk-must-never-appear");
    expect(args.join("\0")).not.toContain("sk-also-secret");
  });

  it("drops env vars the systemd manager owns for the unit itself", () => {
    const args = buildSystemdRunArgs({
      ...base,
      env: { INVOCATION_ID: "abc", NOTIFY_SOCKET: "/run/x", LISTEN_FDS: "3", KEEP: "1" },
    });
    expect(args).not.toContain("--setenv=INVOCATION_ID");
    expect(args).not.toContain("--setenv=NOTIFY_SOCKET");
    expect(args).not.toContain("--setenv=LISTEN_FDS");
    expect(args).toContain("--setenv=KEEP");
  });

  it("skips env entries systemd cannot carry rather than failing the spawn", () => {
    const args = buildSystemdRunArgs({
      ...base,
      env: {
        "BASH_FUNC_x%%": "() { :; }",   // invalid variable name (and the only
                                        // way a `%` could reach argv at all —
                                        // ENV_NAME_RE rejects it, so specifier
                                        // expansion is unreachable by name)
        MULTILINE: "a\nb",              // newline in value
        OK: "fine",
      },
    });
    expect(args.some((a) => a.startsWith("--setenv=BASH_FUNC"))).toBe(false);
    expect(args.some((a) => a.startsWith("--setenv=MULTILINE"))).toBe(false);
    expect(args.some((a) => a.includes("%"))).toBe(false);
    expect(args).toContain("--setenv=OK");
  });

  it("preserves the spawner's cwd but marks it non-fatal if it has been deleted", () => {
    const args = buildSystemdRunArgs({ ...base, workingDir: "/tmp/worktree" });
    expect(args).toContain("WorkingDirectory=-/tmp/worktree");
  });

  it("omits WorkingDirectory when the cwd could not be resolved", () => {
    const args = buildSystemdRunArgs({ ...base, workingDir: null });
    expect(args.some((a) => a.startsWith("WorkingDirectory"))).toBe(false);
  });
});

// ─── The wrapper-failure fallback must be SYNCHRONOUS ─────────────────────────
// Both daemon self-restart call sites (main.ts) call spawnDaemonDetached() and
// then process.exit(0) on the next line. A fallback wired to child.once("exit")
// is therefore unreachable from them: the event loop never turns. If
// systemd-run fails there and nothing else runs, the host ends up with NO
// daemon — strictly worse than the uncapped status quo. So the decision has to
// be made before spawnDaemonDetached() returns.

describe.skipIf(process.platform !== "linux")("wrapper-failure fallback (synchronous)", () => {
  const DAEMON_ARGV = ["/tmp/entry.js", "daemon", "start"];

  async function callSpawn() {
    const { spawnDaemonDetached } = await import("../src/daemon/spawn-detached.js");
    spawnDaemonDetached({
      execPath: "/usr/bin/node",
      entryScript: "/tmp/entry.js",
      env: { PATH: binDir, XDG_RUNTIME_DIR: "/run/user/1000" },
      cgroupMaxMb: 512,
    });
  }

  beforeEach(async () => {
    const { EventEmitter } = await import("events");
    const { spawn, spawnSync } = await import("child_process");
    // resetAllMocks (not clearAllMocks) so a mockReturnValue from a previous
    // test cannot leak into the next one — then re-establish the baseline impl.
    vi.mocked(spawn).mockReset();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      return child;
    });
  });

  it("runs the plain spawn before returning when systemd-run exits non-zero", async () => {
    const { spawn, spawnSync } = await import("child_process");
    // An older systemd rejecting name-only `--setenv`, an unknown property, or
    // an unreachable bus all land here: exit 1, no unit started.
    vi.mocked(spawnSync).mockReturnValue({ status: 1, signal: null, pid: 0, output: [], stdout: null, stderr: null } as any);

    await callSpawn();

    // No timers advanced, no events emitted — the fallback already happened.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]![0]).toBe("/usr/bin/node");
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(DAEMON_ARGV);
  });

  it("runs the plain spawn when systemd-run cannot be executed at all", async () => {
    const { spawn, spawnSync } = await import("child_process");
    // spawnSync surfaces ETIMEDOUT (wedged bus, systemd-run already SIGKILLed)
    // and ENOENT through `error` rather than a status code.
    vi.mocked(spawnSync).mockReturnValue({
      status: null, signal: "SIGKILL", pid: 0, output: [], stdout: null, stderr: null,
      error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
    } as any);

    await callSpawn();

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(DAEMON_ARGV);
  });

  it("does NOT double-spawn when systemd-run succeeds", async () => {
    const { spawn, spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    await callSpawn();

    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0]![0]).toBe(join(binDir, "systemd-run"));
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("hides the console window and bounds the wait on the systemd-run call", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    await callSpawn();

    const opts = vi.mocked(spawnSync).mock.calls[0]![2] as any;
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it("kills a hung systemd-run with SIGKILL, so `timeout` is a real bound", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    await callSpawn();

    // Node's default killSignal is SIGTERM, which a D-Bus client blocked in
    // connect() can sit on indefinitely — making the documented ceiling a
    // suggestion rather than a bound.
    expect((vi.mocked(spawnSync).mock.calls[0]![2] as any).killSignal).toBe("SIGKILL");
  });

  it("caps the systemd-run wait at a fraction of the caller's remaining budget", async () => {
    const { spawnDaemonDetached } = await import("../src/daemon/spawn-detached.js");
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    spawnDaemonDetached({
      execPath: "/usr/bin/node",
      entryScript: "/tmp/entry.js",
      env: { PATH: binDir, XDG_RUNTIME_DIR: "/run/user/1000" },
      cgroupMaxMb: 512,
      budgetMs: 5000,
    });

    // The MCP shim's budget. A flat 10 s wrapper inside it overran the caller
    // twice over and left the health wait with an expired deadline.
    expect((vi.mocked(spawnSync).mock.calls[0]![2] as any).timeout).toBe(1500);
  });

  it("uses the full stuck-bus ceiling when no caller is waiting", async () => {
    const { spawnSync } = await import("child_process");
    const { SYSTEMD_RUN_TIMEOUT_MS } = await import("../src/daemon/spawn-detached.js");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    // No budgetMs — the daemon's own restart sites, which exit immediately after.
    await callSpawn();

    expect((vi.mocked(spawnSync).mock.calls[0]![2] as any).timeout).toBe(SYSTEMD_RUN_TIMEOUT_MS);
  });
});

// ─── The wrapper must not eat the caller's budget ─────────────────────────────

describe("resolveWrapperTimeoutMs", () => {
  it("gives the full stuck-bus ceiling when no budget is supplied", async () => {
    const { resolveWrapperTimeoutMs, SYSTEMD_RUN_TIMEOUT_MS } =
      await import("../src/daemon/spawn-detached.js");
    expect(resolveWrapperTimeoutMs(undefined)).toBe(SYSTEMD_RUN_TIMEOUT_MS);
    expect(resolveWrapperTimeoutMs(NaN)).toBe(SYSTEMD_RUN_TIMEOUT_MS);
  });

  it("leaves the majority of every real caller's budget to the health wait", async () => {
    const { resolveWrapperTimeoutMs } = await import("../src/daemon/spawn-detached.js");
    // The three budgets actually in the tree: ensureRunning's default, the MCP
    // shim's per-RPC retry, and DAEMON_COLD_START_WAIT_MS.
    for (const budget of [3000, 5000, 15000]) {
      const t = resolveWrapperTimeoutMs(budget);
      expect(t).toBeLessThan(budget / 2);
      // ...and still enormous next to a measured 24-44 ms round-trip.
      expect(t).toBeGreaterThanOrEqual(900);
    }
  });

  it("never exceeds the stuck-bus ceiling for an enormous budget", async () => {
    const { resolveWrapperTimeoutMs, SYSTEMD_RUN_TIMEOUT_MS } =
      await import("../src/daemon/spawn-detached.js");
    expect(resolveWrapperTimeoutMs(10 * 60_000)).toBe(SYSTEMD_RUN_TIMEOUT_MS);
  });

  it("keeps a floor so a tiny budget loses the cap only, never unboundedly", async () => {
    const { resolveWrapperTimeoutMs } = await import("../src/daemon/spawn-detached.js");
    // Below the floor we deliberately overshoot rather than drop the memory cap
    // on every spawn — but the overshoot is bounded by the floor itself, not by
    // the 10 s ceiling.
    expect(resolveWrapperTimeoutMs(0)).toBe(250);
    expect(resolveWrapperTimeoutMs(100)).toBe(250);
  });
});

// ─── The async twin: same decisions, without freezing the caller's event loop ──
// `ensureRunning()` runs inside the MCP shim with other RPCs in flight. A
// blocking wrapper attempt there stalls all of them; only the daemon's own
// exiting restart sites need the synchronous form.

describe.skipIf(process.platform !== "linux")("spawnDaemonDetachedAsync", () => {
  const DAEMON_ARGV = ["/tmp/entry.js", "daemon", "start"];
  const SYSTEMD_RUN = () => join(binDir, "systemd-run");

  /**
   * Mocks `spawn` so the systemd-run child settles with `code`, while the
   * plain-spawn daemon child behaves like the real one (never exits).
   */
  async function mockSpawn(code: number | null, signal: NodeJS.Signals | null = null) {
    const { EventEmitter } = await import("events");
    const { spawn } = await import("child_process");
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(((cmd: string) => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      child.kill = vi.fn();
      if (cmd === SYSTEMD_RUN()) {
        setImmediate(() => child.emit("exit", code, signal));
      }
      return child;
    }) as any);
    return vi.mocked(spawn);
  }

  async function callAsync(budgetMs?: number) {
    const { spawnDaemonDetachedAsync } = await import("../src/daemon/spawn-detached.js");
    await spawnDaemonDetachedAsync({
      execPath: "/usr/bin/node",
      entryScript: "/tmp/entry.js",
      env: { PATH: binDir, XDG_RUNTIME_DIR: "/run/user/1000" },
      cgroupMaxMb: 512,
      ...(budgetMs === undefined ? {} : { budgetMs }),
    });
  }

  it("never blocks on spawnSync — the shim's other RPCs must keep running", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReset();
    await mockSpawn(0);

    await callAsync(5000);

    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("wraps in the transient unit and does not double-spawn on success", async () => {
    const spawnMock = await mockSpawn(0);

    await callAsync(5000);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe(SYSTEMD_RUN());
    expect(spawnMock.mock.calls[0]![1]).toContain("KillMode=process");
  });

  it("falls back to the plain spawn when systemd-run exits non-zero", async () => {
    const spawnMock = await mockSpawn(1);

    await callAsync(5000);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]![0]).toBe("/usr/bin/node");
    expect(spawnMock.mock.calls[1]![1]).toEqual(DAEMON_ARGV);
  });

  it("falls back when systemd-run cannot be executed at all", async () => {
    const { EventEmitter } = await import("events");
    const { spawn } = await import("child_process");
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(((cmd: string) => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      child.kill = vi.fn();
      if (cmd === SYSTEMD_RUN()) {
        setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      }
      return child;
    }) as any);

    await callAsync(5000);

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(DAEMON_ARGV);
  });

  it("gives up on a wedged bus within the budgeted slice and still starts a daemon", async () => {
    const { EventEmitter } = await import("events");
    const { spawn } = await import("child_process");
    vi.mocked(spawn).mockReset();
    // systemd-run that never exits — the wedged-bus shape. Nothing here emits,
    // so only the timeout can resolve the attempt.
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      child.kill = vi.fn();
      return child;
    }) as any);

    const started = Date.now();
    await callAsync(1000);   // → a 300 ms wrapper slice
    const elapsed = Date.now() - started;

    // The daemon exists despite the wedge...
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(DAEMON_ARGV);
    // ...and the caller kept most of its 1000 ms for the health wait, instead
    // of the pre-fix flat 10 s that expired the deadline before the first probe.
    expect(elapsed).toBeLessThan(700);
  });

  it("hides the console window on both the wrapper and the fallback", async () => {
    const spawnMock = await mockSpawn(1);

    await callAsync(5000);

    for (const call of spawnMock.mock.calls) {
      expect((call[2] as any).windowsHide).toBe(true);
    }
  });
});
