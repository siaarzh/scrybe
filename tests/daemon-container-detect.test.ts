import { describe, it, expect, vi, afterEach } from "vitest";

// isContainer() reads the filesystem and env — we inject both via vi.mock + env stubs

describe("isContainer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["WSL_DISTRO_NAME"];
  });

  it("returns false on a plain host (no /.dockerenv, no cgroup hit, no WSL)", async () => {
    vi.doMock("fs", () => {
      const actual = vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: (p: string) => p !== "/.dockerenv" && (actual as any).existsSync(p) };
    });
    const { isContainer } = await import("../src/daemon/container-detect.js");
    expect(isContainer()).toBe(false);
    vi.resetModules();
  });

  it("returns true when /.dockerenv exists", async () => {
    vi.doMock("fs", () => {
      const actual = vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => p === "/.dockerenv" ? true : (actual as any).existsSync(p),
      };
    });
    const { isContainer } = await import("../src/daemon/container-detect.js");
    expect(isContainer()).toBe(true);
    vi.resetModules();
  });

  it("returns true when WSL_DISTRO_NAME is set", async () => {
    process.env["WSL_DISTRO_NAME"] = "Ubuntu-22.04";
    vi.doMock("fs", () => {
      const actual = vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: () => false };
    });
    const { isContainer } = await import("../src/daemon/container-detect.js");
    expect(isContainer()).toBe(true);
    vi.resetModules();
  });
});
