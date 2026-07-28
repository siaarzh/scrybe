import { appendFileSync, createWriteStream, existsSync, mkdirSync, writeSync } from "fs";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { closeDB } from "../branch-state.js";
import { cancelAllJobs } from "../jobs.js";
import { checkAndMigrate } from "../schema-version.js";
import { VERSION, config, warnOldEnvVars } from "../config.js";
import { writePidfile, removePidfile } from "./pidfile.js";
import { acquireDataDirOwnership, releaseDataDirOwnership, acquireSpawnLock, releaseSpawnLock } from "./data-dir-lock.js";
import type { AcquireResult } from "./data-dir-lock.js";
import { startHttpServer, stopHttpServer, pushEvent, setDaemonState, setDraining, setClosing } from "./http-server.js";
import { initQueue, submitToQueue, stopQueue, onQueueJobEvent, getActiveReindexCount } from "./queue.js";
import { initWatcher, watchProject, stopWatcher } from "./watcher.js";
import { initGitWatcher, watchGitProject, stopGitWatcher } from "./git-watcher.js";
import { initFetchPoller, startFetchPoller, stopFetchPoller } from "./fetch-poller.js";
import { initTicketPoller, startTicketPoller, stopTicketPoller, ticketPollerOnHot, ticketPollerOnJobEvent } from "./ticket-poller.js";
import { onStateChange } from "./idle-state.js";
import { diagEmit } from "./events.js";
import { startMemSampler, stopMemSampler, MEM_SAMPLE_INTERVAL_MS } from "./mem-sampler.js";
import { startRssGuard, stopRssGuard } from "./rss-guard.js";
import { startBuildIntegrityCheck } from "./build-integrity.js";
import { spawnDaemonDetached } from "./spawn-detached.js";
import { listProjects, onProjectRemoved } from "../registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { rotateIfNeeded } from "./log-rotate.js";
import { initAutoGc, evaluateRatioTrigger } from "./auto-gc.js";
import { initVectorIndexBackfill } from "./vector-index-backfill.js";
import { migrateModelsCache } from "./migrate-models-cache.js";
import type { KickRequest, KickResponse } from "./http-server.js";

let shutdownCalled = false;
/** Set by shutdown() when this exit owes the world a replacement daemon (review G9). */
let _respawnOwed = false;
let _lifecycle: LifecycleManager | null = null;
let _logWrite: ((line: string) => void) | null = null;
let _stopBuildIntegrityCheck: (() => void) | null = null;

function daemonLog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(line);
  _logWrite?.(line);
}

/**
 * Shutdown drain loop — exported for unit testing.
 *
 * While a reindex job is active the drain defers (re-checks every `pollMs`)
 * rather than force-exiting at a fixed 30s cap. Non-reindex active jobs are
 * allowed up to `nonReindexCapMs` (legacy 30s intent). The hard cap
 * `maxWaitMs` (SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS, default 30min) bounds the
 * total defer for reindex jobs; past it the function returns and the caller
 * force-exits (the orphaned job is reconciled to `interrupted` on next boot).
 *
 * Returns true if drained cleanly (active === 0), false if capped out.
 */
