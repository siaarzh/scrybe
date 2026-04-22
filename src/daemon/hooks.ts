/**
 * Daemon git hooks — Phase 8.
 * Installs / uninstalls scrybe marker blocks in .git/hooks/post-commit,
 * post-checkout, post-merge, and post-rewrite.
 *
 * Marker format:
 *   # >>> scrybe >>>
 *   node "/abs/path/to/dist/index.js" daemon kick --project-id "ID" 2>/dev/null || true
 *   # <<< scrybe <<<
 *
 * Existing hooks are appended to (not replaced). Uninstall strips only the
 * marker block. Idempotent: install on an already-installed hook is a no-op.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

const MARKER_BEGIN = "# >>> scrybe >>>";
const MARKER_END = "# <<< scrybe <<<";
const HOOK_NAMES = ["post-commit", "post-checkout", "post-merge", "post-rewrite"] as const;

export interface HookInstallResult {
  installed: string[];   // hook names that were freshly installed
  skipped: string[];     // hook names already had the block (no-op)
}

export interface HookUninstallResult {
  removed: string[];     // hook names where the block was removed
  notFound: string[];    // hook names where no scrybe block existed
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Install scrybe daemon kick hooks in the git repo at `repoRoot`.
 * `mainJsPath` is the absolute path to dist/index.js (process.argv[1] in CLI).
 * `projectId` is passed as --project-id to the daemon kick command.
 */
export function installHooks(
  repoRoot: string,
  mainJsPath: string,
  projectId: string
): HookInstallResult {
  const hooksDir = join(repoRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const kickLine = buildKickLine(mainJsPath, projectId);
  const block = `${MARKER_BEGIN}\n${kickLine}\n${MARKER_END}`;

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of HOOK_NAMES) {
    const hookPath = join(hooksDir, name);
    const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;

    if (existing !== null && existing.includes(MARKER_BEGIN)) {
      skipped.push(name);
      continue;
    }

    let content: string;
    if (existing === null || existing.trim() === "") {
      content = `#!/bin/sh\n${block}\n`;
    } else {
      // Append after existing content (preserve trailing newline hygiene)
      content = existing.endsWith("\n")
        ? `${existing}${block}\n`
        : `${existing}\n${block}\n`;
    }

    writeFileSync(hookPath, content, { encoding: "utf8", mode: 0o755 });
    try { chmodSync(hookPath, 0o755); } catch { /* ignore on Windows */ }
    installed.push(name);
  }

  return { installed, skipped };
}

/**
 * Remove scrybe marker blocks from all git hooks in `repoRoot`.
 * Hooks that become empty (just shebang) are left in place to avoid breaking
 * anything that checks for hook existence.
 */
export function uninstallHooks(repoRoot: string): HookUninstallResult {
  const hooksDir = join(repoRoot, ".git", "hooks");
  const removed: string[] = [];
  const notFound: string[] = [];

  for (const name of HOOK_NAMES) {
    const hookPath = join(hooksDir, name);
    if (!existsSync(hookPath)) {
      notFound.push(name);
      continue;
    }

    const content = readFileSync(hookPath, "utf8");
    if (!content.includes(MARKER_BEGIN)) {
      notFound.push(name);
      continue;
    }

    const stripped = stripMarkerBlock(content);
    writeFileSync(hookPath, stripped, { encoding: "utf8", mode: 0o755 });
    removed.push(name);
  }

  return { removed, notFound };
}

/**
 * Returns the kick line that would be installed for a given mainJsPath + projectId.
 * Exported so tests can assert on the exact content written to hooks.
 */
export function buildKickLine(mainJsPath: string, projectId: string): string {
  return `node "${mainJsPath}" daemon kick --project-id "${projectId}" 2>/dev/null || true`;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function stripMarkerBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inside = false;

  for (const line of lines) {
    if (line.trimEnd() === MARKER_BEGIN) {
      inside = true;
      continue;
    }
    if (line.trimEnd() === MARKER_END) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }

  // Clean up extra blank lines left around the removed block
  const result = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return result.endsWith("\n") ? result : result + "\n";
}
