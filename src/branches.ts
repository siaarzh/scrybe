import { execSync } from "child_process";
import { getSource } from "./registry.js";
import type { SourceConfig } from "./types.js";

/**
 * Converts a branch name to a filename-safe slug for use in hash file names.
 * "/" → "__" (readable and cross-platform safe).
 * "*" → "_all_" (the non-code source sentinel, avoids glob issues on Windows).
 */
export function slugifyBranch(branch: string): string {
  if (branch === "*") return "_all_";
  return branch.replace(/\//g, "__");
}

/**
 * Resolves the current HEAD branch name for a git repository at repoPath.
 * Returns "*" if the path is not a git repo or git is unavailable.
 * On detached HEAD, returns a 12-character short commit SHA.
 */
export function resolveBranchForPath(repoPath: string): string {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch === "HEAD") {
      return execSync("git rev-parse HEAD", {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().slice(0, 12);
    }
    return branch;
  } catch {
    return "*";
  }
}

/**
 * Resolves the effective branch for a (project, source) pair.
 * Code sources: reads HEAD from the source's root_path.
 * All other source types: returns "*" (branch-agnostic sentinel).
 *
 * Contract 9 export — M-D2 daemon calls this on startup and on .git/HEAD watcher fires.
 */
export function resolveBranch(projectId: string, sourceId: string): string {
  const source = getSource(projectId, sourceId);
  if (!source) return "*";
  const cfg = source.source_config;
  if (cfg.type === "code") {
    const rootPath = (cfg as Extract<SourceConfig, { type: "code" }>).root_path;
    return resolveBranchForPath(rootPath);
  }
  return "*";
}
