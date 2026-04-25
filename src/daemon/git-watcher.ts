/**
 * Daemon git ref watcher — Phase 5.
 * Subscribes on each project's .git/ directory (resolved to handle worktree symlinks).
 * Watches HEAD, refs/heads/**, refs/remotes/**, packed-refs, FETCH_HEAD.
 *
 * On any change the watcher debounces 300 ms (configurable), then:
 *   - Reads current branch via resolveBranchForPath()
 *   - If branch changed since last tick → emit watcher.event(branchChanged=true)
 *   - Enqueues an incremental reindex (indexer picks up new HEAD at job start)
 *
 * FETCH_HEAD changes are logged in the SSE event for Phase 6 (fetch poller)
 * but do NOT trigger a reindex in this phase.
 *
 * Error handling mirrors watcher.ts: exponential back-off, MAX_RETRIES,
 * watcher.unhealthy SSE event on exhaustion.
 */
import * as parcel from "@parcel/watcher";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveBranchForPath } from "../branch-state.js";
import { enqueue } from "./queue.js";
import { touchActive } from "./idle-state.js";
import type { DaemonEvent } from "./http-server.js";

// ─── Config ───────────────────────────────────────────────────────────────

const GIT_DEBOUNCE_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_GIT_DEBOUNCE_MS"] ?? "", 10);
  return v > 0 ? v : 300;
})();

const MAX_RETRIES = 10;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;

// ─── Types ────────────────────────────────────────────────────────────────

interface GitWatchState {
  projectId: string;
  rootPath: string;
  gitDir: string;
  sub: parcel.AsyncSubscription | null;
  lastBranch: string;
  timer: ReturnType<typeof setTimeout> | null;
  retries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  healthy: boolean;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _push: ((ev: DaemonEvent) => void) | null = null;
const _watches = new Map<string, GitWatchState>();

// ─── Public API ───────────────────────────────────────────────────────────

/** Wire SSE emitter. Must be called before watchGitProject(). */
export function initGitWatcher(opts: { pushEvent: (ev: DaemonEvent) => void }): void {
  _push = opts.pushEvent;
}

/** Returns per-project git watcher health (true = subscribed and healthy). */
export function getGitWatcherHealth(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [id, ws] of _watches) out.set(id, ws.healthy);
  return out;
}

/** Returns the last observed branch for a project (cached, no subprocess). */
export function getCachedBranch(projectId: string): string | null {
  return _watches.get(projectId)?.lastBranch ?? null;
}

/**
 * Start watching a project's .git/ directory.
 * No-op if already watching or if the root is not a git repo.
 */
export async function watchGitProject(projectId: string, rootPath: string): Promise<void> {
  if (_watches.has(projectId)) return;
  const gitDir = resolveGitDir(rootPath);
  if (!gitDir) return; // not a git repo — silently skip
  const ws: GitWatchState = {
    projectId, rootPath, gitDir,
    sub: null, lastBranch: resolveBranchForPath(rootPath),
    timer: null, retries: 0, retryTimer: null, healthy: false,
  };
  _watches.set(projectId, ws);
  await subscribe(ws);
}

/** Stop watching a project's git dir and clean up timers. */
export async function unwatchGitProject(projectId: string): Promise<void> {
  const ws = _watches.get(projectId);
  if (!ws) return;
  _watches.delete(projectId);
  if (ws.retryTimer) clearTimeout(ws.retryTimer);
  if (ws.timer) clearTimeout(ws.timer);
  await ws.sub?.unsubscribe().catch(() => {});
}

/** Stop all git watchers — call on daemon shutdown. */
export async function stopGitWatcher(): Promise<void> {
  await Promise.all([..._watches.keys()].map(unwatchGitProject));
}

// ─── Internal ─────────────────────────────────────────────────────────────

/**
 * Resolves the real .git/ directory path.
 * Handles three cases: plain directory, symlink (worktree), and gitdir file (worktree).
 */
function resolveGitDir(rootPath: string): string | null {
  const gitPath = join(rootPath, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const stat = lstatSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (stat.isSymbolicLink()) return realpathSync(gitPath);
    if (stat.isFile()) {
      // git worktree: .git file contains "gitdir: /path/to/actual/.git/worktrees/X"
      const content = readFileSync(gitPath, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(content);
      if (match) {
        const resolved = resolve(rootPath, match[1].trim());
        return existsSync(resolved) ? resolved : null;
      }
    }
  } catch { /* ignore — treat as non-git */ }
  return null;
}

function isWatchedRef(relToGit: string): boolean {
  if (relToGit === "HEAD" || relToGit === "packed-refs") return true;
  if (relToGit === "FETCH_HEAD" || relToGit === "ORIG_HEAD") return true;
  if (relToGit.startsWith("refs/heads/") || relToGit.startsWith("refs/remotes/")) return true;
  return false;
}

async function subscribe(ws: GitWatchState): Promise<void> {
  try {
    ws.sub = await parcel.subscribe(
      ws.gitDir,
      (err, events) => {
        if (err) { handleError(ws, err); return; }
        const relevant = events.some((ev) => {
          const rel = relative(ws.gitDir, ev.path).replace(/\\/g, "/");
          return isWatchedRef(rel);
        });
        if (relevant) scheduleFlush(ws);
      },
      // No ignore needed: .git/ is small and already isolated
    );
    ws.healthy = true;
    ws.retries = 0;
  } catch (err) {
    handleError(ws, err instanceof Error ? err : new Error(String(err)));
  }
}

function scheduleFlush(ws: GitWatchState): void {
  if (ws.timer) clearTimeout(ws.timer);
  ws.timer = setTimeout(() => flush(ws), GIT_DEBOUNCE_MS);
}

function flush(ws: GitWatchState): void {
  ws.timer = null;
  const branch = resolveBranchForPath(ws.rootPath);
  const branchChanged = branch !== ws.lastBranch;
  const prevBranch = ws.lastBranch;
  ws.lastBranch = branch;

  touchActive();

  _push?.({
    ts: new Date().toISOString(),
    level: "info",
    event: "watcher.event",
    projectId: ws.projectId,
    detail: { branch, branchChanged, ...(branchChanged ? { prevBranch } : {}) },
  });

  enqueue({ projectId: ws.projectId, mode: "incremental" }).catch(() => {
    // queue may be stopped during shutdown
  });
}

function handleError(ws: GitWatchState, err: Error): void {
  ws.healthy = false;
  ws.sub?.unsubscribe().catch(() => {});
  ws.sub = null;

  process.stderr.write(`[scrybe git-watcher] ${ws.projectId}: ${err.message}\n`);

  _push?.({
    ts: new Date().toISOString(),
    level: "warn",
    event: "watcher.event",
    projectId: ws.projectId,
    detail: { error: err.message, retries: ws.retries },
  });

  if (ws.retries >= MAX_RETRIES) {
    _push?.({
      ts: new Date().toISOString(),
      level: "error",
      event: "watcher.unhealthy",
      projectId: ws.projectId,
      error: { message: `Git watcher gave up after ${MAX_RETRIES} retries: ${err.message}` },
    });
    return;
  }

  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, ws.retries), RETRY_MAX_MS);
  ws.retries++;
  ws.retryTimer = setTimeout(() => {
    ws.retryTimer = null;
    if (_watches.has(ws.projectId)) subscribe(ws).catch(() => {});
  }, delay);
}
