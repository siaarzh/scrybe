import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { closeBranchTagsDB } from "../branch-tags.js";
import { cancelAllJobs } from "../jobs.js";
import { checkAndMigrate } from "../schema-version.js";
import { VERSION, config } from "../config.js";
import { writePidfile, removePidfile } from "./pidfile.js";
import { startHttpServer, stopHttpServer, pushEvent, setDaemonState } from "./http-server.js";
import { initQueue, enqueue, stopQueue } from "./queue.js";
import { initWatcher, watchProject, stopWatcher } from "./watcher.js";
import { initGitWatcher, watchGitProject, stopGitWatcher } from "./git-watcher.js";
import { initFetchPoller, startFetchPoller, stopFetchPoller } from "./fetch-poller.js";
import { onStateChange } from "./idle-state.js";
import { listProjects } from "../registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { rotateIfNeeded } from "./log-rotate.js";
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
  stopQueue();
  cancelAllJobs();
  closeBranchTagsDB();
  removePidfile();
  process.exit(0);
}

async function kickHandler(req: KickRequest): Promise<KickResponse> {
  const projects = req.projectId
    ? [{ id: req.projectId }]
    : listProjects();

  const jobs = await Promise.all(
    projects.map(async (p) => {
      const jobId = await enqueue({
        projectId: p.id,
        sourceId: req.sourceId,
        branch: req.branch,
        mode: req.mode,
      });
      return {
        jobId,
        projectId: p.id,
        sourceId: req.sourceId ?? "all",
        branch: req.branch ?? "HEAD",
      };
    })
  );

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
  checkAndMigrate();

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
        await watchProject(project.id, rootPath);
        await watchGitProject(project.id, rootPath);
        break; // one code source per project for now
      }
    }
  }
  startFetchPoller(projects);

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
