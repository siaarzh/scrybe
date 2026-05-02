import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

// Pre-fix bug: scanRef was called without projectId/sourceId, so loadPrivateIgnore
// in buildScanRefFilter returned null. Result: private ignores were silently
// skipped on every non-HEAD branch indexing — users with whitelist patterns
// re-indexed their entire repo on every branch reindex.
describe("private ignore applies to non-HEAD branch indexing", () => {
  it("whitelist pattern excludes other folders on a pinned branch", () => {
    env = makeScenarioEnv();

    // Two folders: keep/ (whitelisted) and skip/ (must stay out of the index).
    const initFiles: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      initFiles[`keep/keep${i}.ts`] = `export const k${i} = ${i};\n`;
      initFiles[`skip/skip${i}.ts`] = `export const s${i} = ${i};\n`;
    }
    repo = makeTempRepo(initFiles);

    runScrybe(["project", "add", "--id", "pi-nonhead"], env);
    runScrybe(["source", "add", "-P", "pi-nonhead", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // Whitelist keep/ via private ignore.
    const ignoresDir = join(env.dataDir, "ignores", "pi-nonhead");
    mkdirSync(ignoresDir, { recursive: true });
    writeFileSync(
      join(ignoresDir, "primary.gitignore"),
      "/*\n!/keep\n!/keep/**\n",
      "utf8"
    );

    // Create a feature branch that modifies + adds files in BOTH folders.
    execSync("git checkout -b feature/x", { cwd: repo.path, stdio: "ignore" });
    repo.commit("keep/keep0.ts", "export const k0 = 100;\n");
    repo.commit("skip/skip0.ts", "export const s0 = 100;\n");
    repo.commit("skip/new-file.ts", "export const newcomer = 1;\n");
    execSync("git checkout master", { cwd: repo.path, stdio: "ignore" });

    // Index the non-HEAD branch directly. Pre-fix: scanRef ignores private rules
    // and embeds files from skip/ too. Post-fix: only keep/ files are processed.
    const r = runScrybe([
      "index", "-P", "pi-nonhead", "-S", "primary", "-I",
      "--branch", "feature/x",
    ], env);
    expect(r.exit).toBe(0);

    // The strongest assertion: search for content unique to skip/ on the
    // feature/x branch returns nothing, while content from keep/ does. Mirrors
    // the user-visible bug — skip/ should never have been embedded.
    const skipSearch = runScrybe([
      "search", "code", "-P", "pi-nonhead",
      "--branch", "feature/x",
      "newcomer",
    ], env);
    expect(skipSearch.exit).toBe(0);
    expect(skipSearch.stdout).not.toMatch(/skip\/new-file\.ts/);

    const keepSearch = runScrybe([
      "search", "code", "-P", "pi-nonhead",
      "--branch", "feature/x",
      "k0",
    ], env);
    expect(keepSearch.exit).toBe(0);
    // Content from keep/ must be findable to confirm the index isn't empty.
    expect(keepSearch.stdout).toMatch(/keep\//);
  });
});
