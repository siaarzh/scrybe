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
});
