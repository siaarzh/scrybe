import { createWriteStream, existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { closeDB } from "../branch-state.js";
import { cancelAllJobs } from "../jobs.js";
import { checkAndMigrate } from "../schema-version.js";
import { VERSION, config, warnOldEnvVars } from "../config.js";
import { writePidfile, removePidfile } from "./pidfile.js";
import { startHttpServer, stopHttpServer, pushEvent, setDaemonState } from "./http-server.js";
import { initQueue, submitToQueue, stopQueue, onQueueJobEvent } from "./queue.js";
import { initWatcher, watchProject, stopWatcher } from "./watcher.js";
import { initGitWatcher, watchGitProject, stopGitWatcher } from "./git-watcher.js";
import { initFetchPoller, startFetchPoller, stopFetchPoller } from "./fetch-poller.js";
import { onStateChange } from "./idle-state.js";
import { listProjects, onProjectRemoved } from "../registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { rotateIfNeeded } from "./log-rotate.js";
import { initAutoGc, evaluateRatioTrigger } from "./auto-gc.js";
import { warmupLocalEmbedder } from "../local-embedder.js";
import type { KickRequest, KickResponse } from "./http-server.js";

let shutdownCalled = false;
let _lifecycle: LifecycleManager | null = null;
let _logWrite: ((line: string) => void) | null = null;

function daemonLog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(line);
  _logWrite?.(line);
}

async function shutdown(signal: string): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;
  _lifecycle?.stop();
  daemonLog(`[scrybe daemon] ${signal} — shutting down`);
  await stopHttpServer();
  await stopWatcher();
  await stopGitWatcher();
  stopFetchPoller();

  // Bounded shutdown drain: wait up to 30s for in-flight gc jobs to finish
  // before stopping the queue. Reduces (but doesn't eliminate) the gc-killed-mid-write class.
  const GC_DRAIN_TIMEOUT_MS = 30_000;
  try {
    const { getQueueStats } = await import("./queue.js");
    const drainStart = Date.now();
    while (Date.now() - drainStart < GC_DRAIN_TIMEOUT_MS) {
      const stats = getQueueStats();
      if (stats.active === 0) break;
      await new Promise<void>((r) => setTimeout(r, 200));
    }
    const stats = getQueueStats();
    if (stats.active > 0) {
      daemonLog(`[scrybe daemon] gc drain timeout — ${stats.active} job(s) still active, force-stopping`);
      const { appendFileSync } = await import("fs");
      const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
      try {
        appendFileSync(
          logPath,
          JSON.stringify({ ts: new Date().toISOString(), event: "gc.force-killed", detail: { activeJobs: stats.active } }) + "\n",
          "utf8"
        );
      } catch { /* ignore */ }
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
  await checkAndMigrate();

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

  // Pre-load local embedder model(s) so the first index doesn't pay download/load cost.
  // Runs in background — a failure here does not block daemon startup.
  void (async () => {
    const seenModels = new Set<string>();
    if (config.embeddingProviderType === "local") {
      const modelId = config.embeddingModel;
      if (!seenModels.has(modelId)) {
        seenModels.add(modelId);
        try {
          await warmupLocalEmbedder({ modelId, dimensions: config.embeddingDimensions });
        } catch (e) {
          process.stderr.write(`[scrybe] local embedder warmup failed (code embedding): ${e}\n`);
        }
      }
    }
    if (config.textEmbeddingProviderType === "local") {
      const modelId = config.textEmbeddingModel;
      if (!seenModels.has(modelId)) {
        seenModels.add(modelId);
        try {
          await warmupLocalEmbedder({ modelId, dimensions: config.textEmbeddingDimensions });
        } catch (e) {
          process.stderr.write(`[scrybe] local embedder warmup failed (knowledge embedding): ${e}\n`);
        }
      }
    }
  })();

  // Set up log file
  const logsDir = join(config.dataDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(logsDir, "daemon.log");
  rotateIfNeeded(logPath);
  const logStream = createWriteStream(logPath, { flags: "a" });
  _logWrite = (line) => { try { logStream.write(line); } catch { /* ignore */ } };

  const lifecycle = new LifecycleManager();
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

  // Wire FS + git watchers + fetch poller → SSE + queue
  initWatcher({ pushEvent });
  initGitWatcher({ pushEvent });
  initFetchPoller({ pushEvent });

  // Mirror idle-state HOT/COLD transitions to HTTP /status
  onStateChange((s) => setDaemonState(s));

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
                pushEvent({
                  ts: new Date().toISOString(),
                  level: "warn",
                  event: "health.corrupt",
                  projectId: project.id,
                  sourceId: source.source_id,
                  detail: {
                    tableName,
                    reasons: result.reasons,
                    details: result.details,
                  },
                });
              }
            } catch { /* non-fatal — probe must not crash daemon */ }
          })
        )
      );
    } catch { /* non-fatal */ }
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

  // Never resolves — HTTP server + queue keep event loop alive until signal/shutdown
  await new Promise<never>(() => {});
}
