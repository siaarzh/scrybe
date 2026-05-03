import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { gitExec, gitExecOrThrow } from "../src/util/git-exec.js";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "git-exec-test-"));
  execSync("git init", { cwd, stdio: "ignore" });
  execSync("git config user.email test@scrybe.local", { cwd, stdio: "ignore" });
  execSync("git config user.name scrybe-test", { cwd, stdio: "ignore" });
  // Create an initial commit so HEAD resolves
  execSync("git commit --allow-empty -m init", { cwd, stdio: "ignore" });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("gitExec", () => {
  it("returns commit sha on happy path", () => {
    const sha = gitExec(["rev-parse", "HEAD"], { cwd });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for a missing ref (no throw)", () => {
    const result = gitExec(["rev-parse", "nonexistent-branch-xyz"], { cwd });
    expect(result).toBeNull();
  });

  it("shell metacharacters in branch arg are inert (semicolon injection)", () => {
    const poisoned = `master;node -e "require('fs').writeFileSync('PWNED','1')"`;
    const result = gitExec(["show", poisoned], { cwd });
    expect(result).toBeNull();
    expect(existsSync(join(cwd, "PWNED"))).toBe(false);
  });

  it("backtick subshell in branch arg is inert", () => {
    const poisoned = "master`node -e \"require('fs').writeFileSync('PWNED2','1')\"`";
    const result = gitExec(["show", poisoned], { cwd });
    expect(result).toBeNull();
    expect(existsSync(join(cwd, "PWNED2"))).toBe(false);
  });

  it("empty args array returns null (git with no args fails)", () => {
    const result = gitExec([], { cwd });
    expect(result).toBeNull();
  });
});

describe("gitExecOrThrow", () => {
  it("returns trimmed sha on success", () => {
    const sha = gitExecOrThrow(["rev-parse", "HEAD"], { cwd });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // result must be trimmed (no trailing newline)
    expect(sha).toBe(sha.trim());
  });

  it("throws on failure (unknown ref)", () => {
    expect(() =>
      gitExecOrThrow(["rev-parse", "--verify", "no-such-branch"], { cwd })
    ).toThrow();
  });
});
