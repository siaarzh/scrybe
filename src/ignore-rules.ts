import { existsSync, readFileSync } from "fs";
import { join } from "path";
import ignore from "ignore";
import { loadPrivateIgnore } from "./private-ignore.js";

// CJS interop: `ignore` module.exports is the factory function
type IgnoreManager = { add(patterns: string): void; ignores(path: string): boolean };
const createIgnore = ignore as unknown as () => IgnoreManager;

export interface IgnoreRules {
  /** Returns true when relPath should be excluded from indexing. */
  shouldIgnore: (relPath: string) => boolean;
  /** Returns true when relPath matches a !pattern (force-include override). */
  isForceIncluded: (relPath: string) => boolean;
  /** Raw negation pattern strings collected from .scrybeignore + private ignore. */
  forcePatterns: string[];
}

/**
 * Build canonical ignore rules for a repo root, applying:
 *   - working-tree .gitignore
 *   - working-tree .scrybeignore
 *   - DATA_DIR private ignore (keyed by projectId + sourceId)
 *
 * Working-tree .gitignore wins for all branches (consistent local view).
 * Used by both walkRepoFiles (HEAD) and the git ls-tree walker (non-HEAD).
 */
export function loadCanonicalIgnoreRules(
  rootPath: string,
  projectId?: string,
  sourceId?: string,
): IgnoreRules {
  const mgr = createIgnore();
  let hasRules = false;
  const forcePatterns: string[] = [];

  const gitignorePath = join(rootPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    try { mgr.add(readFileSync(gitignorePath, "utf8")); hasRules = true; } catch {}
  }

  const scrybeignorePath = join(rootPath, ".scrybeignore");
  if (existsSync(scrybeignorePath)) {
    try {
      const content = readFileSync(scrybeignorePath, "utf8");
      mgr.add(content);
      hasRules = true;
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("!") && trimmed.length > 1) forcePatterns.push(trimmed.slice(1));
      }
    } catch {}
  }

  if (projectId && sourceId) {
    const privateContent = loadPrivateIgnore(projectId, sourceId);
    if (privateContent) {
      try {
        mgr.add(privateContent);
        hasRules = true;
        for (const line of privateContent.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith("!") && trimmed.length > 1) forcePatterns.push(trimmed.slice(1));
        }
      } catch {}
    }
  }

  let forceInclude: IgnoreManager | null = null;
  if (forcePatterns.length > 0) {
    forceInclude = createIgnore();
    forceInclude.add(forcePatterns.join("\n"));
  }

  const effectiveMgr = hasRules ? mgr : null;

  return {
    shouldIgnore: (relPath: string) => {
      try { return effectiveMgr?.ignores(relPath) ?? false; } catch { return false; }
    },
    isForceIncluded: (relPath: string) => forceInclude?.ignores(relPath) === true,
    forcePatterns,
  };
}
