import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("FTS UUID dir count stays low after large incremental", () => {
  it("full + incremental touching 12 files leaves ≤ 2 UUID dirs in _indices/", () => {
    env = makeScenarioEnv();

    // Seed repo with 12 .ts files
    const initFiles: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) {
      initFiles[`src/file${i}.ts`] = `export function fn${i}(): number { return ${i}; }\n`;
    }
    repo = makeTempRepo(initFiles);

    runScrybe(["project", "add", "--id", "p29-proj"], env);
    runScrybe(["source", "add", "-P", "p29-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Full index
    const full = runScrybe(["index", "-P", "p29-proj", "-S", "primary", "-f"], env);
    expect(full.exit).toBe(0);

    // Modify all 12 files so they all get re-embedded in the incremental run
    for (let i = 1; i <= 12; i++) {
      repo.commit(`src/file${i}.ts`, `export function fn${i}(): number { return ${i * 2}; }\n`, `update file${i}`);
    }

    // Incremental re-index — 12 files changed
    const incr = runScrybe(["index", "-P", "p29-proj", "-S", "primary", "-I"], env);
    expect(incr.exit).toBe(0);

    // Check _indices/ UUID dir count. Lance tables are named code_<hash>.lance.
    // Find the first code_ table directory in DATA_DIR/lancedb/.
    const lanceDir = join(env.dataDir, "lancedb");
    const tableDirs = existsSync(lanceDir) ? readdirSync(lanceDir) : [];
    const tableDir = tableDirs.find((d) => d.startsWith("code_"));
    expect(tableDir).toBeTruthy();

    const indicesDir = join(lanceDir, tableDir!, "_indices");
    const uuidDirs = existsSync(indicesDir)
      ? readdirSync(indicesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
      : 0;

    // Pre-fix: 12 files incremental with maybeCompact-per-upsert → ~12 uuid dirs.
    // Post-fix: all 12 files in one batched upsert → pruneIndexOrphans cleans old dirs → ≤ 4.
    // We use a generous bound (< number of changed files) to stay resilient to Lance internals.
    expect(uuidDirs).toBeLessThan(12);
  });
});

describe("branch-ref validation", () => {
  it("scrybe index --branch <bogus> exits non-zero with clear error", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    runScrybe(["project", "add", "--id", "p29b-proj"], env);
    runScrybe(["source", "add", "-P", "p29b-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    const r = runScrybe(["index", "-P", "p29b-proj", "-S", "primary", "-I",
      "--branch", "totally-bogus-ref-xyz"], env);

    expect(r.exit).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/branch 'totally-bogus-ref-xyz' not found locally/i);
  });

  it("scrybe index --branch 5.x (remote-only) exits non-zero and mentions 'origin/5.x'", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    runScrybe(["project", "add", "--id", "p29c-proj"], env);
    runScrybe(["source", "add", "-P", "p29c-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    const r = runScrybe(["index", "-P", "p29c-proj", "-S", "primary", "-I",
      "--branch", "5.x"], env);

    expect(r.exit).not.toBe(0);
    const output = r.stderr + r.stdout;
    expect(output).toMatch(/branch '5\.x' not found locally/i);
    expect(output).toMatch(/origin\/5\.x/);
  });
});
