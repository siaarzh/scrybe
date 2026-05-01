/**
 * Daemon FS watcher — Phase 4.
 * Uses @parcel/watcher for native FS events (ReadDirectoryChangesW on Windows,
 * FSEvents on macOS, inotify on Linux).
 *
 * Per-project:
 *   - Subscribes on the code source's root path
 *   - Coalesces events into a Set<relPath> during the debounce window
 *   - After debounce, emits watcher.event SSE + enqueues an incremental reindex
 *   - On error: exponential back-off with up to MAX_RETRIES retries;
 *     marks project watcher unhealthy after MAX_RETRIES consecutive failures
 */
import * as parcel from "@parcel/watcher";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ignore from "ignore";
import { getDebounceMs, touchActive } from "./idle-state.js";
import { enqueue } from "./queue.js";
import { loadPrivateIgnore } from "../private-ignore.js";
import type { DaemonEvent } from "./http-server.js";

// ─── Config ───────────────────────────────────────────────────────────────

const FS_DEBOUNCE_BASE_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_FS_DEBOUNCE_MS"] ?? "", 10);
  return v > 0 ? v : 1_500;
})();

const MAX_RETRIES = 10;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;

// Directories always excluded — passed as native ignore paths to parcel
const IGNORE_DIR_NAMES = [
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", ".nuxt", "coverage",
  ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "target", "bin", "obj", "vendor", ".vs",
  "android", "ios", "electron", "fastlane",
  "packages", "TestResults", "publish", "artifacts",
];

// CJS interop — `ignore` module.exports is the factory
type IgnoreManager = { add(p: string): void; ignores(p: string): boolean };
const createIgnore = ignore as unknown as () => IgnoreManager;

// ─── Types ────────────────────────────────────────────────────────────────

interface WatchState {
  projectId: string;
  sourceId: string | undefined;
  rootPath: string;
  sub: parcel.AsyncSubscription | null;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  retries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  healthy: boolean;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _push: ((ev: DaemonEvent) => void) | null = null;
const _watches = new Map<string, WatchState>();

// ─── Public API ───────────────────────────────────────────────────────────

/** Wire SSE emitter. Must be called before watchProject(). */
export function initWatcher(opts: { pushEvent: (ev: DaemonEvent) => void }): void {
  _push = opts.pushEvent;
}

/** Returns per-project watcher health (true = subscribed and healthy). */
export function getWatcherHealth(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [id, ws] of _watches) out.set(id, ws.healthy);
  return out;
}

/** Start watching a project's root path. No-op if already watching. */
export async function watchProject(projectId: string, rootPath: string, sourceId?: string): Promise<void> {
  if (_watches.has(projectId)) return;
  const ws: WatchState = {
    projectId, sourceId, rootPath,
    sub: null, pending: new Set(),
    timer: null, retries: 0, retryTimer: null, healthy: false,
  };
  _watches.set(projectId, ws);
  await subscribe(ws);
}

/** Stop watching a project and clean up its timers. */
export async function unwatchProject(projectId: string): Promise<void> {
  const ws = _watches.get(projectId);
  if (!ws) return;
  _watches.delete(projectId);
  if (ws.retryTimer) clearTimeout(ws.retryTimer);
  if (ws.timer) clearTimeout(ws.timer);
  await ws.sub?.unsubscribe().catch(() => {});
}

/** Stop all project watchers — call on daemon shutdown. */
export async function stopWatcher(): Promise<void> {
  await Promise.all([..._watches.keys()].map(unwatchProject));
}

// ─── Internal ─────────────────────────────────────────────────────────────

function buildIgnoreFilter(rootPath: string, projectId?: string, sourceId?: string): (rel: string) => boolean {
  const mgr = createIgnore();
  for (const f of [".gitignore", ".scrybeignore"]) {
    const p = join(rootPath, f);
    if (existsSync(p)) {
      try { mgr.add(readFileSync(p, "utf8")); } catch { /* non-fatal */ }
    }
  }
  // Private ignore from DATA_DIR
  if (projectId && sourceId) {
    const privateContent = loadPrivateIgnore(projectId, sourceId);
    if (privateContent) {
      try { mgr.add(privateContent); } catch { /* non-fatal */ }
    }
  }
  return (rel) => {
    try { return mgr.ignores(rel); } catch { return false; }
  };
}

function buildNativeIgnore(rootPath: string): string[] {
  return IGNORE_DIR_NAMES.map((d) => join(rootPath, d));
}

async function subscribe(ws: WatchState): Promise<void> {
  const isIgnored = buildIgnoreFilter(ws.rootPath, ws.projectId, ws.sourceId);
  try {
    ws.sub = await parcel.subscribe(
      ws.rootPath,
      (err, events) => {
        if (err) { handleError(ws, err); return; }
        for (const ev of events) {
          const rel = relative(ws.rootPath, ev.path).replace(/\\/g, "/");
          if (!rel || rel.startsWith("..") || isIgnored(rel)) continue;
          ws.pending.add(rel);
        }
        if (ws.pending.size > 0) scheduleFlush(ws);
      },
      { ignore: buildNativeIgnore(ws.rootPath) },
    );
    ws.healthy = true;
    ws.retries = 0;
  } catch (err) {
    handleError(ws, err instanceof Error ? err : new Error(String(err)));
  }
}

function scheduleFlush(ws: WatchState): void {
  touchActive();
  if (ws.timer) clearTimeout(ws.timer);
  ws.timer = setTimeout(() => {
    ws.timer = null;
    const paths = [...ws.pending];
    ws.pending.clear();

    _push?.({
      ts: new Date().toISOString(),
      level: "info",
      event: "watcher.event",
      projectId: ws.projectId,
      detail: { paths, count: paths.length },
    });

    enqueue({ projectId: ws.projectId, mode: "incremental" }).catch(() => {
      // queue may be stopped during shutdown — swallow silently
    });
  }, getDebounceMs(FS_DEBOUNCE_BASE_MS));
}

function handleError(ws: WatchState, err: Error): void {
  ws.healthy = false;
  ws.sub?.unsubscribe().catch(() => {});
  ws.sub = null;

  process.stderr.write(`[scrybe watcher] ${ws.projectId}: ${err.message}\n`);

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
      error: { message: `Watcher gave up after ${MAX_RETRIES} retries: ${err.message}` },
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
