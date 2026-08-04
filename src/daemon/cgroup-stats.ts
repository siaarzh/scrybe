/**
 * Reads cgroup v2 memory counters — for this process (the daemon's own startup
 * self-report) or for another pid (the doctor's report on a running daemon).
 * Plan 109 Phase 4.
 *
 * The spawn-time cap (`spawn-detached.ts`) engages a kernel-enforced
 * `MemoryMax` via a transient `systemd-run --user` unit, but a cap that never
 * logs whether it actually engaged is not verifiably different from no cap at
 * all. This module is the read side: given the daemon believes itself capped,
 * confirm it by reading `memory.max` / `memory.current` / `memory.events`
 * (the last carries the `oom_kill` counter — proof the cap has fired, not
 * just that it is configured).
 *
 * Every read here is defensive by construction: `/proc/self/cgroup` and
 * `/sys/fs/cgroup/**` do not exist on non-Linux, may be absent under cgroup
 * v1 (no unified `0::` line), and may be unreadable under odd container
 * setups. None of that may ever throw past this module — a daemon must never
 * fail to start because a diagnostic counter could not be read.
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface CgroupMemoryStats {
  /** The cgroup v2 path this process belongs to, e.g. "/user.slice/.../scrybe-daemon-1234-abcd.service". */
  cgroupPath: string;
  /** Raw contents of memory.max — a byte count, or the literal string "max" (unlimited). */
  memoryMax: string | null;
  /** Raw contents of memory.current, in bytes. */
  memoryCurrent: number | null;
  /** Parsed counters from memory.events. */
  events: {
    high?: number;
    max?: number;
    oomKill?: number;
  };
}

/**
 * Resolves a cgroup v2 path out of any `/proc/<pid>/cgroup`-shaped file.
 *
 * Cgroup v2 (unified hierarchy) reports a single line prefixed `0::`. A
 * cgroup v1 host instead reports several `N:<controllers>:<path>` lines and
 * no `0::` line — that host cannot be read by this module, and this
 * correctly returns null rather than guessing at a v1 path.
 */
export function resolveCgroupPathFromProcFile(procCgroupPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(procCgroupPath, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    if (line.startsWith("0::")) {
      const path = line.slice("0::".length).trim();
      return path.length > 0 ? path : null;
    }
  }
  return null;
}

/** Resolves this process's own cgroup v2 path. */
export function resolveOwnCgroupPath(procSelfCgroupPath = "/proc/self/cgroup"): string | null {
  return resolveCgroupPathFromProcFile(procSelfCgroupPath);
}

/**
 * Resolves ANOTHER process's cgroup v2 path — the doctor path, which must
 * report on the *running daemon* rather than on itself. A pid that has exited,
 * or that belongs to another user under `hidepid=2`, simply yields null.
 */
export function resolveCgroupPathForPid(pid: number, procRoot = "/proc"): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return resolveCgroupPathFromProcFile(join(procRoot, String(pid), "cgroup"));
}

function readCgroupFile(cgroupFsRoot: string, cgroupPath: string, file: string): string | null {
  try {
    return readFileSync(join(cgroupFsRoot, cgroupPath, file), "utf8");
  } catch {
    return null;
  }
}

function parseMemoryEvents(raw: string): CgroupMemoryStats["events"] {
  const events: CgroupMemoryStats["events"] = {};
  for (const line of raw.split("\n")) {
    const [key, rawValue] = line.trim().split(/\s+/, 2);
    if (!key || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key === "high") events.high = value;
    else if (key === "max") events.max = value;
    else if (key === "oom_kill") events.oomKill = value;
  }
  return events;
}

/**
 * Reads this process's cgroup v2 memory counters. Returns null on anything
 * short of a full, sensible read — non-Linux, no cgroup v2, or every counter
 * file unreadable. Never throws.
 */
