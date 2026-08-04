import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveOwnCgroupPath,
  resolveCgroupPathForPid,
  readCgroupMemoryStats,
  readCgroupMemoryLimitForPid,
} from "../src/daemon/cgroup-stats.js";

// Plan 109 Phase 4 — confirms the spawn-time cgroup cap (spawn-detached.ts)
// actually engaged, by reading this process's own cgroup v2 memory counters.
// Every read must be defensive: cgroup v1 hosts, non-Linux hosts, and
// unreadable/missing counter files must all degrade to null, never throw.

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "scrybe-cgroup-stats-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveOwnCgroupPath", () => {
  it("parses the 0:: line from a cgroup v2 /proc/self/cgroup", () => {
    const procFile = join(root, "cgroup-v2");
    writeFileSync(procFile, "0::/user.slice/user-1000.slice/scrybe-daemon-1234.service\n");
    expect(resolveOwnCgroupPath(procFile)).toBe("/user.slice/user-1000.slice/scrybe-daemon-1234.service");
  });

  it("returns null for a cgroup v1 host (no 0:: line)", () => {
    const procFile = join(root, "cgroup-v1");
    writeFileSync(procFile, "12:memory:/user.slice\n11:pids:/user.slice\n");
    expect(resolveOwnCgroupPath(procFile)).toBeNull();
  });

  it("returns null when /proc/self/cgroup does not exist", () => {
    expect(resolveOwnCgroupPath(join(root, "does-not-exist"))).toBeNull();
  });

  it("returns null when the 0:: line has an empty path", () => {
    const procFile = join(root, "cgroup-empty");
    writeFileSync(procFile, "0::\n");
    expect(resolveOwnCgroupPath(procFile)).toBeNull();
  });
});

describe("readCgroupMemoryStats", () => {
  it("returns null on non-Linux platforms without touching the filesystem", () => {
    expect(readCgroupMemoryStats({ platform: "darwin" })).toBeNull();
    expect(readCgroupMemoryStats({ platform: "win32" })).toBeNull();
  });

  it("reads memory.max / memory.current / memory.events for a resolvable cgroup path", () => {
    const fsRoot = join(root, "sys-fs-cgroup-ok");
    const cgroupPath = "/user.slice/scrybe-daemon-1.service";
    mkdirSync(join(fsRoot, cgroupPath), { recursive: true });
    writeFileSync(join(fsRoot, cgroupPath, "memory.max"), "4294967296\n");
    writeFileSync(join(fsRoot, cgroupPath, "memory.current"), "104857600\n");
    writeFileSync(join(fsRoot, cgroupPath, "memory.events"),
      "low 0\nhigh 3\nmax 1\noom 0\noom_kill 1\noom_group_kill 0\n");

    const stats = readCgroupMemoryStats({ platform: "linux", cgroupPath, cgroupFsRoot: fsRoot });
    expect(stats).not.toBeNull();
    expect(stats!.cgroupPath).toBe(cgroupPath);
    expect(stats!.memoryMax).toBe("4294967296");
    expect(stats!.memoryCurrent).toBe(104857600);
    expect(stats!.events).toEqual({ high: 3, max: 1, oomKill: 1 });
  });

  it("passes through the literal 'max' (unlimited) memory.max value", () => {
    const fsRoot = join(root, "sys-fs-cgroup-unlimited");
    const cgroupPath = "/user.slice/scrybe-daemon-2.service";
    mkdirSync(join(fsRoot, cgroupPath), { recursive: true });
    writeFileSync(join(fsRoot, cgroupPath, "memory.max"), "max\n");
    writeFileSync(join(fsRoot, cgroupPath, "memory.current"), "1000\n");
    writeFileSync(join(fsRoot, cgroupPath, "memory.events"), "high 0\nmax 0\noom_kill 0\n");

    const stats = readCgroupMemoryStats({ platform: "linux", cgroupPath, cgroupFsRoot: fsRoot });
    expect(stats!.memoryMax).toBe("max");
  });

  it("returns null when the cgroup path cannot be resolved at all (cgroup v1 host)", () => {
    const procFile = join(root, "cgroup-v1-for-stats");
    writeFileSync(procFile, "12:memory:/user.slice\n");
    const stats = readCgroupMemoryStats({
      platform: "linux",
      procSelfCgroupPath: procFile,
      cgroupFsRoot: join(root, "sys-fs-cgroup-unused"),
    });
    expect(stats).toBeNull();
  });

  it("returns null when every counter file is unreadable (path resolves but nothing under it)", () => {
    const fsRoot = join(root, "sys-fs-cgroup-empty");
    const cgroupPath = "/user.slice/scrybe-daemon-3.service";
    // Intentionally do not create the directory — every read fails.
    const stats = readCgroupMemoryStats({ platform: "linux", cgroupPath, cgroupFsRoot: fsRoot });
    expect(stats).toBeNull();
  });

  it("tolerates a partially-readable cgroup (e.g. memory.events missing)", () => {
    const fsRoot = join(root, "sys-fs-cgroup-partial");
    const cgroupPath = "/user.slice/scrybe-daemon-4.service";
    mkdirSync(join(fsRoot, cgroupPath), { recursive: true });
    writeFileSync(join(fsRoot, cgroupPath, "memory.max"), "1000000\n");
    // memory.current and memory.events deliberately absent.

    const stats = readCgroupMemoryStats({ platform: "linux", cgroupPath, cgroupFsRoot: fsRoot });
    expect(stats).not.toBeNull();
    expect(stats!.memoryMax).toBe("1000000");
    expect(stats!.memoryCurrent).toBeNull();
    expect(stats!.events).toEqual({});
  });
});

