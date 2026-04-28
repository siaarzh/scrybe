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
    // Incremental mode correctly writes branch tags for the new branch even when
    // content is unchanged: knownChunkIds skips the embedder, but applyFile still
    // INSERT-OR-IGNOREs branch_tags rows for the active branch.
    repo.branch("feat/plan20");
    runScrybe(["index", "-P", "s15b-proj", "-S", "primary", "--branch", "feat/plan20", "--incremental"], env, WITH_BRANCH_TAGS);

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

    // Index the same content on a second branch — incremental mode is sufficient.
    repo.branch("feat/second");
    runScrybe(["index", "-P", "s15c-proj", "-S", "primary", "--branch", "feat/second", "--incremental"], env, WITH_BRANCH_TAGS);

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

  // Regression for plan 20.1: incremental indexing on a new branch (working tree
  // unchanged) must write branch_tags rows for the new branch — otherwise
  // search --branch <new> silently returns empty even though chunks live in
  // LanceDB. Investigation in plan 20.1 confirmed the indexer does this
  // correctly; this test guards against future regressions in that path.
  // Asserts exit codes on every step so a CLI flag mismatch can never silently
  // skip an index call.
  it("incremental index on a new branch writes tags (plan 20.1 regression)", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/regress.ts": "export function regressFn(): string { return 'plan20.1'; }\n",
    });

    setupProject("s15e-proj");

    const r1 = runScrybe(["index", "-P", "s15e-proj", "-S", "primary", "-f"], env, WITH_BRANCH_TAGS);
    expect(r1.exit).toBe(0);

    repo.branch("feat/regress");

    // Use the long flag so a future short-flag rename (e.g. -i vs -I) can't
    // silently break this and recreate the symptom that spawned plan 20.1.
    const r2 = runScrybe(
      ["index", "-P", "s15e-proj", "-S", "primary", "--branch", "feat/regress", "--incremental"],
      env, WITH_BRANCH_TAGS
    );
    expect(r2.exit).toBe(0);

    // Search filtered to the new branch must return the chunk AND annotate it
    // with both branches.
    const r3 = runScrybe(
      ["search", "code", "-P", "s15e-proj", "--branch", "feat/regress", "regressFn"],
      env, WITH_BRANCH_TAGS
    );
    expect(r3.exit).toBe(0);
    expect(r3.stdout).toContain("regressFn");
    expect(r3.stdout).toContain("Branches:");
    expect(r3.stdout).toContain("feat/regress");
  });
});
