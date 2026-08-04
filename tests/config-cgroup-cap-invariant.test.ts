/**
 * The cgroup cap (SCRYBE_DAEMON_CGROUP_MAX_MB) must sit ABOVE the RSS guard's
 * hard ceiling (SCRYBE_DAEMON_MAX_RSS_HARD_MB), or every ordinary over-budget
 * excursion becomes a kernel OOM kill instead of a clean self-restart. Both
 * are independently operator-settable env vars; config.ts enforces the
 * ordering rather than merely documenting it.
 *
 * Design choice under test: WARN + auto-adjust (lift the effective cap to
 * hardCeiling + margin), never throw / refuse to start.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ALL_KEYS = [
  "SCRYBE_DAEMON_CGROUP_MAX_MB",
  "SCRYBE_DAEMON_MAX_RSS_HARD_MB",
  "SCRYBE_CODE_EMBEDDING_BASE_URL",
  "SCRYBE_CODE_EMBEDDING_API_KEY",
  "SCRYBE_CODE_EMBEDDING_MODEL",
  "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
];

let savedEnv: Record<string, string | undefined> = {};
let dataDir = "";
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-cgroup-invariant-test-"));
  savedEnv = {};
  for (const k of ALL_KEYS) savedEnv[k] = process.env[k];
  for (const k of ALL_KEYS) delete process.env[k];
  process.env["SCRYBE_DATA_DIR"] = dataDir;
  // Local WASM embedder path — avoids requiring API creds for this config-only test.
  process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
  process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test-key";
  vi.resetModules();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const k of ALL_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete process.env["SCRYBE_DATA_DIR"];
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SCRYBE_DAEMON_CGROUP_MAX_MB vs SCRYBE_DAEMON_MAX_RSS_HARD_MB ordering", () => {
  it("keeps the configured cap as-is when it sits above the (default) hard ceiling", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "4096";
    const { config } = await import("../src/config.js");
    expect(config.daemonCgroupMaxMb).toBe(4096);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("auto-adjusts and warns when the cap is at or below the hard ceiling", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "2048";
    process.env["SCRYBE_DAEMON_MAX_RSS_HARD_MB"] = "3072";
    const { config } = await import("../src/config.js");
    // Adjusted, not left as the misconfigured value, and not below the ceiling.
    expect(config.daemonCgroupMaxMb).toBeGreaterThan(3072);
    expect(stderrSpy).toHaveBeenCalled();
    const warned = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(warned).toContain("SCRYBE_DAEMON_CGROUP_MAX_MB");
    expect(warned).toContain("SCRYBE_DAEMON_MAX_RSS_HARD_MB");
  });

  it("auto-adjusts and warns when the cap exactly equals the hard ceiling", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "3072";
    process.env["SCRYBE_DAEMON_MAX_RSS_HARD_MB"] = "3072";
    const { config } = await import("../src/config.js");
    expect(config.daemonCgroupMaxMb).toBeGreaterThan(3072);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("does not throw and does not prevent config from loading on violation", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "1024";
    process.env["SCRYBE_DAEMON_MAX_RSS_HARD_MB"] = "3072";
    await expect(import("../src/config.js")).resolves.toBeDefined();
  });

  it("skips the check entirely when the cgroup cap is disabled (0)", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "0";
    process.env["SCRYBE_DAEMON_MAX_RSS_HARD_MB"] = "3072";
    const { config } = await import("../src/config.js");
    expect(config.daemonCgroupMaxMb).toBe(0);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("skips the check when the hard ceiling itself is disabled (0)", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "512";
    process.env["SCRYBE_DAEMON_MAX_RSS_HARD_MB"] = "0";
    const { config } = await import("../src/config.js");
    expect(config.daemonCgroupMaxMb).toBe(512);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("uses the default hard ceiling (3072) when SCRYBE_DAEMON_MAX_RSS_HARD_MB is unset", async () => {
    process.env["SCRYBE_DAEMON_CGROUP_MAX_MB"] = "3000";
    const { config } = await import("../src/config.js");
    expect(config.daemonCgroupMaxMb).toBeGreaterThan(3072);
    expect(stderrSpy).toHaveBeenCalled();
  });
});
