import { describe, it, expect } from "vitest";
import { daemonSpawnEnv } from "../src/daemon/spawn-detached.js";

// Plan 85 allocator-cap slice (v0.44.1) — daemonSpawnEnv merges glibc
// arena-hoarding caps into the daemon spawn env, respecting any value the
// user has already set. See ADR-0009.

describe("daemonSpawnEnv", () => {
  it("defaults MALLOC_ARENA_MAX=2 and MALLOC_TRIM_THRESHOLD_=131072 when unset", () => {
    const base = { PATH: "/usr/bin" };
    const env = daemonSpawnEnv(base);
    expect(env.MALLOC_ARENA_MAX).toBe("2");
    expect(env.MALLOC_TRIM_THRESHOLD_).toBe("131072");
    // Untouched keys pass through
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves a user-set MALLOC_ARENA_MAX instead of overriding it", () => {
    const base = { MALLOC_ARENA_MAX: "4" };
    const env = daemonSpawnEnv(base);
    expect(env.MALLOC_ARENA_MAX).toBe("4");
    // Trim threshold still gets the default since it wasn't set
    expect(env.MALLOC_TRIM_THRESHOLD_).toBe("131072");
  });

  it("preserves a user-set MALLOC_TRIM_THRESHOLD_ instead of overriding it", () => {
    const base = { MALLOC_TRIM_THRESHOLD_: "65536" };
    const env = daemonSpawnEnv(base);
    expect(env.MALLOC_ARENA_MAX).toBe("2");
    expect(env.MALLOC_TRIM_THRESHOLD_).toBe("65536");
  });

  it("defaults to process.env when no base is passed", () => {
    const prevArena = process.env.MALLOC_ARENA_MAX;
    delete process.env.MALLOC_ARENA_MAX;
    try {
      const env = daemonSpawnEnv();
      expect(env.MALLOC_ARENA_MAX).toBe("2");
    } finally {
      if (prevArena === undefined) delete process.env.MALLOC_ARENA_MAX;
      else process.env.MALLOC_ARENA_MAX = prevArena;
    }
  });
});
