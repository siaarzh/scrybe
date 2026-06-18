import { appendFileSync, createWriteStream, existsSync, writeSync } from "fs";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { closeDB } from "../branch-state.js";
import { cancelAllJobs } from "../jobs.js";
import { checkAndMigrate } from "../schema-version.js";
import { VERSION, config, warnOldEnvVars } from "../config.js";
import { writePidfile, removePidfile } from "./pidfile.js";
import { startHttpServer, stopHttpServer, pushEvent, setDaemonState } from "./http-server.js";
import { initQueue, submitToQueue, stopQueue, onQueueJobEvent, getActiveReindexCount } from "./queue.js";
import { initWatcher, watchProject, stopWatcher } from "./watcher.js";
import { initGitWatcher, watchGitProject, stopGitWatcher } from "./git-watcher.js";
import { initFetchPoller, startFetchPoller, stopFetchPoller } from "./fetch-poller.js";
import { initTicketPoller, startTicketPoller, stopTicketPoller, ticketPollerOnHot, ticketPollerOnJobEvent } from "./ticket-poller.js";
import { onStateChange } from "./idle-state.js";
import { diagEmit } from "./events.js";
import { startMemSampler, stopMemSampler, MEM_SAMPLE_INTERVAL_MS } from "./mem-sampler.js";
import { startRssGuard, stopRssGuard } from "./rss-guard.js";
import { listProjects, onProjectRemoved } from "../registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { rotateIfNeeded } from "./log-rotate.js";
import { initAutoGc, evaluateRatioTrigger } from "./auto-gc.js";
import { migrateModelsCache } from "./migrate-models-cache.js";
import type { KickRequest, KickResponse } from "./http-server.js";

let shutdownCalled = false;
let _lifecycle: LifecycleManager | null = null;
let _logWrite: ((line: string) => void) | null = null;

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

async function shutdown(signal: string): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;
  _lifecycle?.stop();
  stopRssGuard();
  stopMemSampler();
  daemonLog(`[scrybe daemon] ${signal} — shutting down`);
  await stopHttpServer();
  await stopWatcher();
  await stopGitWatcher();
  stopFetchPoller();
  stopTicketPoller();

  try {
    const { getQueueStats } = await import("./queue.js");
    const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");

    const drained = await runShutdownDrain({
      getActiveReindexCount,
      getQueueStats,
      maxWaitMs: config.daemonShutdownMaxWaitMs,
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

  stopQueue();
  cancelAllJobs();
  closeDB();
  removePidfile();
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

  // A1/A2: when a project is removed, emit SSE event + cancel its idle-gc timer
  onProjectRemoved((projectId, jobsCancelled) => {
    autoGcTracker.cancel(projectId);
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

  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => {}); });
  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => {}); });

  daemonLog(`[scrybe daemon] started pid=${process.pid} port=${port} dataDir=${config.dataDir}`);

  // Arm periodic RSS+heap sampler (Plan 92 Phase 1).
  // Timer is .unref()-ed inside startMemSampler so it does not keep the process alive.
  // Interval: SCRYBE_DAEMON_MEM_SAMPLE_MS (default 60000 ms).
  startMemSampler();

  // Arm RSS-threshold self-restart guard (Plan 92 Phase 2).
  // Evaluated on the same cadence as the mem-sampler.
  // Soft ceiling: SCRYBE_DAEMON_MAX_RSS_MB (default 1536 MB) — idle-gated.
  // Hard ceiling: SCRYBE_DAEMON_MAX_RSS_HARD_MB (default 3072 MB) — unconditional.
  {
    const { getQueueStats } = await import("./queue.js");
    const { spawnDaemonDetached } = await import("./spawn-detached.js");
    startRssGuard(MEM_SAMPLE_INTERVAL_MS, {
      getQueueStats,
      doRestart: (reason) => {
        daemonLog(`[scrybe daemon] rss-guard triggering self-restart (${reason})`);
        try { spawnDaemonDetached({}); } catch (err) {
          daemonLog(`[scrybe daemon] rss-guard spawn failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        shutdown(`rss-guard:${reason}`).catch(() => {});
      },
    });
  }

  // Never resolves — HTTP server + queue keep event loop alive until signal/shutdown
  await new Promise<never>(() => {});
}
