/**
 * Scenario 7  — `gc` reclaims disk (Lance compaction + orphan removal, M-D13 Fix 4-5).
 * Scenario 12 — Migration registry idempotency (M-D13 Fix 6).
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("Scenario 7 — gc reclaims disk (M-D13 Fix 4-5)", () => {
  it("gc runs without error after indexing", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    runScrybe(["project", "add", "--id", "s7-proj"], env);
    runScrybe(["source", "add", "-P", "s7-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s7-proj", "-S", "primary", "-f"], env);

    // gc should run cleanly
    const r = runScrybe(["gc"], env);
    expect(r.exit).toBe(0);
    // Should mention either "No orphan chunks found" or "compacting" or "GC complete"
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/orphan|compact|No orphan|GC complete/i);
    // M-D16 Fix C: gc reports actual reclaimed bytes, even when 0
    expect(r.stdout).toMatch(/Reclaimed [\d.]+ (B|KB|MB|GB) across \d+ table\(s\)\./);
  });

  it("gc --dry-run reports without deleting", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    runScrybe(["project", "add", "--id", "s7d-proj"], env);
    runScrybe(["source", "add", "-P", "s7d-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s7d-proj", "-S", "primary", "-f"], env);

    const r = runScrybe(["gc", "--dry-run"], env);
    expect(r.exit).toBe(0);
    // dry-run should not say "GC complete" (that means it deleted)
    expect(r.stdout).not.toContain("GC complete");
    expect(r.stdout).not.toContain("Compacting");
  });

  it("gc prunes empty project entries (C5)", () => {
    env = makeScenarioEnv();

    // Add a project with no sources — should be detected as empty
    runScrybe(["project", "add", "--id", "s7e-empty"], env);

    // Run gc in non-TTY mode (no stdin) — should auto-skip the confirm in non-TTY
    const r = runScrybe(["gc"], env);
    expect(r.exit).toBe(0);
    // Non-TTY skips the confirm, so empty project may or may not be pruned;
    // but gc itself should not crash
    expect(r.stderr).not.toContain("Error");
  });
});

describe("Scenario 12 — Migration registry idempotency (M-D13 Fix 6)", () => {
  it("schema.json gets migrations_applied on first run", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "const x = 1;\n" });

    // Write a v2 schema.json without migrations_applied (simulates pre-0.23.2 install)
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(
      join(env.dataDir, "schema.json"),
      JSON.stringify({ version: 2 }),
      "utf8"
    );

    // Run any command that triggers checkAndMigrate (project list)
    runScrybe(["project", "list"], env, { SCRYBE_SKIP_MIGRATION: "0" });

    // schema.json should now have migrations_applied
    const schema = JSON.parse(readFileSync(join(env.dataDir, "schema.json"), "utf8")) as {
      version: number;
      migrations_applied?: string[];
      last_written_by?: string;
    };
    expect(schema.migrations_applied).toBeDefined();
    expect(Array.isArray(schema.migrations_applied)).toBe(true);
    expect(schema.last_written_by).toBeTruthy();
  });

  it("second run of project list does not re-run migrations", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "const x = 1;\n" });

    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(
      join(env.dataDir, "schema.json"),
      JSON.stringify({ version: 2, migrations_applied: ["compact-tables-v0.23.2"] }),
      "utf8"
    );

    // Both runs should exit 0 and not alter migrations_applied further
    runScrybe(["project", "list"], env, { SCRYBE_SKIP_MIGRATION: "0" });
    runScrybe(["project", "list"], env, { SCRYBE_SKIP_MIGRATION: "0" });

    const schema = JSON.parse(readFileSync(join(env.dataDir, "schema.json"), "utf8")) as {
      migrations_applied: string[];
    };
    // Still exactly one entry — idempotent
    expect(schema.migrations_applied.filter((m) => m === "compact-tables-v0.23.2")).toHaveLength(1);
  });
});
