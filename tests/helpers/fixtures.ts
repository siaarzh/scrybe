/**
 * Contract 2 — Fixture cloning.
 * Clones a named fixture from tests/fixtures/ into a fresh tmpdir.
 * Ensures git is initialized with LF line endings for cross-platform hash consistency.
 */
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
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
 * Sets up the sample-multi-branch-repo fixture with two branches (idempotent).
 *
 * main:     src/alpha.ts exports alphaGreeting
 * feat/example: src/alpha.ts additionally exports alphaFarewell
 *
 * Amendment #7: lazy setup, NOT in globalSetup — mirrors ensureFixtureGit pattern.
 */
export function ensureMultiBranchFixture(name: string): void {
  const fixturePath = join(FIXTURES_ROOT, name);
  const featExampleRef = join(fixturePath, ".git", "refs", "heads", "feat", "example");

  // Short-circuit if already set up
  if (existsSync(featExampleRef)) return;

  ensureFixtureGit(name);

  // Create feat/example branch from main and add alphaFarewell
  execSync("git checkout -b feat/example", { cwd: fixturePath, stdio: "ignore" });
  const alphaPath = join(fixturePath, "src", "alpha.ts");
  const current = existsSync(alphaPath) ? readFileSync(alphaPath, "utf8") : "";
  const farewell = `\nexport function alphaFarewell(): string {\n  return "Goodbye from alpha";\n}\n`;
  writeFileSync(alphaPath, current + farewell, "utf8");
  execSync("git add src/alpha.ts", { cwd: fixturePath, stdio: "ignore" });
  execSync('git commit -m "add alphaFarewell"', { cwd: fixturePath, stdio: "ignore" });

  // Switch back to main (cross-platform — no shell redirect)
  try {
    execSync("git checkout main", { cwd: fixturePath, stdio: "ignore" });
  } catch {
    execSync("git checkout master", { cwd: fixturePath, stdio: "ignore" });
  }
}

/**
 * Clones an arbitrary local git repo into a fresh tmpdir.
 * Useful for creating a "local" repo whose origin points to another temp clone.
 * Returns a handle with the clone path and a cleanup function.
 */
export function cloneLocal(sourcePath: string): FixtureHandle {
  const cloneDir = mkdtempSync(join(tmpdir(), "scrybe-local-"));
  execSync(
    `git clone --local --no-hardlinks "${sourcePath}" "${cloneDir}"`,
    { stdio: "ignore" }
  );
  execSync("git config core.autocrlf false", { cwd: cloneDir, stdio: "ignore" });
  execSync("git config user.email test@scrybe.local", { cwd: cloneDir, stdio: "ignore" });
  execSync("git config user.name scrybe-test", { cwd: cloneDir, stdio: "ignore" });
  execSync("git fetch --all", { cwd: cloneDir, stdio: "ignore" });
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

/**
 * Clones the named fixture into a fresh tmpdir.
 * Returns a handle with the clone path and a cleanup function.
 *
 * Amendment #5: sets user.email + user.name on the clone so commitFile / createBranch
 * helpers work on CI and fresh machines where global git identity is absent.
 */
export async function cloneFixture(name: string): Promise<FixtureHandle> {
  const fixturePath = join(FIXTURES_ROOT, name);

  if (name === "sample-multi-branch-repo") {
    ensureMultiBranchFixture(name);
  } else {
    ensureFixtureGit(name);
  }

  const cloneDir = mkdtempSync(join(tmpdir(), `scrybe-fixture-${name}-`));
  execSync(
    `git clone --local --no-hardlinks "${fixturePath}" "${cloneDir}"`,
    { stdio: "ignore" }
  );
  execSync("git config core.autocrlf false", { cwd: cloneDir, stdio: "ignore" });
  // Amendment #5: set identity so git commit works on the clone
  execSync("git config user.email test@scrybe.local", { cwd: cloneDir, stdio: "ignore" });
  execSync("git config user.name scrybe-test", { cwd: cloneDir, stdio: "ignore" });
  // Fetch all branches so tests can switch between them
  execSync("git fetch --all", { cwd: cloneDir, stdio: "ignore" });

  // Explicitly create local tracking branches for all remote branches.
  // git DWIM checkout is unreliable for slash-path branches (e.g. feat/example) on Windows.
  try {
    const raw = execSync("git branch -r", { cwd: cloneDir, encoding: "utf8" });
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes("->")) continue;
      const localName = trimmed.replace(/^origin\//, "");
      try {
        execSync(`git branch "${localName}" "${trimmed}"`, { cwd: cloneDir, stdio: "ignore" });
      } catch { /* already exists */ }
    }
  } catch { /* ignore — best effort */ }

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
