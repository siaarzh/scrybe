import { existsSync, accessSync, constants, rmSync, readdirSync, statSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { listProjects } from "./registry.js";
import { readPidfile, isDaemonRunning } from "./daemon/pidfile.js";
import type { RemoveDiff } from "./onboarding/mcp-config.js";

const MARKER_BEGIN = "# >>> scrybe >>>";

export interface UninstallPlan {
  daemon: { running: boolean; pid?: number; port?: number; activeJobs: number };
  mcpRemovals: RemoveDiff[];
  hookRemovals: HookRemoveEntry[];
  dataDir: { path: string; sizeBytes: number; projectCount: number };
}

export interface HookRemoveEntry {
  repoPath: string;
  hookFiles: string[];  // absolute paths to hook files with scrybe blocks
}

export interface UninstallResult {
  success: boolean;
  exitCode: 0 | 1;
  actions: Array<{ kind: string; target: string; status: "ok" | "failed" | "skipped"; message?: string }>;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true } as any)) {
      try { total += statSync(join(dir, entry as string)).size; } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return total;
}

export async function buildUninstallPlan(): Promise<UninstallPlan> {
  const { detectMcpConfigs, computeRemoveDiff } = await import("./onboarding/mcp-config.js");

  // Daemon state
  const pidData = readPidfile();
  let daemonRunning = false;
  let activeJobs = 0;
  if (pidData?.port) {
    const { running } = await isDaemonRunning();
    daemonRunning = running;
    if (running) {
      try {
        const { DaemonClient } = await import("./daemon/client.js");
        const client = new DaemonClient({ port: pidData.port });
        const signal = AbortSignal.timeout(2000);
        const status = await Promise.race([
          client.status(),
          new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new Error("timeout")))),
        ]);
        activeJobs = status.queue.active + status.queue.pending;
      } catch { /* unresponsive — treat as running but no job info */ }
    }
  }

  // MCP removals
  const mcpFiles = detectMcpConfigs();
  const mcpRemovals = mcpFiles.map((f) => computeRemoveDiff(f));

  // Hook removals
  const HOOK_NAMES = ["post-commit", "post-checkout", "post-merge", "post-rewrite"];
  let projects: ReturnType<typeof listProjects> = [];
  try { projects = listProjects(); } catch { /* DATA_DIR missing */ }

  const hookRemovals: HookRemoveEntry[] = [];
  for (const p of projects) {
    const codeSource = p.sources.find((s) => s.source_config.type === "code");
    if (!codeSource) continue;
    const root = (codeSource.source_config as { type: "code"; root_path: string }).root_path;
    const hooksDir = join(root, ".git", "hooks");
    const hookFiles: string[] = [];
    for (const name of HOOK_NAMES) {
      const hookPath = join(hooksDir, name);
      try {
        if (existsSync(hookPath)) {
          const content = readFileSync(hookPath, "utf8");
          if (content.includes(MARKER_BEGIN)) hookFiles.push(hookPath);
        }
      } catch { /* skip unreadable hooks */ }
    }
    if (hookFiles.length > 0) hookRemovals.push({ repoPath: root, hookFiles });
  }

  // Data directory
  const dataDirPath = config.dataDir;
  const sizeBytes = existsSync(dataDirPath) ? dirSize(dataDirPath) : 0;

  return {
    daemon: {
      running: daemonRunning,
      pid: pidData?.pid,
      port: pidData?.port,
      activeJobs,
    },
    mcpRemovals,
    hookRemovals,
    dataDir: { path: dataDirPath, sizeBytes, projectCount: projects.length },
  };
}

export async function preflightUninstallPlan(plan: UninstallPlan): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (const diff of plan.mcpRemovals) {
    if (diff.action === "skip") continue;
    try {
      accessSync(diff.file.path, constants.W_OK);
    } catch {
      errors.push(`MCP config not writable: ${diff.file.path}`);
    }
  }

  for (const entry of plan.hookRemovals) {
    for (const hookFile of entry.hookFiles) {
      try {
        accessSync(hookFile, constants.W_OK);
      } catch {
        errors.push(`Git hook not writable: ${hookFile}`);
      }
    }
  }

  if (existsSync(plan.dataDir.path)) {
    try {
      const parent = join(plan.dataDir.path, "..");
      accessSync(parent, constants.W_OK);
    } catch {
      errors.push(`DATA_DIR parent not writable: ${plan.dataDir.path}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function executeUninstallPlan(plan: UninstallPlan): Promise<UninstallResult> {
  const { applyMcpRemove } = await import("./onboarding/mcp-config.js");
  const { uninstallHooks } = await import("./daemon/hooks.js");

  const actions: UninstallResult["actions"] = [];
  let anyFailed = false;

  // 1. Stop daemon
  if (plan.daemon.running && plan.daemon.pid) {
    try {
      process.kill(plan.daemon.pid, "SIGTERM");
      // Wait up to 5s for pidfile to disappear
      const { getPidfilePath } = await import("./daemon/pidfile.js");
      const pidfilePath = getPidfilePath();
      const deadline = Date.now() + 5000;
      while (existsSync(pidfilePath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      // Windows: SIGTERM → TerminateProcess skips signal handlers; force-remove stale pidfile
      if (existsSync(pidfilePath)) {
        try { unlinkSync(pidfilePath); } catch { /* ignore */ }
      }
      actions.push({ kind: "daemon", target: `PID ${plan.daemon.pid}`, status: "ok",
        message: `stopped (${plan.daemon.activeJobs} jobs cancelled)` });
    } catch (err: any) {
      anyFailed = true;
      actions.push({ kind: "daemon", target: `PID ${plan.daemon.pid}`, status: "failed",
        message: err.message });
    }
  }

  // 2. Remove MCP entries
  for (const diff of plan.mcpRemovals) {
    if (diff.action === "skip") {
      actions.push({ kind: "mcp", target: diff.file.path, status: "skipped",
        message: "no scrybe entry" });
      continue;
    }
    try {
      await applyMcpRemove(diff);
      actions.push({ kind: "mcp", target: diff.file.path, status: "ok" });
    } catch (err: any) {
      anyFailed = true;
      actions.push({ kind: "mcp", target: diff.file.path, status: "failed",
        message: err.message });
    }
  }

  // 3. Remove git hook blocks
  for (const entry of plan.hookRemovals) {
    try {
      const result = uninstallHooks(entry.repoPath);
      actions.push({ kind: "hooks", target: entry.repoPath, status: "ok",
        message: `${result.removed.length} hook(s) cleaned` });
    } catch (err: any) {
      anyFailed = true;
      actions.push({ kind: "hooks", target: entry.repoPath, status: "failed",
        message: err.message });
    }
  }

  // 4. Delete DATA_DIR
  if (existsSync(plan.dataDir.path)) {
    try {
      rmSync(plan.dataDir.path, { recursive: true, force: true });
      actions.push({ kind: "dataDir", target: plan.dataDir.path, status: "ok" });
    } catch (err: any) {
      anyFailed = true;
      actions.push({ kind: "dataDir", target: plan.dataDir.path, status: "failed",
        message: err.message });
    }
  } else {
    actions.push({ kind: "dataDir", target: plan.dataDir.path, status: "skipped",
      message: "already absent" });
  }

  return {
    success: !anyFailed,
    exitCode: anyFailed ? 1 : 0,
    actions,
  };
}
