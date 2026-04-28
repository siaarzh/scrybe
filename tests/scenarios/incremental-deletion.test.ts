/**
 * Scenario 18 — Incremental deletion: deleted files disappear from search (Fix C).
 * Verifies the full CLI path: index → add file → delete file → incremental reindex
 * → search no longer returns the deleted file's content.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

// Allow migration so branch filtering is active (SCRYBE_SKIP_MIGRATION=1 disables it).
// Force in-process mode — daemon routing is tested in two-writer-race.test.ts.
const NO_SKIP = { SCRYBE_SKIP_MIGRATION: "0", SCRYBE_NO_AUTO_DAEMON: "1" };

describe("Scenario 18 — incremental deletion (Fix C)", () => {
  it("deleted file content is removed from branch-scoped search after incremental reindex", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/base.ts": "export const base = 1;\n" });

    runScrybe(["project", "add", "--id", "s18-proj"], env, NO_SKIP);
    runScrybe(["source", "add", "-P", "s18-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env, NO_SKIP);

    // Full index baseline
    const init = runScrybe(["index", "-P", "s18-proj", "-S", "primary", "-f"], env, NO_SKIP);
    expect(init.exit).toBe(0);

    // Add a file with a unique sentinel
    const sentinel = `SCRYBE_DELETION_SENTINEL_${Date.now()}`;
    const tempFile = join(repo.path, "src", "temp-del.ts");
    writeFileSync(tempFile, `// ${sentinel}\nexport const tempDel = "${sentinel}";\n`, "utf8");

    // Incremental index picks up the new file (incremental is default)
    const addRun = runScrybe(["index", "-P", "s18-proj", "-S", "primary"], env, NO_SKIP);
    expect(addRun.exit).toBe(0);
    expect(addRun.stdout + addRun.stderr).toMatch(/files? reindexed|chunk/i);

    // Search should find the sentinel
    const before = runScrybe(["search", "code", "-P", "s18-proj", sentinel], env, NO_SKIP);
    expect(before.exit).toBe(0);
    expect(before.stdout).toContain("temp-del.ts");

    // Delete the file and run incremental reindex
    unlinkSync(tempFile);
    const delRun = runScrybe(["index", "-P", "s18-proj", "-S", "primary"], env, NO_SKIP);
    expect(delRun.exit).toBe(0);

    // Fix D: CLI output should mention removal when only files were removed
    const combined = delRun.stdout + delRun.stderr;
    expect(combined).toMatch(/removed from index|files removed/i);

    // Search should no longer return the deleted file (branch-filtered)
    const after = runScrybe(["search", "code", "-P", "s18-proj", sentinel], env, NO_SKIP);
    expect(after.exit).toBe(0);
    expect(after.stdout).not.toContain("temp-del.ts");
  });
});
