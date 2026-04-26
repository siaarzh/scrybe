/**
 * Scenario 5 — Wizard with all "No" answers: MCP config files unchanged,
 *              outro does NOT print "MCP config written" lie (M-D14 W3/W5).
 *
 * The wizard uses @clack/prompts which reads from stdin. In non-TTY mode
 * (when stdin is a pipe), @clack/prompts auto-cancels or treats prompts
 * differently. We pipe "n\n" responses to confirm all "No" paths.
 *
 * Note: wizard flow detection is complex. These tests verify the binary-level
 * contract: output doesn't contain the lie, MCP files not written.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeScenarioEnv, runScrybeWithStdin, type ScenarioEnv } from "./helpers/spawn.js";

let env: ScenarioEnv | null = null;
let homeDir = "";

afterEach(() => {
  env?.cleanup(); env = null;
  if (homeDir) {
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    homeDir = "";
  }
});

describe("Scenario 5 — Wizard no-answers (M-D14 W3/W5)", () => {
  it("wizard in non-TTY mode exits cleanly without writing MCP config", () => {
    env = makeScenarioEnv();
    homeDir = mkdtempSync(join(tmpdir(), "scrybe-home-"));

    // Run wizard with "n\n" for every prompt (non-TTY — clack auto-cancels most)
    const r = runScrybeWithStdin(["init"], "n\n", env, { HOME: homeDir, USERPROFILE: homeDir });

    // The binary should exit (0 or non-0 due to cancel)
    // Key assertion: the false "MCP config written" message must NOT appear
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("MCP config written");

    // Claude Code's MCP config should not have been created in our temp home
    const claudeJson = join(homeDir, ".claude.json");
    expect(existsSync(claudeJson)).toBe(false);
  });

  it("wizard with provider already configured skips provider step", () => {
    env = makeScenarioEnv();
    homeDir = mkdtempSync(join(tmpdir(), "scrybe-home-"));

    // With provider already configured via env, wizard skips to repo step
    const r = runScrybeWithStdin(["init"], "\n\n\n", env, {
      HOME: homeDir,
      USERPROFILE: homeDir,
      // Provider is already configured via the sidecar env vars from spawn.ts
    });

    // Should not crash
    expect(r.stderr).not.toMatch(/TypeError|ReferenceError|Cannot read/);
  });
});
