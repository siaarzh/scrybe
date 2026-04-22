import { closeBranchTagsDB } from "../branch-tags.js";
import { cancelAllJobs } from "../jobs.js";
import { checkAndMigrate } from "../schema-version.js";
import { VERSION, config } from "../config.js";
import { writePidfile, removePidfile } from "./pidfile.js";
import { startHttpServer, stopHttpServer, pushEvent, setDaemonState } from "./http-server.js";
import { initQueue, enqueue, stopQueue } from "./queue.js";
import { initWatcher, watchProject, stopWatcher } from "./watcher.js";
import { initGitWatcher, watchGitProject, stopGitWatcher } from "./git-watcher.js";
import { onStateChange } from "./idle-state.js";
import { listProjects } from "../registry.js";
import type { KickRequest, KickResponse } from "./http-server.js";

let shutdownCalled = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;
  process.stderr.write(`[scrybe daemon] ${signal} — shutting down\n`);
  await stopHttpServer();
  await stopWatcher();
  await stopGitWatcher();
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

  const startedAt = new Date();

  const { port } = await startHttpServer({
    startedAt,
    onShutdown: () => { shutdown("HTTP /shutdown").catch(() => {}); },
    onKick: kickHandler,
  });

  // Wire queue → SSE ring buffer (must happen after startHttpServer exports pushEvent)
  initQueue({ pushEvent });

  // Wire FS + git watchers → SSE + queue
  initWatcher({ pushEvent });
  initGitWatcher({ pushEvent });

  // Mirror idle-state HOT/COLD transitions to HTTP /status
  onStateChange((s) => setDaemonState(s));

  // Start per-project FS + git watchers (code sources only)
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

  process.stderr.write(
    `[scrybe daemon] started pid=${process.pid} port=${port} dataDir=${config.dataDir}\n`
  );

  // Never resolves — HTTP server + queue keep event loop alive until signal/shutdown
  await new Promise<never>(() => {});
}
