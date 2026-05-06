/**
 * Plan 47 — content-walker divergence + diagnostic logging hardening.
 * Tests T5, T7, T8, T9.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpRepo(): { repoPath: string; cleanup: () => void } {
  const repoPath = mkdtempSync(join(tmpdir(), "scrybe-plan47-"));
  execSync("git init", { cwd: repoPath, stdio: "ignore" });
  execSync("git config core.autocrlf false", { cwd: repoPath, stdio: "ignore" });
  execSync("git config user.email test@scrybe.local", { cwd: repoPath, stdio: "ignore" });
  execSync("git config user.name scrybe-test", { cwd: repoPath, stdio: "ignore" });
  return {
    repoPath,
    cleanup() {
      try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ─── T9 — chunks_indexed gone; chunks_prepared + chunks_persisted present ────

describe("T9 — IndexResult shape (chunks_indexed removed)", () => {
  it("IndexResult has chunks_prepared and chunks_persisted, not chunks_indexed", async () => {
    const { cloneFixture } = await import("./helpers/fixtures.js");
    const { createTempProject } = await import("./helpers/project.js");
    const { runIndex } = await import("./helpers/index-wait.js");

    const fixture = await cloneFixture("sample-multi-branch-repo");
    let project: Awaited<ReturnType<typeof createTempProject>> | null = null;
    try {
      project = await createTempProject({ rootPath: fixture.path });
      const result = await runIndex(project.projectId, project.sourceId, "full");

      expect(result).not.toHaveProperty("chunks_indexed");
      expect(result).toHaveProperty("chunks_prepared");
      expect(result).toHaveProperty("chunks_persisted");
      expect(typeof result.chunks_prepared).toBe("number");
      expect(typeof result.chunks_persisted).toBe("number");
      expect(result.chunks_prepared).toBeGreaterThan(0);
      expect(result.chunks_persisted).toBeGreaterThan(0);
    } finally {
      await project?.cleanup();
      await fixture.cleanup();
    }
  });
});

// ─── T7 — both walkers produce identical relPath sets ────────────────────────

describe("T7 — walkRepoFiles and git ls-tree walker agree on file set", () => {
  let repo: ReturnType<typeof makeTmpRepo> | null = null;

  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  it("HEAD walker and non-HEAD walker yield the same relPath set", async () => {
    repo = makeTmpRepo();
    const { repoPath } = repo;

    // Create two TS files and commit them
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "alpha.ts"), "export const a = 1;\n");
    writeFileSync(join(repoPath, "src", "beta.ts"), "export const b = 2;\n");
    execSync("git add .", { cwd: repoPath, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: "ignore" });

    const headRef = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8" }).trim();

    const { walkRepoFiles } = await import("../src/chunker.js");
    const { scanRef } = await import("../src/plugins/code.js");

    const headFiles = new Set<string>();
    for (const { relPath } of walkRepoFiles(repoPath)) {
      headFiles.add(relPath);
    }

    const nonHeadFiles = new Set<string>();
    for await (const { relPath } of scanRef(repoPath, headRef)) {
      nonHeadFiles.add(relPath);
    }

    expect(headFiles).toEqual(nonHeadFiles);
  });
});

// ─── T8 — .gitignore file excluded by both walkers ──────────────────────────

describe("T8 — files in .gitignore excluded by both walkers", () => {
  let repo: ReturnType<typeof makeTmpRepo> | null = null;

  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  it("a file matched by .gitignore is absent from both HEAD and non-HEAD walker output", async () => {
    repo = makeTmpRepo();
    const { repoPath } = repo;

    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "included.ts"), "export const ok = true;\n");
    writeFileSync(join(repoPath, "src", "excluded.ts"), "export const secret = 42;\n");
    writeFileSync(join(repoPath, ".gitignore"), "src/excluded.ts\n");
    execSync("git add .", { cwd: repoPath, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: "ignore" });

    const headRef = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8" }).trim();

    const { walkRepoFiles } = await import("../src/chunker.js");
    const { scanRef } = await import("../src/plugins/code.js");

    const headFiles = new Set<string>();
    for (const { relPath } of walkRepoFiles(repoPath)) {
      headFiles.add(relPath);
    }

    const nonHeadFiles = new Set<string>();
    for await (const { relPath } of scanRef(repoPath, headRef)) {
      nonHeadFiles.add(relPath);
    }

    expect(headFiles.has("src/included.ts")).toBe(true);
    expect(headFiles.has("src/excluded.ts")).toBe(false);
    expect(nonHeadFiles.has("src/included.ts")).toBe(true);
    expect(nonHeadFiles.has("src/excluded.ts")).toBe(false);
  });
});

// ─── T5 — diagEmit writes to daemon-log.jsonl with level: "error" ────────────

describe("T5 — diagEmit writes error-level event to daemon-log.jsonl", () => {
  let logDir: string | null = null;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "scrybe-plan47-log-"));
    process.env["SCRYBE_DAEMON_LOG_PATH"] = join(logDir, "daemon-log.jsonl");
    process.env["SCRYBE_DATA_DIR"] = logDir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DAEMON_LOG_PATH"];
    if (logDir) {
      try { rmSync(logDir, { recursive: true, force: true }); } catch { /* ignore */ }
      logDir = null;
    }
  });

  it("diagEmit writes a structured event that survives a synthetic throw scenario", async () => {
    const { diagEmit } = await import("../src/daemon/events.js");

    const err = new Error("synthetic worker error");
    diagEmit({
      level: "error",
      event: "process.uncaughtException",
      error: {
        message: err.message,
        stack: err.stack ?? null,
        name: err.name,
      },
    });

    const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"]!;
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;

    expect(parsed["event"]).toBe("process.uncaughtException");
    expect(parsed["level"]).toBe("error");
    expect((parsed["error"] as { message: string }).message).toBe("synthetic worker error");
    expect(parsed["ts"]).toBeDefined();
  });
});