// ─── Reading ANOTHER process's limit — the doctor path ────────────────────────
// `scrybe doctor` must report what is TRUE of the running daemon, not what
// would happen if it spawned one now. That means reading the daemon pid's own
// cgroup memory.max. Everything unreadable is an honest "unknown" and must
// never be rendered as "capped" (which would claim protection that isn't
// there) nor as "unlimited" (which would cry wolf).

describe("resolveCgroupPathForPid", () => {
  it("reads /proc/<pid>/cgroup for the given pid", () => {
    const procRoot = join(root, "proc-a");
    mkdirSync(join(procRoot, "4242"), { recursive: true });
    writeFileSync(join(procRoot, "4242", "cgroup"),
      "1:net_cls:/\n0::/user.slice/user-1000.slice/scrybe-daemon-4242.service\n");
    expect(resolveCgroupPathForPid(4242, procRoot))
      .toBe("/user.slice/user-1000.slice/scrybe-daemon-4242.service");
  });

  it("returns null for a pid with no /proc entry (exited, or hidepid)", () => {
    expect(resolveCgroupPathForPid(4243, join(root, "proc-a"))).toBeNull();
  });

  it("rejects a non-positive / non-integer pid instead of touching /proc", () => {
    expect(resolveCgroupPathForPid(0, join(root, "proc-a"))).toBeNull();
    expect(resolveCgroupPathForPid(-1, join(root, "proc-a"))).toBeNull();
    expect(resolveCgroupPathForPid(1.5, join(root, "proc-a"))).toBeNull();
  });
});

