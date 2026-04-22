/**
 * Phase 8 — Git hooks: install, uninstall, idempotency, marker stripping.
 * Uses a real tmpdir git repo (no mocks needed — pure filesystem operations).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { installHooks, uninstallHooks, buildKickLine } from "../src/daemon/hooks.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let repoRoot: string;

function hooksDir(): string { return join(repoRoot, ".git", "hooks"); }
function hookPath(name: string): string { return join(hooksDir(), name); }
function hookContent(name: string): string {
  return existsSync(hookPath(name)) ? readFileSync(hookPath(name), "utf8") : "";
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "scrybe-hook-test-"));
  execSync("git init", { cwd: repoRoot, stdio: "ignore" });
  execSync("git config user.email test@scrybe.local", { cwd: repoRoot, stdio: "ignore" });
  execSync("git config user.name scrybe-test", { cwd: repoRoot, stdio: "ignore" });
});

afterEach(() => {
  try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Install ──────────────────────────────────────────────────────────────────

describe("installHooks", () => {
  it("creates hook files with shebang + marker block when none exist", () => {
    const result = installHooks(repoRoot, "/abs/dist/index.js", "my-project");

    expect(result.installed).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);

    const content = hookContent("post-commit");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("# >>> scrybe >>>");
    expect(content).toContain("# <<< scrybe <<<");
    expect(content).toContain(buildKickLine("/abs/dist/index.js", "my-project"));
  });

  it("appends marker block to existing hooks without replacing them", () => {
    mkdirSync(hooksDir(), { recursive: true });
    writeFileSync(hookPath("post-commit"), "#!/bin/sh\necho hello\n", { mode: 0o755 });

    installHooks(repoRoot, "/abs/dist/index.js", "my-project");

    const content = hookContent("post-commit");
    expect(content).toContain("echo hello");
    expect(content).toContain("# >>> scrybe >>>");
    expect(content).toContain(buildKickLine("/abs/dist/index.js", "my-project"));
  });

  it("skips hooks that already have the marker block (idempotent)", () => {
    installHooks(repoRoot, "/abs/dist/index.js", "my-project");
    const result2 = installHooks(repoRoot, "/abs/dist/index.js", "my-project");

    expect(result2.installed).toHaveLength(0);
    expect(result2.skipped).toHaveLength(4);
  });

  it("installs the correct kick command with quoted paths and project id", () => {
    installHooks(repoRoot, "/path with spaces/dist/index.js", "proj-with-dashes");

    const content = hookContent("post-commit");
    expect(content).toContain('node "/path with spaces/dist/index.js" daemon kick --project-id "proj-with-dashes"');
    expect(content).toContain("2>/dev/null || true");
  });

  it("installs all four hook files", () => {
    installHooks(repoRoot, "/abs/dist/index.js", "p1");
    for (const name of ["post-commit", "post-checkout", "post-merge", "post-rewrite"]) {
      expect(existsSync(hookPath(name))).toBe(true);
      expect(hookContent(name)).toContain("# >>> scrybe >>>");
    }
  });
});

// ─── Uninstall ────────────────────────────────────────────────────────────────

describe("uninstallHooks", () => {
  it("removes the marker block from all hooks", () => {
    installHooks(repoRoot, "/abs/dist/index.js", "my-project");
    const result = uninstallHooks(repoRoot);

    expect(result.removed).toHaveLength(4);
    expect(result.notFound).toHaveLength(0);

    const content = hookContent("post-commit");
    expect(content).not.toContain("# >>> scrybe >>>");
    expect(content).not.toContain("# <<< scrybe <<<");
    expect(content).not.toContain("daemon kick");
  });

  it("preserves non-scrybe content when uninstalling", () => {
    mkdirSync(hooksDir(), { recursive: true });
    writeFileSync(hookPath("post-commit"), "#!/bin/sh\necho custom\n", { mode: 0o755 });
    installHooks(repoRoot, "/abs/dist/index.js", "my-project");
    uninstallHooks(repoRoot);

    const content = hookContent("post-commit");
    expect(content).toContain("echo custom");
    expect(content).not.toContain("daemon kick");
  });

  it("reports notFound for hooks without a marker block", () => {
    const result = uninstallHooks(repoRoot);
    // No hooks exist at all → all notFound
    expect(result.removed).toHaveLength(0);
    expect(result.notFound).toHaveLength(4);
  });

  it("is idempotent — double uninstall does not error", () => {
    installHooks(repoRoot, "/abs/dist/index.js", "my-project");
    uninstallHooks(repoRoot);
    expect(() => uninstallHooks(repoRoot)).not.toThrow();
  });
});
