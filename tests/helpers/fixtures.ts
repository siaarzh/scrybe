/**
 * Contract 2 — Fixture cloning.
 * Clones a named fixture from tests/fixtures/ into a fresh tmpdir.
 * Ensures git is initialized with LF line endings for cross-platform hash consistency.
 */
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, "../fixtures");

export interface FixtureHandle {
  path: string;
  cleanup(): Promise<void>;
}

/**
 * Ensures the fixture repo has a git history (idempotent).
 * Called automatically by cloneFixture, but safe to call multiple times.
 */
export function ensureFixtureGit(name: string): void {
  const fixturePath = join(FIXTURES_ROOT, name);
  if (!existsSync(join(fixturePath, ".git"))) {
    execSync("git init", { cwd: fixturePath, stdio: "ignore" });
    execSync("git config core.autocrlf false", { cwd: fixturePath, stdio: "ignore" });
    execSync("git config user.email test@scrybe.local", { cwd: fixturePath, stdio: "ignore" });
    execSync("git config user.name scrybe-test", { cwd: fixturePath, stdio: "ignore" });
    execSync("git add .", { cwd: fixturePath, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: fixturePath, stdio: "ignore" });
  }
}

/**
 * Clones the named fixture into a fresh tmpdir.
 * Returns a handle with the clone path and a cleanup function.
 */
export async function cloneFixture(name: string): Promise<FixtureHandle> {
  const fixturePath = join(FIXTURES_ROOT, name);
  ensureFixtureGit(name);

  const cloneDir = mkdtempSync(join(tmpdir(), `scrybe-fixture-${name}-`));
  execSync(
    `git clone --local --no-hardlinks "${fixturePath}" "${cloneDir}"`,
    { stdio: "ignore" }
  );
  execSync("git config core.autocrlf false", { cwd: cloneDir, stdio: "ignore" });

  return {
    path: cloneDir,
    async cleanup() {
      await new Promise((r) => setTimeout(r, 100));
      try {
        rmSync(cloneDir, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}