export function readCgroupMemoryStats(opts?: {
  platform?: NodeJS.Platform;
  cgroupPath?: string;
  cgroupFsRoot?: string;
  /** Test-only override for the /proc/self/cgroup path resolveOwnCgroupPath reads. */
  procSelfCgroupPath?: string;
}): CgroupMemoryStats | null {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "linux") return null;

  const cgroupPath = opts?.cgroupPath ?? resolveOwnCgroupPath(opts?.procSelfCgroupPath);
  if (cgroupPath === null) return null;

  const cgroupFsRoot = opts?.cgroupFsRoot ?? "/sys/fs/cgroup";

  const memoryMaxRaw = readCgroupFile(cgroupFsRoot, cgroupPath, "memory.max");
  const memoryCurrentRaw = readCgroupFile(cgroupFsRoot, cgroupPath, "memory.current");
  const memoryEventsRaw = readCgroupFile(cgroupFsRoot, cgroupPath, "memory.events");

  // All three unreadable — not worth reporting a stats record with nothing in it.
  if (memoryMaxRaw === null && memoryCurrentRaw === null && memoryEventsRaw === null) return null;

  const memoryCurrent = memoryCurrentRaw !== null ? Number(memoryCurrentRaw.trim()) : null;

  return {
    cgroupPath,
    memoryMax: memoryMaxRaw !== null ? memoryMaxRaw.trim() : null,
    memoryCurrent: memoryCurrent !== null && Number.isFinite(memoryCurrent) ? memoryCurrent : null,
    events: memoryEventsRaw !== null ? parseMemoryEvents(memoryEventsRaw) : {},
  };
}

/**
 * What the kernel ACTUALLY enforces on a given process right now.
 *
 * Distinct from `describeDaemonMemoryCap()` in spawn-detached.ts, which answers
 * the different question "would the NEXT spawn be capped". Doctor must never
 * print the prediction where an observation belongs, so the two live in
 * separate functions with separate result types.
 *
 * `unknown` is a first-class outcome and is never collapsed into "uncapped":
 * a `hidepid=2` /proc, a cgroup v1 host, or a permission error tells us
 * nothing about the limit, and claiming either answer there would be a lie.
 *
 * `limitingLevel` / `limitingPath` name WHICH cgroup in the ancestor chain
 * supplies the effective (minimum) limit — the leaf (this process's own unit)
 * or an ancestor (e.g. `user.slice`, `user@1000.service`, a container's outer
 * cgroup). The remedy differs: a leaf cap is scrybe's own doing and can be
 * changed via `SCRYBE_DAEMON_CGROUP_MAX_MB` / reinstall; an ancestor cap
 * belongs to the operator's systemd/container setup and is not scrybe's to
 * change.
 */
export type CgroupMemoryLimit =
  | {
      state: "limited";
      limitBytes: number;
      cgroupPath: string;
      limitingLevel: "leaf" | "ancestor";
      limitingPath: string;
    }
  | { state: "unlimited"; cgroupPath: string }
  | { state: "unknown"; reason: CgroupMemoryLimitUnknownReason };

export type CgroupMemoryLimitUnknownReason =
  | "not-linux"
  | "no-cgroup-v2"
  | "memory-max-unreadable"
  | "memory-max-unparseable";

interface CgroupLevelRead {
  /** cgroup path of this level (never the true "/sys/fs/cgroup" mount root — see below). */
  path: string;
  /** memory.max content, trimmed; null if the file is missing/unreadable. */
  raw: string | null;
}

/**
 * Reads `memory.max` at the pid's own cgroup and every ancestor above it, up
 * to (but excluding) the true cgroup v2 mount root.
 *
 * The mount root itself is excluded deliberately: cgroup v2's root cgroup
 * does not carry a `memory.max` file at all (the memory controller is never
 * "enabled" against the root — there is nothing above it to account
 * against), so treating its absence as a read failure would make a
 * completely ordinary host report "unknown" instead of "unlimited". Every
 * level between the leaf and the root (`user.slice`, `user-1000.slice`,
 * `user@1000.service`, `app.slice`, a container's outer cgroup, …) is a real
 * cgroup and DOES carry the file whenever cgroup v2 delegates the memory
 * controller down to it.
 */
