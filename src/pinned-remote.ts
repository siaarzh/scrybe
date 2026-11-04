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

const WARN_EVERY_MS = 10 * 60 * 1000;
const lastWarned = new Map<string, number>();

/** Log (at most once per 10 minutes per project+source+branch) that local edits are not indexed. */
export function warnLeftOutLocalEdits(
  projectId: string,
  sourceId: string,
  branch: string,
  rootPath: string,
): void {
  const key = `${projectId}\u0000${sourceId}\u0000${branch}`;
  const now = Date.now();
  const prev = lastWarned.get(key);
  if (prev !== undefined && now - prev < WARN_EVERY_MS) return;
  lastWarned.set(key, now);

  const edits = countLeftOutLocalEdits(rootPath, branch);
  if (edits === null || (edits.dirtyFiles === 0 && edits.localOnlyCommits === 0)) return;
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
