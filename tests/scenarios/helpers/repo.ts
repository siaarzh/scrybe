/**
 * Scenario harness — temp git repo helpers.
 * Lifted from tests/e2e/init.test.ts pattern.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

export interface TempRepo {
  path: string;
  /** Write a file and commit it. Returns the commit hash. */
  commit(relPath: string, content: string, message?: string): string;
  /** Create and checkout a new branch. */
  branch(name: string): void;
  /** Checkout an existing branch. */
  checkout(name: string): void;
  cleanup(): void;
}

/** Create a temp git repo pre-initialised with one commit. */
export function makeTempRepo(files: Record<string, string> = {}): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "scrybe-repo-"));

  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email scenario@scrybe.local", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name scrybe-scenario", { cwd: dir, stdio: "ignore" });
  execSync("git config core.autocrlf false", { cwd: dir, stdio: "ignore" });

  // Write initial files
  const initFiles = Object.keys(files).length > 0
    ? files
    : { "src/index.ts": "export const hello = () => 'hello world';\n" };

  for (const [rel, content] of Object.entries(initFiles)) {
    const full = join(dir, rel);
    mkdirSync(join(dir, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });

  return {
    path: dir,
    commit(relPath, content, message = "update") {
      const full = join(dir, relPath);
      mkdirSync(join(dir, relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "."), { recursive: true });
      writeFileSync(full, content, "utf8");
      execSync("git add -A", { cwd: dir, stdio: "ignore" });
      execSync(`git commit -m "${message}"`, { cwd: dir, stdio: "ignore" });
      return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    },
    branch(name) {
      execSync(`git checkout -b "${name}"`, { cwd: dir, stdio: "ignore" });
    },
    checkout(name) {
      execSync(`git checkout "${name}"`, { cwd: dir, stdio: "ignore" });
    },
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
