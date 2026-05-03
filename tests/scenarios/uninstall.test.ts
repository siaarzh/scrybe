/**
 * Scenario 10 — `uninstall --yes` removes DATA_DIR, MCP entries, git hook blocks.
 * Direct M-D8 contract.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;
let homeDir = "";

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
  if (homeDir) {
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    homeDir = "";
  }
});

describe("Scenario 10 — uninstall --yes", () => {
  it("uninstall --dry-run shows plan without deleting DATA_DIR", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "const x = 1;\n" });
    homeDir = mkdtempSync(join(tmpdir(), "scrybe-home-"));

    // Set up a minimal project
    runScrybe(["project", "add", "--id", "u10-proj"], env, { HOME: homeDir, USERPROFILE: homeDir });
    runScrybe(["source", "add", "-P", "u10-proj", "-S", "primary",
      "--type", "code", "--root", repo.path], env, { HOME: homeDir, USERPROFILE: homeDir });
    runScrybe(["index", "-P", "u10-proj", "-S", "primary", "-f"], env, { HOME: homeDir, USERPROFILE: homeDir });

    const dataDirBefore = existsSync(env.dataDir);
    expect(dataDirBefore).toBe(true);

    const r = runScrybe(["uninstall", "--dry-run", "-y"], env, { HOME: homeDir, USERPROFILE: homeDir });
    expect(r.exit).toBe(0);
    // dry-run should mention what it would delete
    expect(r.stdout + r.stderr).toMatch(/dry.run|would/i);

    // DATA_DIR should still exist after dry-run
    expect(existsSync(env.dataDir)).toBe(true);
  });

  it("uninstall --yes deletes DATA_DIR", () => {
    env = makeScenarioEnv();
    homeDir = mkdtempSync(join(tmpdir(), "scrybe-home-"));

    // Register something so DATA_DIR has content
    runScrybe(["project", "add", "--id", "u10b-proj"], env, { HOME: homeDir, USERPROFILE: homeDir });

    expect(existsSync(env.dataDir)).toBe(true);

    const r = runScrybe(["uninstall", "-y"], env, { HOME: homeDir, USERPROFILE: homeDir });
    expect(r.exit).toBe(0);

    // DATA_DIR should be gone
    expect(existsSync(env.dataDir)).toBe(false);
  });

  it("uninstall --yes removes scrybe entry from MCP config if present", () => {
    env = makeScenarioEnv();
    homeDir = mkdtempSync(join(tmpdir(), "scrybe-home-"));

    // Write a fake .claude.json with a scrybe entry
    const claudeJson = join(homeDir, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({
      mcpServers: {
        scrybe: { command: "npx", args: ["-y", "scrybe-cli@latest", "mcp"] },
      },
    }), "utf8");

    runScrybe(["project", "add", "--id", "u10c-proj"], env, { HOME: homeDir, USERPROFILE: homeDir });

    const r = runScrybe(["uninstall", "-y"], env, { HOME: homeDir, USERPROFILE: homeDir });
    expect(r.exit).toBe(0);

    // MCP entry should be removed
    if (existsSync(claudeJson)) {
      const cfg = JSON.parse(readFileSync(claudeJson, "utf8")) as any;
      expect(cfg.mcpServers?.scrybe).toBeUndefined();
    }
    // (file may also be deleted entirely — both are valid)
  });
});
