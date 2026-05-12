/**
 * Daemon fetch poller — Phase 6.
 * Periodically runs `git fetch origin` for each project and queues an incremental
 * reindex whenever a pinned branch advances (SHA delta detection).
 *
 * Also backfills on startup: any pinned branch not yet present in branch-tags.db
 * is treated as "never indexed" and queued immediately.
 *
 * Active interval: SCRYBE_DAEMON_FETCH_ACTIVE_MS (default 5 min)
 * Idle interval:   SCRYBE_DAEMON_FETCH_IDLE_MS   (default 30 min)
 * Disable all fetching: SCRYBE_DAEMON_NO_FETCH=1
 */
import { listBranches, getLastIndexedSha, setLastIndexedSha } from "../branch-state.js";
import { gitExec, gitExecOrThrow } from "../util/git-exec.js";
import { getSource } from "../registry.js";
import { getState } from "./idle-state.js";
import { enqueue } from "./queue.js";
import type { DaemonEvent } from "./http-server.js";
import type { Project } from "../types.js";

// ─── Config ───────────────────────────────────────────────────────────────

const FETCH_ACTIVE_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_FETCH_ACTIVE_MS"] ?? "", 10);
  return v > 0 ? v : 5 * 60_000;
})();

const FETCH_IDLE_MS = (() => {
  const v = parseInt(process.env["SCRYBE_DAEMON_FETCH_IDLE_MS"] ?? "", 10);
  return v > 0 ? v : 30 * 60_000;
})();

const SKIP_FETCH = process.env["SCRYBE_DAEMON_NO_FETCH"] === "1";
const MAX_CONCURRENT = 2;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

// ─── Types ────────────────────────────────────────────────────────────────

interface PollerState {
  projectId: string;
  sourceId: string;
  rootPath: string;
  timer: ReturnType<typeof setTimeout> | null;
  retries: number;
  warnedMissing: Set<string>;
}

// ─── Module state ─────────────────────────────────────────────────────────

let _push: ((ev: DaemonEvent) => void) | null = null;
const _pollers = new Map<string, PollerState>();
let _activeFetches = 0;

// ─── Public API ───────────────────────────────────────────────────────────

export function initFetchPoller(opts: { pushEvent: (ev: DaemonEvent) => void }): void {
  _push = opts.pushEvent;
}

/** Start per-project fetch pollers. Runs an immediate cycle for backfill detection. */
export function startFetchPoller(projects: Project[]): void {
  if (SKIP_FETCH) return;
  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type !== "code") continue;
      const rootPath = (source.source_config as { type: "code"; root_path: string }).root_path;
      const key = `${project.id}:${source.source_id}`;
      const ps: PollerState = {
        projectId: project.id,
        sourceId: source.source_id,
        rootPath,
        timer: null,
        retries: 0,
        warnedMissing: new Set(),
      };
      _pollers.set(key, ps);
      schedulePoller(ps, 0); // run immediately for backfill + initial fetch
    }
  }
}

/** Stop all fetch pollers — call on daemon shutdown. */
export function stopFetchPoller(): void {
  for (const ps of _pollers.values()) {
    if (ps.timer) clearTimeout(ps.timer);
  }
  _pollers.clear();
  _activeFetches = 0;
}

// ─── Internal ─────────────────────────────────────────────────────────────

function schedulePoller(ps: PollerState, delayMs: number): void {
  if (ps.timer) clearTimeout(ps.timer);
  ps.timer = setTimeout(() => {
    ps.timer = null;
    runPoller(ps).catch(() => {});
  }, delayMs);
}

async function runPoller(ps: PollerState): Promise<void> {
  if (_activeFetches >= MAX_CONCURRENT) {
    // At concurrency cap — retry after a short pause
    schedulePoller(ps, 5_000);
    return;
  }
  _activeFetches++;
  try {
    await pollProject(ps);
    ps.retries = 0;
  } catch (err) {
    ps.retries++;
    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, ps.retries - 1), RETRY_MAX_MS);
    _push?.({
      ts: new Date().toISOString(),
      level: "warn",
      event: "watcher.event",
      projectId: ps.projectId,
      detail: { error: String(err), phase: "fetch-poller", retries: ps.retries },
    });
    schedulePoller(ps, delay);
    return;
  } finally {
    _activeFetches--;
  }
  const nextMs = getState() === "hot" ? FETCH_ACTIVE_MS : FETCH_IDLE_MS;
  schedulePoller(ps, nextMs);
}

