import { gitExec } from "./util/git-exec.js";
import { resolveBranchForPath } from "./branch-state.js";
import { diagEmit } from "./daemon/events.js";

export interface LeftOutLocalEdits {
  dirtyFiles: number;
  localOnlyCommits: number;
}

/** Local work a pinned branch's index leaves out; null if it is not checked out or git cannot answer. */
export function countLeftOutLocalEdits(rootPath: string, branch: string): LeftOutLocalEdits | null {
  if (rootPath === "" || resolveBranchForPath(rootPath) !== branch) return null;
  const status = gitExec(["status", "--porcelain"], { cwd: rootPath, trim: false });
  const ahead = gitExec(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: rootPath });
  if (status === null || ahead === null) return null;
  return {
    dirtyFiles: status.split("\n").filter((l) => l.trim() !== "").length,
    localOnlyCommits: Number.parseInt(ahead, 10) || 0,
  };
}

const WAIT_AFTER_WARNING_MS = 10 * 60 * 1000;
const WAIT_AFTER_CLEAN_CHECK_MS = 60 * 1000;
const nextCheckAt = new Map<string, number>();

/** Log that local edits are not indexed, at most once per 10 minutes per project+source+branch; a clean check waits 1 minute. */
export function warnLeftOutLocalEdits(
  projectId: string,
  sourceId: string,
  branch: string,
  rootPath: string,
): void {
  const key = `${projectId}\u0000${sourceId}\u0000${branch}`;
  const now = Date.now();
  if (now < (nextCheckAt.get(key) ?? 0)) return;

  const edits = countLeftOutLocalEdits(rootPath, branch);
  if (edits === null || (edits.dirtyFiles === 0 && edits.localOnlyCommits === 0)) {
    nextCheckAt.set(key, now + WAIT_AFTER_CLEAN_CHECK_MS);
    return;
  }
  nextCheckAt.set(key, now + WAIT_AFTER_WARNING_MS);
  diagEmit({
    event: "indexer.pinned.local_edits_left_out",
    level: "warn",
    projectId,
    sourceId,
    branch,
    dirty_files: edits.dirtyFiles,
    local_only_commits: edits.localOnlyCommits,
    message: `pinned branch '${branch}' is indexed from origin/${branch}; local edits are not searchable until pushed`,
  });
}