describe("readCgroupMemoryLimitForPid", () => {
  function fixture(name: string, memoryMax: string | null): { procRoot: string; cgroupFsRoot: string } {
    const procRoot = join(root, `proc-${name}`);
    const cgroupFsRoot = join(root, `cgfs-${name}`);
    const cgroupPath = `/user.slice/scrybe-daemon-${name}.service`;
    mkdirSync(join(procRoot, "555"), { recursive: true });
    writeFileSync(join(procRoot, "555", "cgroup"), `0::${cgroupPath}\n`);
    if (memoryMax !== null) {
      mkdirSync(join(cgroupFsRoot, cgroupPath), { recursive: true });
      writeFileSync(join(cgroupFsRoot, cgroupPath, "memory.max"), memoryMax);
    }
    return { procRoot, cgroupFsRoot };
  }

  it("reports the real limit in bytes for a capped process, attributed to the leaf", () => {
    const { procRoot, cgroupFsRoot } = fixture("capped", "4294967296\n");
    const limit = readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot });
    expect(limit).toEqual({
      state: "limited",
      limitBytes: 4294967296,
      cgroupPath: "/user.slice/scrybe-daemon-capped.service",
      limitingLevel: "leaf",
      limitingPath: "/user.slice/scrybe-daemon-capped.service",
    });
  });

  it("reports 'unlimited' for the literal max — an uncapped always-on daemon", () => {
    const { procRoot, cgroupFsRoot } = fixture("unlimited", "max\n");
    const limit = readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot });
    expect(limit.state).toBe("unlimited");
  });

  // ── Ancestor chain (MAJOR: leaf-only read reported an ancestor-capped
  // daemon as uncapped) ──────────────────────────────────────────────────
  // cgroup v2 enforces the MINIMUM limit across the whole ancestor chain, so
  // a leaf reading "max" can still be genuinely capped by a parent slice
  // (user.slice / user@.service) or a container's outer cgroup.

  function ancestorFixture(
    name: string,
    leafMax: string | null,
    ancestorMax: string | null
  ): { procRoot: string; cgroupFsRoot: string; leafPath: string; ancestorPath: string } {
    const procRoot = join(root, `proc-anc-${name}`);
    const cgroupFsRoot = join(root, `cgfs-anc-${name}`);
    const ancestorPath = "/user.slice";
    const leafPath = `/user.slice/scrybe-daemon-${name}.service`;
    mkdirSync(join(procRoot, "555"), { recursive: true });
    writeFileSync(join(procRoot, "555", "cgroup"), `0::${leafPath}\n`);
    if (ancestorMax !== null) {
      mkdirSync(join(cgroupFsRoot, ancestorPath), { recursive: true });
      writeFileSync(join(cgroupFsRoot, ancestorPath, "memory.max"), ancestorMax);
    }
    if (leafMax !== null) {
      mkdirSync(join(cgroupFsRoot, leafPath), { recursive: true });
      writeFileSync(join(cgroupFsRoot, leafPath, "memory.max"), leafMax);
    }
    return { procRoot, cgroupFsRoot, leafPath, ancestorPath };
  }

  it("reports the ancestor's limit when the leaf is unlimited but an ancestor slice caps it", () => {
    const { procRoot, cgroupFsRoot, leafPath, ancestorPath } =
      ancestorFixture("ancestor-capped", "max\n", "1073741824\n");
    const limit = readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot });
    expect(limit).toEqual({
      state: "limited",
      limitBytes: 1073741824,
      cgroupPath: leafPath,
      limitingLevel: "ancestor",
      limitingPath: ancestorPath,
    });
  });

  it("reports the leaf's limit when both leaf and ancestor are capped and the leaf is smaller", () => {
    const { procRoot, cgroupFsRoot, leafPath } =
      ancestorFixture("leaf-smaller", "536870912\n", "4294967296\n");
    const limit = readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot });
    expect(limit).toEqual({
      state: "limited",
      limitBytes: 536870912,
      cgroupPath: leafPath,
      limitingLevel: "leaf",
      limitingPath: leafPath,
    });
  });

  it("reports the ancestor's limit when both are capped and the ancestor is smaller (the ancestor wins — cgroup v2 enforces the minimum)", () => {
    const { procRoot, cgroupFsRoot, leafPath, ancestorPath } =
      ancestorFixture("ancestor-smaller", "4294967296\n", "536870912\n");
    const limit = readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot });
    expect(limit).toEqual({
      state: "limited",
      limitBytes: 536870912,
      cgroupPath: leafPath,
      limitingLevel: "ancestor",
      limitingPath: ancestorPath,
    });
  });

  it("reports 'unlimited' only when every level in the chain reads max", () => {
    const { procRoot, cgroupFsRoot } = ancestorFixture("all-max", "max\n", "max\n");
    const limit = readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot });
    expect(limit.state).toBe("unlimited");
  });

  it("degrades to unknown on non-Linux without touching the filesystem", () => {
    for (const platform of ["win32", "darwin"] as NodeJS.Platform[]) {
      expect(readCgroupMemoryLimitForPid(555, { platform }))
        .toEqual({ state: "unknown", reason: "not-linux" });
    }
  });

  it("degrades to unknown when the pid's cgroup cannot be resolved (cgroup v1 / hidepid)", () => {
    const procRoot = join(root, "proc-v1");
    mkdirSync(join(procRoot, "555"), { recursive: true });
    writeFileSync(join(procRoot, "555", "cgroup"), "12:memory:/user.slice\n");
    expect(readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot: root }))
      .toEqual({ state: "unknown", reason: "no-cgroup-v2" });
  });

  it("degrades to unknown when memory.max is unreadable (permissions / no cgroupfs)", () => {
    const { procRoot, cgroupFsRoot } = fixture("noMemMax", null);
    expect(readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot }))
      .toEqual({ state: "unknown", reason: "memory-max-unreadable" });
  });

  it("degrades to unknown on a memory.max this build cannot parse", () => {
    const { procRoot, cgroupFsRoot } = fixture("garbage", "not-a-number\n");
    expect(readCgroupMemoryLimitForPid(555, { platform: "linux", procRoot, cgroupFsRoot }))
      .toEqual({ state: "unknown", reason: "memory-max-unparseable" });
  });

  it("never throws for any of these inputs", () => {
    expect(() => readCgroupMemoryLimitForPid(999999999, { platform: "linux" })).not.toThrow();
    expect(() => readCgroupMemoryLimitForPid(-1, { platform: "linux" })).not.toThrow();
  });
});