async function pollProject(ps: PollerState): Promise<void> {
  const source = getSource(ps.projectId, ps.sourceId);
  if (!source) return;
  const pinned = source.pinned_branches ?? [];
  if (pinned.length === 0) return;

  // Observability counters for this cycle
  const branchesPolled = pinned.length;
  let deltasFound = 0;
  let outOfBandCount = 0;

  // shasBefore is telemetry-only — captures pre-fetch ref state to detect out-of-band fetches
  const shasBefore = new Map<string, string | null>();
  for (const branch of pinned) {
    shasBefore.set(branch, resolveRemoteSha(ps.rootPath, `origin/${branch}`));
  }

  // Which pinned branches have been indexed (used for bootstrap detection)
  const indexedBranches = new Set(listBranches(ps.projectId, ps.sourceId));

  try {
    gitExecOrThrow(["fetch", "origin", "--prune", "--quiet"], { cwd: ps.rootPath, timeout: 120_000 });
  } catch {
    throw new Error(`git fetch failed for ${ps.projectId}`);
  }

  // Queue reindex for branches that need it, using branch_state as the baseline
  const changed: string[] = [];
  for (const branch of pinned) {
    const remoteBranch = `origin/${branch}`;
    const shaAfter = resolveRemoteSha(ps.rootPath, remoteBranch);
    const shaBefore = shasBefore.get(branch) ?? null;

    if (shaAfter == null) {
      if (!ps.warnedMissing.has(branch)) {
        _push?.({
          ts: new Date().toISOString(),
          level: "warn",
          event: "watcher.event",
          projectId: ps.projectId,
          detail: { phase: "fetch-poller", missingRemote: remoteBranch },
        });
        ps.warnedMissing.add(branch);
      }
      continue;
    }

    const lastIndexedSha = getLastIndexedSha(ps.projectId, ps.sourceId, remoteBranch);

    if (lastIndexedSha === null) {
      if (indexedBranches.has(remoteBranch)) {
        // Bootstrap on upgrade: branch has chunks but no branch_state row yet.
        // Write current SHA as baseline; skip enqueue — nothing new to index.
        try {
          setLastIndexedSha(ps.projectId, ps.sourceId, remoteBranch, shaAfter);
        } catch { /* non-fatal */ }
        continue;
      }
      // Truly never indexed — preserve neverIndexed semantics.
      await enqueue({
        projectId: ps.projectId,
        sourceId: ps.sourceId,
        branch: remoteBranch,
        mode: "incremental",
      });
      changed.push(branch);
      deltasFound++;
      continue;
    }

    // lastIndexedSha is non-null — compare against shaAfter
    if (shaAfter !== lastIndexedSha) {
      // Out-of-band detection: shaBefore equals shaAfter means the daemon's own
      // fetch did NOT advance the ref this cycle — something else fetched first.
      if (shaBefore === shaAfter) {
        outOfBandCount++;
        _push?.({
          ts: new Date().toISOString(),
          level: "info",
          event: "watcher.event",
          projectId: ps.projectId,
          detail: { phase: "fetch-poller", outOfBandFetch: true, branch: remoteBranch, lastSha: lastIndexedSha, shaAfter },
        });
      }
      await enqueue({
        projectId: ps.projectId,
        sourceId: ps.sourceId,
        branch: remoteBranch,
        mode: "incremental",
      });
      changed.push(branch);
      deltasFound++;
    }
  }

  if (changed.length > 0) {
    _push?.({
      ts: new Date().toISOString(),
      level: "info",
      event: "watcher.event",
      projectId: ps.projectId,
      detail: { phase: "fetch-poller", shaChanged: changed },
    });
  }

  if (process.env["SCRYBE_DEBUG_FETCH_POLLER"] === "1") {
    _push?.({
      ts: new Date().toISOString(),
      level: "info",
      event: "watcher.event",
      projectId: ps.projectId,
      detail: { phase: "fetch-poller.tick", branchesPolled, deltasFound, outOfBandDetected: outOfBandCount },
    });
  }
}

function resolveRemoteSha(rootPath: string, ref: string): string | null {
  const sha = gitExec(["rev-parse", ref], { cwd: rootPath });
  return sha || null;
}
