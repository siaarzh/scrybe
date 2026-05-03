/**
 * Verifies that a malicious branch name passed to scrybe cannot trigger
 * unintended side effects (e.g. shell command execution) via git invocations.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("branch pin with malicious branch name", () => {
  it("does not write PWNED file when branch name contains shell metacharacters", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    runScrybe(["project", "add", "--id", "inj-test"], env);
    runScrybe(["source", "add", "-P", "inj-test", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    // The malicious string would previously have been interpolated into a shell
    // command string, potentially executing arbitrary code. With execFileSync
    // (no shell), the string is passed as a literal argument to git.
    const maliciousBranch = `master;node -e "require('fs').writeFileSync('PWNED','1')"`;

    runScrybe(
      ["branch", "pin", "-P", "inj-test", "-S", "primary", maliciousBranch],
      env,
    );

    // The PWNED marker must not exist in the repo root or cwd.
    // This is the meaningful check: no file was written by shell command execution.
    expect(existsSync(join(repo.path, "PWNED"))).toBe(false);
    expect(existsSync("PWNED")).toBe(false);
  });
});
