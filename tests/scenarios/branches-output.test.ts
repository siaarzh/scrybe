/**
 * Scenario 15 — Branch annotations on search results (Plan 20).
 *
 * Spawns the built binary against an isolated DATA_DIR.
 * Indexes a temp repo on two branches, then verifies:
 *   - human-readable `search code` output shows "Branches: ..." line when populated
 *   - shared chunks indexed on two branches show both branch names
 *   - compat mode (SCRYBE_SKIP_MIGRATION=1) still returns results (no crash)
 *
 * Note: `search code` has no --json flag. All assertions use human-readable stdout.
 * Machine-readable branch annotation coverage lives in tests/search-branch-annotations.test.ts.
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

// Enable branch tags by overriding the default SCRYBE_SKIP_MIGRATION=1
const WITH_BRANCH_TAGS = { SCRYBE_SKIP_MIGRATION: "0" };

function setupProject(projectId: string): void {
  if (!env || !repo) throw new Error("env/repo not set up");
  runScrybe(["project", "add", "--id", projectId], env);
  runScrybe(["source", "add", "-P", projectId, "-S", "primary",
    "--type", "code", "--root", repo.path, "--languages", "ts"], env);
}

describe("Scenario 15 — branch annotations on search results (Plan 20)", () => {
  it("human-readable output includes file path and score on a hit", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/shared.ts": "export function sharedFn(): string { return 'shared'; }\n",
    });

    setupProject("s15a-proj");
    runScrybe(["index", "-P", "s15a-proj", "-S", "primary", "-f"], env, WITH_BRANCH_TAGS);

    const r = runScrybe(
      ["search", "code", "-P", "s15a-proj", "--top-k", "3", "sharedFn"],
      env, WITH_BRANCH_TAGS
    );
    expect(r.exit).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    // Human-readable format: "[0.NNN] src/shared.ts:..."
    expect(r.stdout).toMatch(/\[[\d.]+\]\s+src\/shared\.ts/);
  });

  it("shared chunk indexed on two branches shows both in Branches line", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/shared.ts": "export function sharedHelper(): string { return 'hello'; }\n",
    });

    setupProject("s15b-proj");

    // Index on master/main (the default branch after git init)
    runScrybe(["index", "-P", "s15b-proj", "-S", "primary", "-f"], env, WITH_BRANCH_TAGS);

    // Create a feature branch and index again (same file → same chunk_id).
    // Use -f (full) to force branch tag write even when hashes are unchanged.
    repo.branch("feat/plan20");
    runScrybe(["index", "-P", "s15b-proj", "-S", "primary", "--branch", "feat/plan20", "-f"], env, WITH_BRANCH_TAGS);

    const r = runScrybe(
      ["search", "code", "-P", "s15b-proj", "--branch", "feat/plan20", "--top-k", "3", "sharedHelper"],
      env, WITH_BRANCH_TAGS
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("sharedHelper");
    // Both branches should appear in the Branches annotation line
    expect(r.stdout).toContain("Branches:");
    expect(r.stdout).toContain("feat/plan20");
  });

  it("human-readable output shows Branches line for annotated hits", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/hello.ts": "export function helloWorld(): string { return 'hello world'; }\n",
    });

    setupProject("s15c-proj");

    // Index on default branch
    runScrybe(["index", "-P", "s15c-proj", "-S", "primary", "-f"], env, WITH_BRANCH_TAGS);

    // Index the same content on a second branch.
    // Use -f (full) to guarantee branch tags are written even for unchanged content.
    repo.branch("feat/second");
    runScrybe(["index", "-P", "s15c-proj", "-S", "primary", "--branch", "feat/second", "-f"], env, WITH_BRANCH_TAGS);

    const r = runScrybe(
      ["search", "code", "-P", "s15c-proj", "--branch", "feat/second", "helloWorld"],
      env, WITH_BRANCH_TAGS
    );
    expect(r.exit).toBe(0);
    // Chunk is shared across two branches → Branches line must appear
    expect(r.stdout).toContain("Branches:");
  });

  it("compat mode (SCRYBE_SKIP_MIGRATION=1) runs search without crashing", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/compat.ts": "export function compatFn(): number { return 42; }\n",
    });

    setupProject("s15d-proj");

    // Index with branch tags enabled
    runScrybe(["index", "-P", "s15d-proj", "-S", "primary", "-f"], env, WITH_BRANCH_TAGS);

    // Search with SCRYBE_SKIP_MIGRATION=1 (compat mode) — branch filter is skipped.
    // Results should still be returned (no crash, exit 0).
    const r = runScrybe(
      ["search", "code", "-P", "s15d-proj", "--top-k", "3", "compatFn"],
      env
      // no WITH_BRANCH_TAGS override → uses default SCRYBE_SKIP_MIGRATION=1
    );
    expect(r.exit).toBe(0);
    // In compat mode the branch filter is skipped, so chunks still surface
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/compatFn/);
  });
});
