/**
 * Scenario 8 — Branch CLI contract: `--branch` flag parses correctly and
 *              search returns hits from the indexed branch.
 *
 * Note: deep branch isolation correctness (cross-branch contamination) is
 * tested at unit level in tests/branch-isolation.test.ts. This scenario
 * verifies the CLI surface: --branch is accepted, index accepts --branch,
 * and search returns results from the correct branch context.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("Scenario 8 — branch CLI contract", () => {
  it("--branch flag is accepted by index and search without error", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/shared.ts": "export const shared = 'common';\n" });

    runScrybe(["project", "add", "--id", "s8-proj"], env);
    runScrybe(["source", "add", "-P", "s8-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Index with explicit branch — must not error on unknown option
    const idx = runScrybe(["index", "-P", "s8-proj", "-S", "primary", "-f", "--branch", "master"], env);
    expect(idx.exit).toBe(0);
    expect(idx.stderr).not.toContain("unknown option");

    // Search with explicit branch
    const r = runScrybe(["search", "code", "-P", "s8-proj", "--branch", "master", "shared"], env);
    expect(r.exit).toBe(0);
    expect(r.stderr).not.toContain("unknown option");
  });

  it("index on a feature branch succeeds and search finds feature-branch content", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/shared.ts": "export const shared = 'common';\n" });

    runScrybe(["project", "add", "--id", "s8b-proj"], env);
    runScrybe(["source", "add", "-P", "s8b-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Index master
    runScrybe(["index", "-P", "s8b-proj", "-S", "primary", "-f", "--branch", "master"], env);

    // Add a feature branch with unique content
    repo.branch("feat/beta");
    repo.commit("src/beta.ts", "export function betaFeature() { return 'beta-sentinel-99'; }\n");

    // Index feature branch
    const idx2 = runScrybe(["index", "-P", "s8b-proj", "-S", "primary", "-I", "--branch", "feat/beta"], env);
    expect(idx2.exit).toBe(0);

    // Search feature branch — betaFeature should be findable
    const r = runScrybe(["search", "code", "-P", "s8b-proj", "--branch", "feat/beta", "betaFeature"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("betaFeature");
  });
});