export async function runShutdownDrain(opts: {
  getActiveReindexCount: () => number;
  getQueueStats: () => { active: number };
  maxWaitMs: number;
  nonReindexCapMs?: number;
  pollMs?: number;
  onForceExit?: (activeJobs: number) => void;
}): Promise<boolean> {
  const {
    getActiveReindexCount,
    getQueueStats,
    maxWaitMs,
    nonReindexCapMs = 30_000,
    pollMs = 200,
    onForceExit,
  } = opts;

  const drainStart = Date.now();

  while (true) {
    const stats = getQueueStats();
    if (stats.active === 0) return true;

    const elapsed = Date.now() - drainStart;
    const reindexActive = getActiveReindexCount() > 0;

    if (reindexActive) {
      // Defer up to the hard cap
      if (elapsed >= maxWaitMs) {
        onForceExit?.(stats.active);
        return false;
      }
    } else {
      // Non-reindex active work: original 30s cap applies
      if (elapsed >= nonReindexCapMs) {
        onForceExit?.(stats.active);
        return false;
      }
    }

    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

async function shutdown(signal: string, opts?: {
  /**
   * Override the drain cap for this shutdown.
   * Defaults to `config.daemonShutdownMaxWaitMs` (30 min) for SIGTERM/SIGINT/user stop.
   * RSS-guard restart path passes `config.daemonRestartDrainMs` (2 s default) instead.
   */
  drainCapMs?: number;
  /**
   * When true, spawn a replacement daemon via spawnDaemonDetached() strictly AFTER
   * removePidfile() and before process.exit(). Used in always-on mode for RSS-guard
   * restarts so the replacement is never racing the pidfile lock.
   */
  spawnAfterRemovePidfile?: boolean;
}): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;

  // Review F1: when this shutdown owes the world a replacement daemon
  // (RSS-guard always-on path), take the spawn lock HERE — before the drain,
  // before ownership is released — and hold it across the entire
  // drain → release-ownership → respawn sequence.
  //
  // The previous shape acquired it late and SKIPPED the respawn when it read
  // "contended". That was unsound: the contender is typically a caller that
  // already tried to spawn a daemon while WE still held ownership, so its
  // daemon exited(0) on contended ownership. Skipping then left ZERO daemons —
  // and since this process exits 0, systemd's `Restart=on-failure` never
  // resurrects it. A guaranteed respawn racing into a harmless duplicate (the
  // loser exits via the ownership lock) is strictly better than a silent
  // outage, so there is no skip path at all now.
  const willRespawn = !!opts?.spawnAfterRemovePidfile;
  // Review G9: publish the owed respawn so the ESCALATION path (a second
  // SIGTERM arriving mid-drain) can honour it too. A SIGTERM landing inside the
  // rss-guard's 2 s drain window on an always-on daemon otherwise killed it
  // with no replacement — and since escalation exits 0, systemd's
  // `Restart=on-failure` never resurrects it.
  _respawnOwed = willRespawn;
  const spawnLock: AcquireResult | null = willRespawn ? acquireSpawnLock() : null;

  _lifecycle?.stop();
  stopRssGuard();
  stopMemSampler();
  _stopBuildIntegrityCheck?.();
  daemonLog(`[scrybe daemon] ${signal} — shutting down`);
  // Review F7: do NOT close the HTTP listener yet. The pidfile and data-dir
  // ownership both survive until the very end of this function, so closing the
  // listener first makes the daemon look dead-but-locked for the whole drain.
  // Instead flip to drain mode: /health keeps answering 200 (pidfile.ts
  // SIGKILLs on any non-2xx) while every other endpoint returns 503, so no new
  // work is accepted. stopHttpServer() runs just before removePidfile() below.
  setDraining(true);
  await stopWatcher();
  await stopGitWatcher();
  stopFetchPoller();
  stopTicketPoller();

  const drainCapMs = opts?.drainCapMs ?? config.daemonShutdownMaxWaitMs;

  try {
    const { getQueueStats } = await import("./queue.js");
    const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");

    const drained = await runShutdownDrain({
      getActiveReindexCount,
      getQueueStats,
      maxWaitMs: drainCapMs,
      onForceExit: (activeJobs) => {
        daemonLog(`[scrybe daemon] shutdown cap hit — ${activeJobs} job(s) still active, force-stopping`);
        try {
          appendFileSync(
            logPath,
            JSON.stringify({ ts: new Date().toISOString(), event: "gc.force-killed", detail: { activeJobs } }) + "\n",
            "utf8"
          );
        } catch { /* ignore */ }
      },
    });

    if (!drained) {
      // force-exit path already logged above
    }
  } catch { /* non-fatal — drain must not block exit */ }

  // Phase 2 (review G1): from here the queue is stopping and the DB is about to
  // close, so nothing below /health is safe to serve any more. Up to this point
  // the drain gate refused only work-accepting routes — reads and /mcp/rpc
  // search kept working against the still-open DB, which is the whole point of
  // splitting the flag in two.
  setClosing(true);
  stopQueue();
  cancelAllJobs();
  closeDB();

  // Only now stop serving (review F7) — the listener stayed up, in drain mode,
  // for the whole drain above so callers could see a live-but-draining daemon
  // instead of a locked ghost.
  await stopHttpServer();
  removePidfile();

  // Release ownership before any replacement is spawned — otherwise the
  // replacement can never acquire and the daemon disappears entirely.
  releaseDataDirOwnership();

  if (willRespawn) {
    // Pidfile is gone — replacement can now acquire the lock cleanly. This is
    // unconditional on purpose (see the spawn-lock comment at the top of this
    // function): a duplicate is self-healing, zero daemons is not.
    try { spawnDaemonDetached({}); } catch (err) {
      daemonLog(`[scrybe daemon] rss-guard respawn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (spawnLock?.outcome === "acquired") releaseSpawnLock();

  process.exit(0);
}

async function kickHandler(req: KickRequest): Promise<KickResponse> {
  const projects = req.projectId
    ? [{ id: req.projectId }]
    : listProjects();

  const jobs = projects.map((p) => {
    const result = submitToQueue({
      projectId: p.id,
      sourceId: req.sourceId,
      branch: req.branch,
      contentRef: req.contentRef,
      mode: req.mode,
    });
    return {
      jobId: result.jobId,
      projectId: p.id,
      sourceId: req.sourceId ?? "all",
      branch: req.branch ?? "HEAD",
      status: result.status,
      queuePosition: result.queuePosition,
      duplicateOfPending: result.duplicateOfPending,
    };
  });

  return { jobs };
}

/**
 * Long-running daemon entry point.
 * Phase 1: pidfile management + signal handlers.
 * Phase 2: HTTP server — port written to pidfile so clients can discover it.
 * Phase 3: Job queue with concurrency limiter + JSONL durable log.
 * Phase 4: FS watcher per project + HOT/COLD idle state machine.
 * Phase 5+: Git ref watcher, fetch poller.
 */
export async function runDaemon(): Promise<void> {
  // Claim data-dir ownership before the HTTP server binds or the pidfile is
  // written, so a second daemon exits(0) within milliseconds of starting
  // rather than serving from a second port.
  //
  // Review F17c: this is NOT what protects `checkAndMigrate()`. By the time
  // `daemon start` reaches here, `runCli()` has ALREADY run checkAndMigrate()
  // at the top of the CLI (`cli.ts`), long before dispatching to this
  // subcommand. The destructive migration is serialised by its own MIGRATE
  // lock inside `checkAndMigrate()` — ordering with respect to ownership is
  // irrelevant to it.
  //
  // The mkdirSync is kept because the rest of startup (logs, pidfile) needs
  // the dir; the locks no longer depend on it — `acquire()` mkdirs for itself
  // (review F9), which is what covers the CLI and MCP entry points too.
  mkdirSync(config.dataDir, { recursive: true });
  const ownership = acquireDataDirOwnership();
  if (ownership.outcome === "contended") {
    diagEmit({
      level: "warn",
      event: "daemon.ownership.contended",
      dataDir: config.dataDir,
      heldByPid: ownership.heldByPid ?? null,
    });
    process.exit(0);
  }
  if (ownership.outcome === "unavailable") {
    // Fail-open: a permissions/disk fault must not brick every daemon. The
    // data dir is left unprotected for this run, but the daemon still starts.
    diagEmit({
      level: "error",
      event: "daemon.ownership.unavailable",
      dataDir: config.dataDir,
      errorCode: ownership.error?.code ?? null,
      errorMessage: ownership.error?.message ?? null,
    });
  }

  const writeCrashEv = (event: string, err: unknown): void => {
    try {
      diagEmit({
        level: "error",
        event,
        error: {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack ?? null : null,
          name: err instanceof Error ? err.name : null,
        },
      });
    } catch { /* non-fatal */ }
    try { writeSync(2, `[scrybe daemon] ${event}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (err) => {
    writeCrashEv("process.uncaughtException", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    writeCrashEv("process.unhandledRejection", reason);
  });

  await checkAndMigrate();

  // Move old in-package @xenova/transformers model cache to DATA_DIR/models/ (Plan 66).
  // Best-effort: absent old cache is a silent no-op; failures are logged and non-fatal.
  await migrateModelsCache(config.dataDir, daemonLog);

  // Warn about old env var names that can't be rewritten by the .env migration
  // (they came from OS env or MCP server config).
  warnOldEnvVars();

  // Warn if .env was previously loaded from the scrybe repo root (no longer read).
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const legacyEnvPath = join(scriptDir, "..", "..", ".env"); // dist/daemon/../.. → repo root
  if (existsSync(legacyEnvPath)) {
    process.stderr.write(
      `[scrybe] found .env in scrybe repo root (${legacyEnvPath}); this path is no longer read. ` +
      `Move keys to ${config.dataDir}/.env if you want them honoured.\n`
    );
  }

  // Set up log file
  const logsDir = join(config.dataDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(logsDir, "daemon.log");
  rotateIfNeeded(logPath);
  const logStream = createWriteStream(logPath, { flags: "a" });
  _logWrite = (line) => { try { logStream.write(line); } catch { /* ignore */ } };

  const lifecycle = new LifecycleManager({ getActiveReindexCount });
  _lifecycle = lifecycle;

  const startedAt = new Date();

  const { port } = await startHttpServer({
    startedAt,
    onShutdown: () => { shutdown("HTTP /shutdown").catch(() => {}); },
    onKick: kickHandler,
    onHeartbeat: (clientId, pid) => lifecycle.registerOrUpdate({ clientId, pid }),
    onUnregister: (clientId) => lifecycle.unregister(clientId),
    getClientCount: () => lifecycle.getClientCount(),
    getMode: () => lifecycle.isAlwaysOn() ? "always-on" : "on-demand",
    getGracePeriodRemainingMs: () => lifecycle.gracePeriodRemainingMs(),
  });

  lifecycle.on("shutdown", (reason) => {
    daemonLog(`[scrybe daemon] no active clients (${reason}) — shutting down`);
    shutdown(reason).catch(() => {});
  });
  lifecycle.start();

  // Wire queue → SSE ring buffer (must happen after startHttpServer exports pushEvent)
  initQueue({ pushEvent });

  // Wire auto-gc triggers (must happen after initQueue)
  const autoGcTracker = initAutoGc({ pushEvent });

  // Wire vector-index idle backfill (Plan 95 Phase 3) — same idle-scheduling shape as auto-gc
  const vectorIndexBackfillTracker = initVectorIndexBackfill({ pushEvent });

  // A1/A2: when a project is removed, emit SSE event + cancel its idle-gc timer
  onProjectRemoved((projectId, jobsCancelled) => {
    autoGcTracker.cancel(projectId);
    vectorIndexBackfillTracker.cancel(projectId);
    pushEvent({
      ts: new Date().toISOString(),
      level: "info",
      event: "project.removed",
      projectId,
      detail: { jobsCancelled },
    });
  });

  // Wire queue job events → ratio trigger evaluation
  onQueueJobEvent((projectId, _jobId, eventType, req) => {
    if (eventType === "completed" && (req.type ?? "reindex") === "reindex") {
      evaluateRatioTrigger(projectId, req.sourceId).catch(() => { /* non-fatal */ });
    }
  });

  // D2 hook 1: reconcile ticket pollers when a reindex job is submitted for a ticket source.
  // This ensures a source added via add_source (which always enqueues immediately) is picked
  // up by the poller within the same second, without waiting for a daemon restart.
  onQueueJobEvent(ticketPollerOnJobEvent);

  // Wire FS + git watchers + fetch poller + ticket poller → SSE + queue
  initWatcher({ pushEvent });
  initGitWatcher({ pushEvent });
  initFetchPoller({ pushEvent });
  initTicketPoller({ pushEvent });

  // Mirror idle-state HOT/COLD transitions to HTTP /status;
  // also fire a catch-up poll for ticket sources on cold→hot.
  onStateChange((s) => {
    setDaemonState(s);
    if (s === "hot") ticketPollerOnHot();
  });

  // Start per-project FS + git watchers + fetch pollers (code sources only)
  const projects = listProjects();
  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type === "code") {
        const rootPath = (source.source_config as { type: "code"; root_path: string }).root_path;
        await watchProject(project.id, rootPath, source.source_id);
        await watchGitProject(project.id, rootPath);
        break; // one code source per project for now
      }
    }
  }
  startFetchPoller(projects);
  startTicketPoller(projects);

  // Startup ephemeral-branch sweep (Plan 99 Slice 5): reclaims leaked
  // `_ephemeral/*` labels left behind by a crashed/forgotten drop_ephemeral
  // caller. Startup-only — never on a timer, never mid-run. Runs in the
  // background — must not block startup or crash the daemon.
  void (async () => {
    try {
      const { sweepEphemeralBranches } = await import("./ephemeral-sweep.js");
      const swept = await sweepEphemeralBranches(projects);
      if (swept.length > 0) {
        daemonLog(
          `[scrybe daemon] ephemeral sweep: reclaimed ${swept.length} leaked ` +
          `'_ephemeral/*' label(s): ${swept.map((s) => `${s.projectId}/${s.sourceId}:${s.label}`).join(", ")}`
        );
        pushEvent({
          ts: new Date().toISOString(),
          level: "info",
          event: "ephemeral.swept",
          detail: { count: swept.length, entries: swept },
        });
      }
    } catch (err) {
      // non-fatal — the sweep must never crash daemon startup
      daemonLog(`[scrybe daemon] ephemeral sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  // Startup health probe: runs in parallel across all sources, pre-populates the
  // health cache, and emits a health.corrupt event for any flagged sources.
  // Runs in background — never blocks startup.
  void (async () => {
    try {
      const { getTableHealth } = await import("../vector-store.js");
      const { getExpectedDimensions } = await import("../health-probe.js");
      const { resolveEmbeddingConfig, assignTableName } = await import("../registry.js");
      const { getPlugin } = await import("../plugins/index.js");
      const allProjects = listProjects();
      await Promise.all(
        allProjects.flatMap((project) =>
          project.sources.map(async (sourceRaw) => {
            try {
              const source = assignTableName(project.id, sourceRaw);
              const tableName = source.table_name;
              if (!tableName) return;
              const embConfig = resolveEmbeddingConfig(source);
              let pluginProfile: "code" | "knowledge" = "code";
              try {
                const plugin = getPlugin(source.source_config.type);
                pluginProfile = plugin.embeddingProfile === "code" ? "code" : "knowledge";
              } catch { /* unknown plugin — default to code */ }
              const expectedDimensions = getExpectedDimensions(pluginProfile) ?? embConfig.dimensions;
              const result = await getTableHealth(tableName, { force: true, expectedDimensions });
              if (result.state === "corrupt") {
                const ev = {
                  ts: new Date().toISOString(),
                  level: "warn" as const,
                  event: "health.corrupt" as const,
                  projectId: project.id,
                  sourceId: source.source_id,
                  detail: {
                    tableName,
                    reasons: result.reasons,
                    details: result.details,
                  },
                };
                pushEvent(ev);
                try {
                  const { appendFileSync } = await import("fs");
                  const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
                  appendFileSync(logPath, JSON.stringify(ev) + "\n", "utf8");
                } catch { /* non-fatal */ }
              }
            } catch { /* non-fatal — probe must not crash daemon */ }
          })
        )
      );
    } catch { /* non-fatal */ }
  })();

  // Embedding migration scan: runs once per cold start after queue + watchers are wired.
  // Auto-enqueues full reindex for local-preset sources with schema version < 2 that
  // are below the 50k-chunk threshold. Larger sources go into awaiting_user_confirm
  // (visible via queue_status). Voyage/OpenAI sources are skipped entirely.
  // Runs in background — never blocks startup.
  void (async () => {
    try {
      const { runEmbeddingMigrationScan } = await import("./embedding-migration-scan.js");
      const awaiting = await runEmbeddingMigrationScan();
      if (awaiting.length > 0) {
        daemonLog(
          `[scrybe daemon] embedding migration scan: ${awaiting.length} large source(s) need manual reindex ` +
          `(call mcp__scrybe__reindex_source for each)`
        );
      }
    } catch (err) {
      // Non-fatal — migration scan must not crash the daemon
      process.stderr.write(
        `[scrybe daemon] embedding migration scan failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  })();

  writePidfile({
    pid: process.pid,
    port,
    startedAt: startedAt.toISOString(),
    version: VERSION,
    dataDir: config.dataDir,
    execPath: process.execPath,
  });

  // Plan 108 slice 4: SIGTERM escalation. The FIRST SIGTERM/SIGINT starts the
  // normal drain (up to config.daemonShutdownMaxWaitMs, 30 min default — left
  // unchanged, it is correct for a genuine shutdown with a real reindex in
  // flight). A SECOND SIGTERM/SIGINT arriving while that drain is already in
  // progress means the operator (or an orphan-reaping script) has already
  // asked once and is not willing to wait — escalate to an immediate exit
  // instead of re-entering shutdown().
  //
  // `shutdownCalled` is the existing re-entrancy guard inside shutdown() —
  // reused here as the "is a shutdown already in progress" signal rather than
  // a separate counter, since shutdown()'s synchronous prefix (lines through
  // the first `await`) sets it before yielding back to the event loop, so by
  // the time a second signal is handled it is reliably true. Checking it
  // BEFORE calling shutdown() means the second signal never re-enters
  // teardown (the guard itself is untouched) — it escalates around it.
  const handleTerminationSignal = (signal: "SIGTERM" | "SIGINT"): void => {
    if (shutdownCalled) {
      daemonLog(`[scrybe daemon] ${signal} received again while shutting down — forcing immediate exit`);
      diagEmit({
        level: "warn",
        event: "daemon.shutdown.escalated",
        signal,
      });
      // Review F3: exit 0, NOT 1. `linux-systemd.ts` installs the unit with
      // `Type=simple` + `Restart=on-failure` + `RestartSec=5`, so a non-zero
      // exit makes systemd resurrect the daemon 5 s later — inverting the
      // intent of the very case this path exists for (a double `kill -TERM`
      // from an orphan-reaping script). The operator asked for this exit; it is
      // not a failure. (`SuccessExitStatus=1` is the wrong lever: exit 1 is a
      // genuine startup-failure code elsewhere and must stay restartable.)
      //
      // Best-effort artifact cleanup first: the normal shutdown path never
      // reaches removePidfile()/releaseDataDirOwnership() when we jump the
      // queue like this, and a stranded owner lock is exactly the permanent
      // silent outage this plan is trying to eliminate.
      try { removePidfile(); } catch { /* best effort */ }
      try { releaseDataDirOwnership(); } catch { /* best effort */ }
      // Review G9: honour an owed replacement. `shutdown()` reads `willRespawn`
      // at the top and respawns at the bottom; jumping the queue past it on an
      // always-on rss-guard restart would leave ZERO daemons, and an exit 0
      // means `Restart=on-failure` will not resurrect one.
      if (_respawnOwed) {
        try { spawnDaemonDetached({}); } catch (err) {
          daemonLog(`[scrybe daemon] escalated-exit respawn failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      process.exit(0);
      return;
    }
    shutdown(signal).catch(() => {});
  };
  // The generic CLI entry (src/index.ts) registers its own blanket
  // SIGTERM/SIGINT listener BEFORE dispatching to `daemon start`/`daemon
  // restart` — a convenience for one-shot commands (e.g. `scrybe index -f`)
  // to cancel in-flight jobs on Ctrl+C. Node invokes same-event listeners in
  // registration order, and that earlier listener calls process.exit(0)
  // synchronously, which terminates the process before a LATER listener
  // (ours, below) ever runs. Left alone, that earlier handler wins on every
  // signal, unconditionally, and the drain/escalation logic added above is
  // unreachable dead code. Verified via a two-listener repro (first listener
  // calling process.exit() prevents the second from firing at all).
  // Once we are the daemon, we are the sole authority over our own lifetime —
  // clear any pre-existing listeners for these signals before installing
  // ours so this handler is guaranteed to be the one that runs.
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
  process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

  daemonLog(`[scrybe daemon] started pid=${process.pid} port=${port} dataDir=${config.dataDir}`);

  // Arm periodic RSS+heap sampler (Plan 92 Phase 1).
  // Timer is .unref()-ed inside startMemSampler so it does not keep the process alive.
  // Interval: SCRYBE_DAEMON_MEM_SAMPLE_MS (default 60000 ms).
  startMemSampler();

  // Arm build-integrity self-check (Plan 101 Phase 1/2). Detects the daemon's
  // own build vanishing out from under it (e.g. a deleted worktree). Timer is
  // .unref()-ed; interval is a plain default parameter, not an env var.
  _stopBuildIntegrityCheck = startBuildIntegrityCheck();

  // Arm RSS-threshold self-restart guard (Plan 92 Phase 2).
  // Evaluated on the same cadence as the mem-sampler.
  // Soft ceiling: SCRYBE_DAEMON_MAX_RSS_MB (default 1536 MB) — idle-gated.
  // Hard ceiling: SCRYBE_DAEMON_MAX_RSS_HARD_MB (default 3072 MB) — unconditional.
  {
    const { getQueueStats } = await import("./queue.js");
    startRssGuard(MEM_SAMPLE_INTERVAL_MS, {
      getQueueStats,
      doRestart: (reason) => {
        daemonLog(`[scrybe daemon] rss-guard triggering self-restart (${reason})`);
        // Shutdown-first ordering: close HTTP listener, drain briefly, remove
        // pidfile, then optionally respawn (always-on only). No spawn before
        // pidfile release — avoids the replacement bailing "already running".
        shutdown(`rss-guard:${reason}`, {
          drainCapMs: config.daemonRestartDrainMs,
          spawnAfterRemovePidfile: _lifecycle?.isAlwaysOn() ?? false,
        }).catch(() => {});
      },
    });
  }

  // Never resolves — HTTP server + queue keep event loop alive until signal/shutdown
  await new Promise<never>(() => {});
}