function readCgroupAncestorChain(cgroupFsRoot: string, cgroupPath: string): CgroupLevelRead[] {
  const segments = cgroupPath.split("/").filter((s) => s.length > 0);
  const levels: CgroupLevelRead[] = [];
  for (let i = segments.length; i >= 1; i--) {
    const path = "/" + segments.slice(0, i).join("/");
    const raw = readCgroupFile(cgroupFsRoot, path, "memory.max");
    levels.push({ path, raw: raw !== null ? raw.trim() : null });
  }
  return levels;
}

/**
 * Reads `memory.max` for `pid`'s cgroup v2 group AND every ancestor above it,
 * and reports the MINIMUM — cgroup v2 enforces the tightest limit anywhere in
 * the chain, so a leaf that reads "max" can still be capped by a
 * `user.slice`/`user@.service`/container cgroup above it. Never throws: every
 * failure mode degrades to `{ state: "unknown", reason }`.
 *
 * The leaf read is load-bearing and hard-blocking, matching the pre-ancestor-
 * walk contract exactly: if the leaf itself is unreadable or unparseable,
 * that is reported as `unknown` regardless of what the ancestors say (we
 * cannot even confirm the pid's own cgroup, so nothing else is trustworthy
 * either).
 *
 * Ancestor reads are best-effort ENRICHMENT, not equally hard-blocking: a
 * genuinely unlimited leaf plus an unreadable (rather than a definitively
 * "max") ancestor still reports `unlimited`. In practice every ancestor
 * segment on a resolved path is a real, existing cgroup directory (cgroupfs
 * requires parents to exist for a child to exist), so an unreadable ancestor
 * almost always means the memory controller simply is not delegated there
 * (no file at all) rather than a hidden cap we failed to see — treating that
 * as blocking "unknown" would make the common case (no ancestor containment)
 * unreportable. A definitively lower NUMERIC ancestor limit, when readable,
 * always wins over a "max" leaf.
 */
export function readCgroupMemoryLimitForPid(pid: number, opts?: {
  platform?: NodeJS.Platform;
  procRoot?: string;
  cgroupFsRoot?: string;
}): CgroupMemoryLimit {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "linux") return { state: "unknown", reason: "not-linux" };

  const cgroupPath = resolveCgroupPathForPid(pid, opts?.procRoot ?? "/proc");
  if (cgroupPath === null) return { state: "unknown", reason: "no-cgroup-v2" };

  const cgroupFsRoot = opts?.cgroupFsRoot ?? "/sys/fs/cgroup";
  const levels = readCgroupAncestorChain(cgroupFsRoot, cgroupPath);

  // Leaf is always levels[0] (readCgroupAncestorChain walks leaf-first).
  const leaf = levels[0]!;
  if (leaf.raw === null) return { state: "unknown", reason: "memory-max-unreadable" };
  if (leaf.raw !== "max") {
    const leafBytes = Number(leaf.raw);
    if (!Number.isFinite(leafBytes) || leafBytes <= 0) {
      return { state: "unknown", reason: "memory-max-unparseable" };
    }
  }

  // Leaf is confirmed readable (either "max" or a valid number). Now fold in
  // every ancestor that gave us a definitive numeric limit — unreadable or
  // "max" ancestors contribute nothing and are silently skipped (see the
  // best-effort rationale above).
  let minBytes: number | null = leaf.raw === "max" ? null : Number(leaf.raw);
  let minLevel: CgroupLevelRead | null = leaf.raw === "max" ? null : leaf;

  for (const level of levels.slice(1)) {
    if (level.raw === null || level.raw === "max") continue;
    const bytes = Number(level.raw);
    if (!Number.isFinite(bytes) || bytes <= 0) continue; // garbled ancestor value — ignore, not blocking
    if (minBytes === null || bytes < minBytes) {
      minBytes = bytes;
      minLevel = level;
    }
  }

  if (minBytes !== null && minLevel !== null) {
    return {
      state: "limited",
      limitBytes: minBytes,
      cgroupPath,
      limitingLevel: minLevel.path === cgroupPath ? "leaf" : "ancestor",
      limitingPath: minLevel.path,
    };
  }

  return { state: "unlimited", cgroupPath };
}
