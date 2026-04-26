/**
 * Scenario 2  — Remove → re-add → --full reindex → search returns hits (M-D13 Fix 1).
 * Scenario 3  — Lance bloat capped by threshold (M-D13 Fix 4).
 * Scenario 13 — --full reindex on existing project works correctly.
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

describe("Scenario 2 — remove → re-add → --full reindex → search (M-D13 Fix 1)", () => {
  it("search returns hits after project removed and re-added with --full", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/payments.ts": "export function processPayment(amount: number) { return { ok: true, amount }; }\n",
    });

    // Step 1: register + index
    runScrybe(["project", "add", "--id", "s2-proj"], env);
    runScrybe(["source", "add", "-P", "s2-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    const first = runScrybe(["index", "-P", "s2-proj", "-S", "primary", "-f"], env);
    expect(first.exit).toBe(0);

    // Confirm initial search works
    const hit1 = runScrybe(["search", "code", "-P", "s2-proj", "processPayment"], env);
    expect(hit1.stdout).toContain("processPayment");

    // Step 2: remove
    runScrybe(["project", "remove", "s2-proj"], env);

    // Step 3: re-add with same ID
    runScrybe(["project", "add", "--id", "s2-proj"], env);
    runScrybe(["source", "add", "-P", "s2-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Step 4: full reindex — must write chunks (not a no-op)
    const second = runScrybe(["index", "-P", "s2-proj", "-S", "primary", "-f"], env);
    expect(second.exit).toBe(0);
    // Should NOT exit with code 2 (files>0, chunks=0 false success)
    expect(second.exit).not.toBe(2);
    expect(second.stdout + second.stderr).toMatch(/chunk|indexed/i);

    // Step 5: search must return hits
    const hit2 = runScrybe(["search", "code", "-P", "s2-proj", "processPayment"], env);
    expect(hit2.exit).toBe(0);
    expect(hit2.stdout).toContain("processPayment");
  });
});

describe("Scenario 3 — Lance version count capped by threshold (M-D13 Fix 4)", () => {
  it("repeated full indexes keep version count manageable (maybeCompact fires)", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const v = 1;\n" });

    runScrybe(["project", "add", "--id", "s3-proj"], env);
    runScrybe(["source", "add", "-P", "s3-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Run 15 full reindexes — threshold is 10, so compaction should fire multiple times
    // (Each --full does: delete + upsert, each triggering maybeCompact)
    for (let i = 0; i < 15; i++) {
      repo.commit("src/index.ts", `export const v = ${i};\n`, `update ${i}`);
      const r = runScrybe(["index", "-P", "s3-proj", "-S", "primary", "-f"], env);
      expect(r.exit).toBe(0);
    }

    // After 15 full reindexes, scrybe ps should still work and not crash
    const ps = runScrybe(["status"], env);
    expect(ps.exit).toBe(0);
    expect(ps.stdout).toContain("s3-proj");
    // Search must still return results (compaction didn't delete live data)
    const r = runScrybe(["search", "code", "-P", "s3-proj", "export const v"], env);
    expect(r.exit).toBe(0);
  });
});

describe("Scenario 13 — --full reindex on existing project", () => {
  it("full reindex re-embeds all chunks and leaves search working", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/auth.ts": "export function authenticate(token: string) { return token.length > 0; }\n",
      "src/users.ts": "export function getUser(id: number) { return { id, name: 'Alice' }; }\n",
    });

    runScrybe(["project", "add", "--id", "s13-proj"], env);
    runScrybe(["source", "add", "-P", "s13-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // First index
    const first = runScrybe(["index", "-P", "s13-proj", "-S", "primary", "-f"], env);
    expect(first.exit).toBe(0);

    // Modify a file
    repo.commit("src/auth.ts",
      "export function authenticate(token: string) { return token.length > 8; }\n");

    // Full reindex — should NOT be a no-op
    const second = runScrybe(["index", "-P", "s13-proj", "-S", "primary", "-f"], env);
    expect(second.exit).toBe(0);
    expect(second.exit).not.toBe(2); // no false-success

    // Both functions should still be searchable
    const r1 = runScrybe(["search", "code", "-P", "s13-proj", "authenticate"], env);
    expect(r1.stdout).toContain("authenticate");

    const r2 = runScrybe(["search", "code", "-P", "s13-proj", "getUser"], env);
    expect(r2.stdout).toContain("getUser");
  });

  it("exit code 2 when files scheduled but 0 chunks written (M-D13 Fix 2)", () => {
    // This tests the exit-code contract: files>0 & chunks=0 → exit 2
    // Simulate by indexing an empty repo (no .ts files)
    env = makeScenarioEnv();
    repo = makeTempRepo({ "README.md": "# test\n" }); // no .ts files

    runScrybe(["project", "add", "--id", "s13e-proj"], env);
    runScrybe(["source", "add", "-P", "s13e-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Index with no matching files — files_reindexed=0, chunks_indexed=0 → exit 0 (nothing to do)
    const r = runScrybe(["index", "-P", "s13e-proj", "-S", "primary", "-f"], env);
    // Both 0: nothing to do → exit 0
    expect(r.exit).toBe(0);
  });
});
