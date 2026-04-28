import { Command, Argument, createCommand } from "commander";
import { join } from "path";
import { getProject, listProjects, addProject, addSource, removeProject } from "./registry.js";
import { indexProject, indexSource } from "./indexer.js";
import { listBranches, getAllChunkIdsForSource } from "./branch-state.js";
import { listChunkIds, deleteChunks, compactTable, getTableStats, COMPACT_THRESHOLD } from "./vector-store.js";
import { config, VERSION } from "./config.js";
import { checkAndMigrate } from "./schema-version.js";
import { warnDeprecated } from "./cli-deprecation.js";
import { printCompletion } from "./cli-completion.js";
import { cliTools } from "./tools/all-tools.js";
import { clearPinned } from "./tools/branch.js";
import { listBranchesTool, listPinnedBranchesTool, unpinBranchesTool } from "./tools/branch.js";
import {
  addProjectTool, updateProjectTool, removeProjectTool,
  listProjectsTool,
} from "./tools/project.js";
import {
  addSourceTool, updateSourceTool, removeSourceTool,
} from "./tools/source.js";
import { searchCodeTool } from "./tools/search.js";
import type { Source, SourceConfig } from "./types.js";

// ─── CLI output helpers ───────────────────────────────────────────────────────

import type { JobResult } from "./tools/types.js";

function formatIndexResult(chunks: number, reindexed: number, removed: number): string {
  if (removed > 0 && chunks === 0 && reindexed === 0) {
    return `${removed} file(s) removed from index. Run 'scrybe gc' to reclaim disk space.`;
  }
  return `${chunks} chunks indexed, ${reindexed} files reindexed, ${removed} files removed`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function printResult<T>(result: T | JobResult<T>, formatCli?: (r: T) => string): void {
  // Non-job result: print directly
  if (!result || typeof result !== "object" || !("jobId" in (result as object))) {
    const output = formatCli ? formatCli(result as T) : JSON.stringify(result, null, 2);
    if (output) console.log(output);
  }
  // Job result: caller handles awaiting (via the registration loop); just print job_id
}

// ─── Update notifier (F1) ────────────────────────────────────────────────────

async function checkForUpdates(): Promise<string | null> {
  if (process.env["NO_UPDATE_NOTIFIER"] || process.env["CI"]) return null;
  try {
    const { default: updateNotifier } = await import("update-notifier");
    const { createRequire } = await import("module");
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { name: string; version: string };
    const notifier = updateNotifier({ pkg, updateCheckInterval: 24 * 60 * 60 * 1000 });
    await notifier.fetchInfo();
    if (notifier.update && notifier.update.latest !== pkg.version) {
      return `Update available: ${pkg.version} → ${notifier.update.latest}  (npm install -g scrybe-cli)`;
    }
  } catch { /* offline or rate-limited — ignore */ }
  return null;
}

// ─── Main CLI ─────────────────────────────────────────────────────────────────

export async function runCli(): Promise<void> {
  await checkAndMigrate();
  // Start update check early (non-blocking) so result is ready by the time ps/status renders
  const updateBannerP = checkForUpdates();
  const program = new Command();
  program.name("scrybe").description("Self-hosted semantic code search").version(VERSION);

  // ─── Subcommand groups ────────────────────────────────────────────────────

  const groupDescs: Record<string, string> = {
    project: "Manage registered projects",
    source: "Manage indexable sources within a project",
    job: "Manage background reindex jobs",
    branch: "Manage indexed branches and pinned branches",
  };

  const groups = new Map<string, Command>();

  function getGroup(name: string): Command {
    if (!groups.has(name)) {
      groups.set(name, program.command(name).description(groupDescs[name] ?? name));
    }
    return groups.get(name)!;
  }

  // ─── Standard tool registration loop ─────────────────────────────────────
  // Registers all cliTools except those needing special handling.
  // Special cases handled below: search (deprecated bare form), branch list/unpin.

  const SPECIAL_CLI_NAMES = new Set(["search code", "search knowledge", "branch list", "branch pin", "branch unpin"]);

  for (const tool of cliTools.filter((t) => !SPECIAL_CLI_NAMES.has(t.spec.cliName!))) {
    const parts = (tool.spec.cliName!).split(" ");
    const parent = parts.length === 1 ? program : getGroup(parts[0]);
    const verb = parts.slice(1).join(" ") || parts[0];

    const cmd = parent.command(verb === parts[0] ? parts[0] : verb)
      .description(tool.spec.description);
    if (tool.spec.cliArgs) tool.spec.cliArgs(cmd);

    cmd.action(async (...actionArgs: any[]) => {
      // Commander passes (pos_args..., opts, cmd_instance)
      const cmdArg = actionArgs[actionArgs.length - 1];
      const cliActionArgs = actionArgs.slice(0, -1); // drop cmd instance
      try {
        const input = tool.cliOpts ? tool.cliOpts(cliActionArgs) : cliActionArgs[cliActionArgs.length - 1];
        const result = await tool.handler(input as any);
        if (result && typeof result === "object" && "jobId" in (result as object)) {
          const jr = result as { jobId: string; awaitable: Promise<any> };
          console.log(`Job started: ${jr.jobId}`);
          const finalResult = await jr.awaitable;
          printResult(finalResult, (tool as any).formatCli);
        } else {
          printResult(result, (tool as any).formatCli);
        }
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });
  }

  // ─── Subcommand aliases (rm/delete/ls) ───────────────────────────────────
  // Commander `.alias()` must be called on the command object itself.
  // We find the commands by name after the registration loop.
  for (const [groupName, verbs] of [
    ["project", [["remove", ["rm", "delete"]], ["list", ["ls"]]]],
    ["source",  [["remove", ["rm", "delete"]], ["list", ["ls"]]]],
  ] as [string, [string, string[]][]][]) {
    const grp = groups.get(groupName);
    if (!grp) continue;
    for (const [verb, aliases] of verbs) {
      const found = grp.commands.find((c) => c.name() === verb);
      if (found) for (const a of aliases) found.alias(a);
    }
  }

  // ─── Global plural shortcuts (no deprecation) ─────────────────────────────

  program.command("projects").description("List all registered projects (shorthand for project list)")
    .action(async () => {
      try {
        const result = await listProjectsTool.handler({});
        printResult(result, listProjectsTool.formatCli!);
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  program.command("sources").description("List all sources (shorthand for source list)")
    .option("-P, --project-id <id>", "Limit to a specific project")
    .action(async (opts: { projectId?: string }) => {
      const { listSourcesTool } = await import("./tools/source.js");
      try {
        const result = await listSourcesTool.handler({ project_id: opts.projectId });
        printResult(result, listSourcesTool.formatCli!);
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  program.command("jobs").description("List background reindex jobs (shorthand for job list)")
    .option("--running", "Show only running jobs", false)
    .action(async (opts: { running: boolean }) => {
      const { listJobsTool } = await import("./tools/reindex.js");
      try {
        const result = await listJobsTool.handler({ status: opts.running ? "running" : undefined });
        printResult(result, listJobsTool.formatCli!);
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  program.command("branches").description("List indexed branches (shorthand for branch list)")
    .requiredOption("-P, --project-id <id>", "Project identifier")
    .option("-S, --source-id <id>", "Source identifier")
    .option("-p, --pinned", "Show only pinned branches", false)
    .action(async (opts: { projectId: string; sourceId?: string; pinned: boolean }) => {
      try {
        if (opts.pinned) {
          const result = await listPinnedBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId });
          console.log(JSON.stringify(result, null, 2));
        } else {
          const result = await listBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId });
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  // ─── search group (with deprecated bare search default action) ────────────

  const searchGroup = program.command("search")
    .description("Search code or knowledge sources")
    .addArgument(new Argument("[query...]", "deprecated — use: search code <query>").argOptional())
    .option("--project-id <id>", "Project ID (deprecated bare form)")
    .option("--top-k <n>", "Number of results (deprecated bare form)", "10")
    .option("--branch <name>", "Branch to search (deprecated bare form)")
    .action(async (queryParts: string[], opts: any) => {
      if (queryParts.length === 0) { searchGroup.help(); return; }
      if (!opts.projectId) {
        console.error(`[scrybe] Missing project ID. Try: scrybe search code -P <id> "${queryParts.join(" ")}"  (run 'scrybe project list' to see ids)`);
        process.exit(1);
      }
      warnDeprecated("search <query>", "search code <query>");
      try {
        const result = await searchCodeTool.handler({
          project_id: String(opts.projectId),
          query: queryParts.join(" "),
          top_k: parseInt(opts.topK, 10),
          branch: opts.branch ? String(opts.branch) : undefined,
        });
        printResult(result, searchCodeTool.formatCli!);
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  for (const tool of cliTools.filter((t) => t.spec.cliName?.startsWith("search "))) {
    const verb = tool.spec.cliName!.split(" ")[1];
    const cmd = searchGroup.command(verb).description(tool.spec.description);
    if (tool.spec.cliArgs) tool.spec.cliArgs(cmd);
    cmd.action(async (...actionArgs: any[]) => {
      const cliActionArgs = actionArgs.slice(0, -1);
      try {
        const input = tool.cliOpts ? tool.cliOpts(cliActionArgs) : cliActionArgs[cliActionArgs.length - 1];
        const result = await tool.handler(input as any);
        printResult(result, (tool as any).formatCli);
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });
  }

  // ─── branch group (custom: list handles --pinned; unpin handles --all) ────

  const branchGroup = getGroup("branch");

  branchGroup.command("list").alias("ls")
    .description(listBranchesTool.spec.description)
    .requiredOption("-P, --project-id <id>", "Project identifier")
    .option("-S, --source-id <id>", "Source identifier")
    .option("-p, --pinned", "Show only pinned branches", false)
    .addHelpText("after", "\nExamples:\n  scrybe branch list -P myrepo\n  scrybe branch list -P myrepo --pinned")
    .action(async (opts: { projectId: string; sourceId?: string; pinned: boolean }) => {
      try {
        if (opts.pinned) {
          const result = await listPinnedBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId ?? "primary" });
          console.log(JSON.stringify(result, null, 2));
        } else {
          const result = await listBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId });
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  // branch pin: use standard tool registration (cliArgs + cliOpts defined on tool)
  {
    const tool = cliTools.find((t) => t.spec.cliName === "branch pin")!;
    const cmd = branchGroup.command("pin").alias("p").description(tool.spec.description);
    if (tool.spec.cliArgs) tool.spec.cliArgs(cmd);
    cmd.action(async (...actionArgs: any[]) => {
      const cliActionArgs = actionArgs.slice(0, -1);
      try {
        const input = tool.cliOpts!(cliActionArgs);
        const result = await tool.handler(input as any);
        printResult(result, (tool as any).formatCli);
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });
  }

  // branch unpin: custom -- handles --all (clearPinned) + specific (unpinBranchesTool)
  branchGroup.command("unpin").alias("u")
    .description(unpinBranchesTool.spec.description)
    .requiredOption("-P, --project-id <id>", "Project identifier")
    .option("-S, --source-id <id>", "Source identifier", "primary")
    .option("-a, --all", "Remove all pinned branches", false)
    .option("-y, --yes", "Skip confirmation prompt (required with --all)", false)
    .argument("[branches...]", "Branch names to unpin (omit to use --all)")
    .addHelpText("after", "\nExamples:\n  scrybe branch unpin -P myrepo feature/my-feature\n  scrybe branch unpin -P myrepo --all --yes")
    .action(async (branches: string[], opts: { projectId: string; sourceId: string; all: boolean; yes: boolean }) => {
      try {
        if (opts.all) {
          if (!opts.yes) {
            process.stdout.write(`Clear all pinned branches for ${opts.projectId}/${opts.sourceId}? [y/N] `);
            const confirmed = await new Promise<boolean>((resolve) => {
              process.stdin.once("data", (data) => { process.stdin.pause(); resolve(data.toString().trim().toLowerCase() === "y"); });
            });
            if (!confirmed) { console.log("Aborted."); return; }
          }
          const result = clearPinned(opts.projectId, opts.sourceId);
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (branches.length === 0) {
            console.error("Specify branch names to unpin, or use --all to clear all.");
            process.exit(1);
          }
          const result = await unpinBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId, branches });
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err: any) { console.error(`[scrybe] ${err.message}`); process.exit(1); }
    });

  // ─── index ────────────────────────────────────────────────────────────────

  program.command("index")
    .description("Index or reindex a project (all sources) or specific sources")
    .option("-P, --project-id <id>", "Project ID (omit when using --all)")
    .option("-S, --source-ids <ids>", "Comma-separated source IDs (e.g. primary,gitlab-issues)")
    .option("-a, --all", "Incrementally reindex all registered projects", false)
    .option("-f, --full", "Full reindex (clears and rebuilds from scratch)", false)
    .option("-I, --incremental", "Incremental reindex (default)", false)
    .option("--branch <name>", "Branch name to index (default: current HEAD for code sources)")
    .addHelpText("after", "\nExamples:\n  scrybe index -P myrepo\n  scrybe index -P myrepo -S primary,gitlab-issues\n  scrybe index --all\n  scrybe index -P myrepo -f -S primary")
    .action(async (opts: { projectId?: string; sourceIds?: string; all: boolean; full: boolean; incremental: boolean; branch?: string }) => {
      if (config.embeddingConfigError) { console.error(`[scrybe] ${config.embeddingConfigError}`); process.exit(1); }
      if (opts.all) {
        if (opts.projectId) console.warn("Warning: --project-id is ignored when --all is specified");
        if (opts.sourceIds) console.warn("Warning: --source-ids is ignored when --all is specified");
        const projects = listProjects();
        if (projects.length === 0) { console.log("No projects registered."); return; }
        console.log(`Incrementally reindexing all ${projects.length} project(s)...`);
        let failed = 0;
        for (const p of projects) {
          console.log(`\n── ${p.id} (${p.sources.length} source(s))`);
          try {
            const results = await indexProject(p.id, "incremental", {
              onScanProgress(n) { process.stdout.write(`\r  Scanning... ${n} files`); },
              onEmbedProgress(n) { process.stdout.write(`\r  Embedding... ${n} chunks`); },
            });
            const totals = results.reduce((acc, r) => ({ chunks: acc.chunks + r.chunks_indexed, reindexed: acc.reindexed + r.files_reindexed, removed: acc.removed + r.files_removed }), { chunks: 0, reindexed: 0, removed: 0 });
            console.log(`\n  Done (${results.length} source(s)): ${formatIndexResult(totals.chunks, totals.reindexed, totals.removed)}`);
          } catch (err) { console.error(`\n  Failed: ${err instanceof Error ? err.message : String(err)}`); failed++; }
        }
        console.log(`\nAll projects processed. ${failed > 0 ? `${failed} failed.` : "All succeeded."}`);
        if (failed > 0) process.exit(1);
        return;
      }
      if (!opts.projectId) { console.error("--project-id is required (or use --all to reindex everything)"); process.exit(1); }
      const mode = opts.full ? "full" : "incremental";
      const sourceIds = opts.sourceIds?.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (opts.full && !sourceIds?.length) { console.error("Error: --full requires --source-ids (e.g. --source-ids primary,gitlab-issues)"); process.exit(1); }
      if (sourceIds?.length) {
        const target = sourceIds.map((sid) => `${opts.projectId}/${sid}`).join(", ");
        console.log(`Indexing ${target} (${mode})...`);
        let totalChunks = 0, totalReindexed = 0, totalRemoved = 0;
        for (const sid of sourceIds) {
          const result = await indexSource(opts.projectId!, sid, mode, {
            onScanProgress(n) { process.stdout.write(`\r  [${sid}] Scanning... ${n} files`); },
            onEmbedProgress(n) { process.stdout.write(`\r  [${sid}] Embedding... ${n} chunks`); },
            ...(opts.branch && { branch: opts.branch }),
          });
          console.log(`\n  [${sid}] Done: ${formatIndexResult(result.chunks_indexed, result.files_reindexed, result.files_removed)}`);
          totalChunks += result.chunks_indexed; totalReindexed += result.files_reindexed; totalRemoved += result.files_removed;
        }
        if (sourceIds.length > 1) console.log(`\nTotal: ${totalChunks} chunks indexed, ${totalReindexed} files reindexed, ${totalRemoved} files removed`);
        if (totalReindexed > 0 && totalChunks === 0) {
          console.error("[scrybe] Warning: files were scheduled for reindex but 0 chunks were written. Run with --full or check embedding config.");
          process.exit(2);
        }
      } else {
        console.log(`Indexing '${opts.projectId}' (all sources) (${mode})...`);
        const results = await indexProject(opts.projectId, mode, {
          onScanProgress(n) { process.stdout.write(`\r  Scanning... ${n} files`); },
          onEmbedProgress(n) { process.stdout.write(`\r  Embedding... ${n} chunks`); },
          ...(opts.branch && { branch: opts.branch }),
        });
        const totals = results.reduce((acc, r) => ({ chunks: acc.chunks + r.chunks_indexed, reindexed: acc.reindexed + r.files_reindexed, removed: acc.removed + r.files_removed }), { chunks: 0, reindexed: 0, removed: 0 });
        console.log(`\nDone (${results.length} source(s)): ${formatIndexResult(totals.chunks, totals.reindexed, totals.removed)}`);
        if (totals.reindexed > 0 && totals.chunks === 0) {
          console.error("[scrybe] Warning: files were scheduled for reindex but 0 chunks were written. Run with --full or check embedding config.");
          process.exit(2);
        }
      }
    });

  // ─── gc ───────────────────────────────────────────────────────────────────

  program.command("gc")
    .description("Remove orphan chunks not referenced by any indexed branch")
    .option("-P, --project-id <id>", "Limit GC to a specific project (default: all projects)")
    .option("--dry-run", "Report orphans without deleting", false)
    .addHelpText("after", "\nExamples:\n  scrybe gc --dry-run\n  scrybe gc")
    .action(async (opts: { projectId?: string; dryRun: boolean }) => {
      let projects;
      if (opts.projectId) {
        const p = getProject(opts.projectId);
        if (!p) { console.error(`Project '${opts.projectId}' not found`); process.exit(1); }
        projects = [p];
      } else {
        projects = listProjects();
      }
      if (projects.length === 0) { console.log("No projects registered."); return; }
      let totalOrphans = 0, totalDeleted = 0;
      for (const p of projects) {
        for (const s of p.sources) {
          if (!s.table_name || s.source_config.type !== "code") continue;
          const lanceIds = await listChunkIds(p.id, s.table_name);
          const taggedIds = getAllChunkIdsForSource(p.id, s.source_id);
          const orphans = lanceIds.filter((id) => !taggedIds.has(id));
          if (orphans.length === 0) continue;
          totalOrphans += orphans.length;
          console.log(`  ${p.id}/${s.source_id}: ${orphans.length} orphan chunk(s)`);
          if (!opts.dryRun) { await deleteChunks(orphans, s.table_name); totalDeleted += orphans.length; }
        }
      }
      if (totalOrphans === 0) { console.log("No orphan chunks found."); }
      else { console.log(opts.dryRun ? `\nDry run: ${totalOrphans} orphan chunk(s) found (not deleted).` : `\nGC complete: ${totalDeleted} orphan chunk(s) deleted.`); }
      if (!opts.dryRun) {
        // Full-purge compaction on all tables — no grace period, user explicitly requested reclaim
        const allSources = projects.flatMap((p) => p.sources.filter((s) => s.table_name));
        if (allSources.length > 0) {
          console.log("\nCompacting Lance tables...");
          let totalBytesReclaimed = 0;
          let tablesTouched = 0;
          for (const s of allSources) {
            try {
              const bytes = await compactTable(s.table_name!);
              totalBytesReclaimed += bytes;
              tablesTouched += 1;
            } catch { /* ignore — table may be gone */ }
          }
          console.log(`Done. Reclaimed ${fmtSize(totalBytesReclaimed)} across ${tablesTouched} table(s).`);
        }
      }

      // C5: prune registry entries with zero sources
      if (!opts.projectId) {
        const allProjects = listProjects();
        const empty = allProjects.filter((p) => p.sources.length === 0);
        if (empty.length > 0) {
          if (opts.dryRun) {
            console.log(`\nDry run: ${empty.length} empty project(s) would be pruned: ${empty.map((p) => p.id).join(", ")}`);
          } else if (process.stdin.isTTY) {
            process.stdout.write(`\nPrune ${empty.length} empty project(s) (${empty.map((p) => p.id).join(", ")})? [y/N] `);
            const confirmed = await new Promise<boolean>((resolve) => { process.stdin.once("data", (d) => { process.stdin.pause(); resolve(d.toString().trim().toLowerCase() === "y"); }); });
            if (confirmed) {
              for (const p of empty) { try { await removeProject(p.id); } catch { /* ignore */ } }
              console.log(`Pruned ${empty.length} empty project(s).`);
            }
          }
        }
      }
    });

  // ─── status ───────────────────────────────────────────────────────────────

  program.command("status").alias("ps")
    .description("Show scrybe health (daemon + all projects) or single project info with --project-id")
    .option("-P, --project-id <id>", "Show single-project info (JSON, same as before)")
    .option("--json", "Machine-readable output (schemaVersion: 1)")
    .option("--projects", "Hide daemon section, show only project registry")
    .option("-a, --all", "Show all projects (no truncation)")
    .option("--watch", "Live dashboard (requires daemon)")
    .addHelpText("after", "\nExamples:\n  scrybe status\n  scrybe status --json\n  scrybe status -P myrepo")
    .action(async (opts: { projectId?: string; json?: boolean; projects?: boolean; all?: boolean; watch?: boolean }) => {
      if (opts.projectId) {
        const p = getProject(opts.projectId);
        if (!p) { console.error(`Project '${opts.projectId}' not found`); process.exit(1); }
        const { getBranchesForSource: lbForSource } = { getBranchesForSource: listBranches };
        const info = { ...p, sources: p.sources.map((s) => ({ ...s, branches_indexed: s.source_config.type === "code" ? lbForSource(opts.projectId!, s.source_id) : ["*"] })) };
        console.log(JSON.stringify(info, null, 2));
        console.log(`Data dir: ${config.dataDir}`);
        return;
      }
      if (opts.watch) {
        const { readPidfile } = await import("./daemon/pidfile.js");
        const pidData = readPidfile();
        if (!pidData?.port) { console.error("[scrybe] watch mode requires daemon — run `scrybe daemon start`"); process.exit(1); }
        const { renderStatusDashboard } = await import("./daemon/status-cli.js");
        await renderStatusDashboard();
        return;
      }
      const { readPidfile } = await import("./daemon/pidfile.js");
      const { countTableRows } = await import("./vector-store.js");
      const pidData = readPidfile();
      let daemonInfo: { running: false } | { running: true; pid: number; uptimeMs: number; activeJobs: number; clientCount: number; mode: "on-demand" | "always-on"; gracePeriodRemainingMs: number | null } = { running: false };
      if (pidData?.port) {
        try {
          const { DaemonClient } = await import("./daemon/client.js");
          const client = new DaemonClient({ port: pidData.port });
          const signal = AbortSignal.timeout(2000);
          const s = await Promise.race([client.status(), new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new Error("timeout"))))]);
          daemonInfo = { running: true, pid: s.pid, uptimeMs: s.uptimeMs, activeJobs: s.queue.active + s.queue.pending, clientCount: s.clientCount ?? 0, mode: s.mode ?? "on-demand", gracePeriodRemainingMs: s.gracePeriodRemainingMs ?? null };
        } catch { /* unresponsive */ }
      }
      let alwaysOnMethod: string | null = null;
      try {
        const { isContainer } = await import("./daemon/container-detect.js");
        if (!isContainer()) {
          const { getInstallStatus } = await import("./daemon/install/index.js");
          const installStatus = await getInstallStatus();
          if (installStatus.installed) alwaysOnMethod = installStatus.method ?? "autostart";
        }
      } catch { /* ignore */ }
      let projects: ReturnType<typeof listProjects> = [];
      try { projects = listProjects(); } catch { /* DATA_DIR missing */ }
      const sourceSummaries = await Promise.all(projects.map(async (p) => ({ id: p.id, sources: await Promise.all(p.sources.map(async (s) => { const stats = s.table_name ? await getTableStats(s.table_name) : { sizeBytes: 0, versionCount: 0 }; const flags: string[] = stats.versionCount > 2 * COMPACT_THRESHOLD ? ["bloat"] : []; return { sourceId: s.source_id, chunks: s.table_name ? await countTableRows(s.table_name) : 0, lastIndexed: s.last_indexed ?? null, sizeBytes: stats.sizeBytes, versionCount: stats.versionCount, flags }; })) })));
      if (opts.json) {
        const dirPath = config.dataDir;
        const { statSync: st, existsSync: ex } = await import("fs");
        let sizeBytes = 0;
        try { if (ex(dirPath)) { const { readdirSync } = await import("fs"); for (const entry of readdirSync(dirPath, { recursive: true } as any)) { try { sizeBytes += st(join(dirPath, entry as string)).size; } catch { /* skip */ } } } } catch { /* ignore */ }
        console.log(JSON.stringify({ schemaVersion: 1, scrybeVersion: VERSION, dataDir: { path: dirPath, sizeBytes }, daemon: daemonInfo, projects: sourceSummaries }, null, 2));
        return;
      }
      function fmtUptime(ms: number): string { const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`; }
      function fmtRelative(iso: string | null): string { if (!iso) return "never"; const diff = Date.now() - new Date(iso).getTime(), s = Math.floor(diff / 1000); if (s < 60) return "just now"; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; }
      const updateBanner = await updateBannerP;
      if (updateBanner) console.log(`\n⬆ ${updateBanner}\n`);
      console.log(`${"Scrybe v" + VERSION}`.padEnd(40) + `DATA_DIR: ${config.dataDir}`);
      console.log();
      if (!opts.projects) {
        if (daemonInfo.running) {
          const uptime = fmtUptime(daemonInfo.uptimeMs), jobsStr = daemonInfo.activeJobs === 0 ? "0 jobs active" : `${daemonInfo.activeJobs} jobs active`, clientStr = daemonInfo.clientCount === 1 ? "1 client" : `${daemonInfo.clientCount} clients`, graceStr = daemonInfo.gracePeriodRemainingMs !== null ? ` · grace in ~${Math.ceil(daemonInfo.gracePeriodRemainingMs / 60000)}m` : "";
          console.log(`Daemon         ● running · PID ${daemonInfo.pid} · uptime ${uptime} · ${clientStr}${graceStr} · ${jobsStr}`);
          console.log(`Mode           ${alwaysOnMethod ? `always-on (${alwaysOnMethod})` : daemonInfo.mode}`);
        } else if (alwaysOnMethod) {
          console.log(`Daemon         ○ not running · autostart registered (${alwaysOnMethod})`);
          console.log(`Mode           always-on (${alwaysOnMethod})`);
        } else {
          console.log(`Daemon         ○ not running`);
        }
      }
      const display = opts.all ? sourceSummaries : sourceSummaries.slice(0, 5);
      const hidden = sourceSummaries.length - display.length;
      console.log(`Projects       ${projects.length} registered`);
      if (display.some((p) => p.sources.length > 0)) {
        console.log(`  ${"PROJECT".padEnd(20)}${"SOURCE".padEnd(18)}${"CHUNKS".padStart(8)}  ${"SIZE".padEnd(10)}${"HEALTH".padEnd(12)}LAST INDEXED`);
      }
      for (const p of display) {
        for (const s of p.sources) {
          const size = s.sizeBytes > 0 ? fmtSize(s.sizeBytes) : "—";
          const health = s.flags.includes("bloat") ? "Bloated *" : "Healthy";
          console.log(`  ${p.id.slice(0, 19).padEnd(20)}${s.sourceId.slice(0, 17).padEnd(18)}${s.chunks.toLocaleString().padStart(8)}  ${size.padEnd(10)}${health.padEnd(12)}${fmtRelative(s.lastIndexed)}`);
        }
      }
      if (hidden > 0) console.log(`  (${hidden} more — use --all)`);
      const anyBloated = sourceSummaries.some((p) => p.sources.some((s) => s.flags.includes("bloat")));
      if (anyBloated) {
        console.log(`\n  * run 'scrybe gc' to reclaim disk space`);
      }
    });

  // ─── uninstall ────────────────────────────────────────────────────────────

  program.command("uninstall")
    .description("Remove all scrybe data, MCP entries, and git hook blocks. Does not remove the CLI binary (use `npm uninstall -g scrybe-cli`).")
    .option("--dry-run", "Show the plan and exit without making any changes", false)
    .option("-y, --yes", "Skip confirmation prompt (for CI/scripting)", false)
    .addHelpText("after", "\nExamples:\n  scrybe uninstall --dry-run\n  scrybe uninstall --yes")
    .action(async (opts: { dryRun: boolean; yes: boolean }) => {
      const { buildUninstallPlan, preflightUninstallPlan, executeUninstallPlan } = await import("./uninstall.js");
      const plan = await buildUninstallPlan();
      console.log("\nScrybe uninstall plan:\n");
      if (plan.daemon.running) { console.log(`  Daemon\n    ● Running (PID ${plan.daemon.pid})${plan.daemon.activeJobs > 0 ? ` — will stop, cancels ${plan.daemon.activeJobs} active reindex job(s)` : " — will stop"}`); } else { console.log(`  Daemon\n    ○ Not running`); }
      console.log();
      const toRemove = plan.mcpRemovals.filter((d) => d.action === "remove");
      if (toRemove.length > 0) { const epoch = Math.floor(Date.now() / 1000); console.log(`  MCP entries to remove (${toRemove.length} client(s))`); for (const d of toRemove) console.log(`    ${d.file.path.padEnd(50)}→ backup: ${d.file.path}.scrybe-backup-${epoch}`); } else { console.log(`  MCP entries       none detected`); }
      console.log();
      if (plan.hookRemovals.length > 0) { const total = plan.hookRemovals.reduce((n, e) => n + e.hookFiles.length, 0); const epoch = Math.floor(Date.now() / 1000); console.log(`  Git hook blocks to remove (${plan.hookRemovals.length} repo(s), ${total} hook file(s))`); for (const entry of plan.hookRemovals) for (const f of entry.hookFiles) console.log(`    ${f.padEnd(60)}→ backup: ${f}.scrybe-backup-${epoch}`); } else { console.log(`  Git hook blocks   none detected`); }
      console.log();
      if (plan.autostart.installed) { console.log(`  Always-on autostart entry to remove (${plan.autostart.method ?? "unknown"})`); } else { console.log(`  Autostart         not installed`); }
      console.log();
      const fmtBytes = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`;
      const { existsSync } = await import("fs");
      const dataDirExists = existsSync(plan.dataDir.path);
      console.log(`  Data directory`);
      if (dataDirExists) { console.log(`    ${plan.dataDir.path} — ${fmtBytes(plan.dataDir.sizeBytes)}, ${plan.dataDir.projectCount} project(s)`); console.log(`    Will be deleted. This removes all indexes and credentials stored inside.`); } else { console.log(`    ${plan.dataDir.path} — not present`); }
      const nothingToDo = !plan.daemon.running && toRemove.length === 0 && plan.hookRemovals.length === 0 && !plan.autostart.installed && !dataDirExists;
      if (nothingToDo) { console.log("\nNothing to uninstall."); return; }
      const preflight = await preflightUninstallPlan(plan);
      if (!preflight.ok) { console.error("\nPreflight failed:"); for (const err of preflight.errors) console.error(`  ✗ ${err}`); process.exit(2); }
      if (opts.dryRun) { console.log("\n[dry-run] No changes made."); return; }
      if (!opts.yes) {
        if (!process.stdin.isTTY) { console.error("\n[scrybe] Non-interactive input; pass --yes to skip confirmation."); process.exit(1); }
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((res) => rl.question("\nType 'yes' to proceed (anything else cancels): ", res));
        rl.close();
        if (answer.trim() !== "yes") { console.log("Cancelled."); process.exit(130); }
      }
      const executeEpoch = Math.floor(Date.now() / 1000);
      const result = await executeUninstallPlan(plan);
      console.log("\nUninstall summary:");
      for (const action of result.actions) { const icon = action.status === "ok" ? "✓" : action.status === "skipped" ? "-" : "✗"; console.log(`  ${icon} ${action.kind}: ${action.target}${action.message ? ` (${action.message})` : ""}`); }
      if (!result.success) console.error("\nSome actions failed. Check output above for details.");
      const hookedFiles = plan.hookRemovals.flatMap((e) => e.hookFiles);
      if (hookedFiles.length > 0) { console.log("\nPlease verify these git hook files still work correctly:"); for (const f of hookedFiles) console.log(`  ${f}`); }
      const modifiedFiles = toRemove.length + plan.hookRemovals.reduce((n, e) => n + e.hookFiles.length, 0);
      if (modifiedFiles > 0) { console.log(`\nBackups: ${modifiedFiles} file(s) created with \`.scrybe-backup-${executeEpoch}\` suffix.`); console.log(`If anything breaks, restore the backup and open an issue at https://github.com/siaarzh/scrybe/issues`); }
      console.log("\nRun `npm uninstall -g scrybe-cli` to remove the CLI binary.");
      process.exit(result.exitCode);
    });

  // ─── daemon <verb> ────────────────────────────────────────────────────────

  const daemon = program.command("daemon").description("Manage the background scrybe daemon");

  daemon.command("start").description("Start the background daemon (runs in foreground)")
    .addHelpText("after", "\nExample:\n  scrybe daemon start")
    .action(async () => {
      const { isDaemonRunning } = await import("./daemon/pidfile.js");
      const { running } = await isDaemonRunning();
      if (running) { console.error("[scrybe] Daemon is already running. Use 'scrybe status' to check."); process.exit(1); }
      const { runDaemon } = await import("./daemon/main.js");
      await runDaemon();
    });

  daemon.command("stop").description("Gracefully stop the running daemon")
    .addHelpText("after", "\nExample:\n  scrybe daemon stop")
    .action(async () => {
      const { isDaemonRunning, getPidfilePath } = await import("./daemon/pidfile.js");
      const { existsSync } = await import("fs");
      const { running, data } = await isDaemonRunning();
      if (!running || !data) { console.log("Daemon is not running."); return; }
      process.kill(data.pid, "SIGTERM");
      const pidfilePath = getPidfilePath();
      for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); if (!existsSync(pidfilePath)) break; }
      if (existsSync(pidfilePath)) { const { unlinkSync } = await import("fs"); try { unlinkSync(pidfilePath); } catch { /* ignore */ } }
      console.log("Daemon stopped.");
    });

  daemon.command("status").description("[deprecated] Use `scrybe status` instead (will be removed in v2.0)")
    .option("--watch", "Live dashboard")
    .action(async (opts: { watch?: boolean }) => {
      process.stderr.write("[scrybe] 'daemon status' is deprecated — use 'scrybe status' instead (will be removed in v2.0)\n");
      const { readPidfile } = await import("./daemon/pidfile.js");
      if (opts.watch) {
        const pidData = readPidfile();
        if (!pidData?.port) { console.error("[scrybe] watch mode requires daemon — run `scrybe daemon start`"); process.exit(1); }
        const { renderStatusDashboard } = await import("./daemon/status-cli.js");
        await renderStatusDashboard(); return;
      }
      const pidData = readPidfile();
      if (!pidData?.port) { console.log("Daemon is not running."); return; }
      try { const { DaemonClient } = await import("./daemon/client.js"); const client = new DaemonClient({ port: pidData.port }); const s = await client.status(); console.log(JSON.stringify(s)); } catch { console.log("Daemon is not running."); }
    });

  daemon.command("restart").description("Stop and restart the daemon")
    .addHelpText("after", "\nExample:\n  scrybe daemon restart")
    .action(async () => {
      const { isDaemonRunning, getPidfilePath } = await import("./daemon/pidfile.js");
      const { existsSync } = await import("fs");
      const { running, data } = await isDaemonRunning();
      if (running && data) {
        process.kill(data.pid, "SIGTERM");
        const pidfilePath = getPidfilePath();
        for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); if (!existsSync(pidfilePath)) break; }
        if (existsSync(pidfilePath)) { const { unlinkSync } = await import("fs"); try { unlinkSync(pidfilePath); } catch { /* ignore */ } }
      }
      const { runDaemon } = await import("./daemon/main.js");
      await runDaemon();
    });

  daemon.command("refresh").description("Trigger an incremental reindex job in the running daemon")
    .option("-P, --project-id <id>", "Project to reindex (omit for all projects)")
    .option("-S, --source-id <id>", "Source to reindex (default: all sources)")
    .option("--branch <branch>", "Branch to index (default: HEAD)")
    .option("--mode <mode>", "Index mode: incremental | full", "incremental")
    .addHelpText("after", "\nExamples:\n  scrybe daemon refresh\n  scrybe daemon refresh -P myrepo")
    .action(async (opts: { projectId?: string; sourceId?: string; branch?: string; mode?: string }) => {
      const { readPidfile } = await import("./daemon/pidfile.js");
      const pidData = readPidfile();
      if (!pidData || pidData.port <= 0) { console.error("Daemon is not running (no pidfile or port not yet bound)."); process.exit(1); }
      const body: Record<string, string> = {};
      if (opts.projectId) body["projectId"] = opts.projectId;
      if (opts.sourceId) body["sourceId"] = opts.sourceId;
      if (opts.branch) body["branch"] = opts.branch;
      if (opts.mode) body["mode"] = opts.mode;
      try {
        const res = await fetch(`http://127.0.0.1:${pidData.port}/kick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        if (!res.ok) { const text = await res.text().catch(() => ""); console.error(`Daemon returned ${res.status}: ${text}`); process.exit(1); }
        console.log(JSON.stringify(await res.json() as { jobs: unknown[] }, null, 2));
      } catch (err: any) { console.error(`Failed to reach daemon: ${err.message}`); process.exit(1); }
    });

  daemon.command("install").description("Register the daemon for autostart at login (always-on mode)")
    .option("--force", "Reinstall even if already installed")
    .addHelpText("after", "\nExample:\n  scrybe daemon install")
    .action(async (opts: { force?: boolean }) => {
      const { isContainer } = await import("./daemon/container-detect.js");
      if (isContainer()) { console.error("Container environment — autostart is not supported."); process.exit(1); }
      const { getInstallStatus, installAutostart } = await import("./daemon/install/index.js");
      const existing = await getInstallStatus();
      if (existing.installed && !opts.force) {
        console.log(`Already installed (${existing.method ?? "unknown"}). Use --force to reinstall.`);
        if (existing.detail?.taskName) console.log(`  task:   ${existing.detail.taskName}`);
        if (existing.detail?.plistPath) console.log(`  plist:  ${existing.detail.plistPath}`);
        if (existing.detail?.unitPath) console.log(`  unit:   ${existing.detail.unitPath}`);
        return;
      }
      try {
        const status = await installAutostart({ force: opts.force });
        console.log(`Always-on enabled · ${status.method ?? "autostart"}`);
        if (status.detail?.taskName) console.log(`  task:   ${status.detail.taskName}`);
        if (status.detail?.plistPath) console.log(`  plist:  ${status.detail.plistPath}`);
        if (status.detail?.unitPath) console.log(`  unit:   ${status.detail.unitPath}`);
      } catch (err: any) { console.error(`Failed to install autostart: ${err?.message ?? String(err)}`); process.exit(1); }
    });

  daemon.command("uninstall").description("Remove daemon autostart entry (does not stop the daemon or delete data)")
    .addHelpText("after", "\nExample:\n  scrybe daemon uninstall")
    .action(async () => {
      const { uninstallAutostart } = await import("./daemon/install/index.js");
      const result = await uninstallAutostart();
      console.log(result.removed ? `Always-on removed (${result.method ?? "unknown"})` : "No autostart entry found.");
    });

  daemon.command("up").alias("ensure-running").description("Start the daemon if not running (idempotent, quiet by default)")
    .option("--verbose", "Print status to stdout")
    .action(async (opts: { verbose?: boolean }) => {
      if (process.env["SCRYBE_NO_AUTO_DAEMON"] === "1") { if (opts.verbose) console.log("SCRYBE_NO_AUTO_DAEMON is set — skipping."); return; }
      const { isDaemonRunning } = await import("./daemon/pidfile.js");
      const { running } = await isDaemonRunning();
      if (running) { if (opts.verbose) console.log("Daemon is already running."); return; }
      const { spawnDaemonDetached } = await import("./daemon/spawn-detached.js");
      spawnDaemonDetached({});
      if (opts.verbose) console.log("Daemon started.");
    });

  // ─── hook <verb> ──────────────────────────────────────────────────────────

  const hook = program.command("hook").description("Manage git hooks that notify the daemon on commit/checkout/merge");

  hook.command("install").description("Install scrybe daemon hooks in a git repo")
    .requiredOption("-P, --project-id <id>", "Project identifier (passed to daemon refresh)")
    .option("--repo <path>", "Path to the git repo root (default: current directory)", process.cwd())
    .addHelpText("after", "\nExample:\n  scrybe hook install -P myrepo")
    .action(async (opts: { projectId: string; repo: string }) => {
      const { installHooks } = await import("./daemon/hooks.js");
      const result = installHooks(opts.repo, process.argv[1]!, opts.projectId);
      if (result.installed.length > 0) console.log(`Installed hooks: ${result.installed.join(", ")}`);
      if (result.skipped.length > 0) console.log(`Already installed (skipped): ${result.skipped.join(", ")}`);
      if (result.installed.length === 0 && result.skipped.length === 0) console.log("No hooks installed.");
    });

  hook.command("uninstall").description("Remove scrybe daemon hooks from a git repo")
    .option("--repo <path>", "Path to the git repo root (default: current directory)", process.cwd())
    .addHelpText("after", "\nExample:\n  scrybe hook uninstall")
    .action(async (opts: { repo: string }) => {
      const { uninstallHooks } = await import("./daemon/hooks.js");
      const result = uninstallHooks(opts.repo);
      if (result.removed.length > 0) { console.log(`Removed scrybe block from: ${result.removed.map((r) => r.path).join(", ")}`); console.log(`Backups: ${result.removed.map((r) => r.backupPath).join(", ")}`); }
      if (result.notFound.length > 0) console.log(`No scrybe block found in: ${result.notFound.join(", ")}`);
    });

  // ─── init ─────────────────────────────────────────────────────────────────

  program.command("init").description("First-run wizard: provider setup, repo discovery, MCP auto-configuration")
    .option("--register-only", "Register repos + write MCP config, skip indexing (CI/scripting)")
    .addHelpText("after", "\nExamples:\n  scrybe init               # interactive wizard\n  scrybe init --register-only  # register without indexing")
    .action(async (opts: { registerOnly?: boolean }) => {
      const { runWizard } = await import("./onboarding/wizard.js");
      await runWizard({ registerOnly: opts.registerOnly });
    });

  // ─── doctor ───────────────────────────────────────────────────────────────

  program.command("doctor").description("Diagnose scrybe configuration and data integrity")
    .option("--json", "Output as JSON (schema v1)")
    .option("--strict", "Exit code 1 on warnings as well as failures")
    .addHelpText("after", "\nExample:\n  scrybe doctor")
    .action(async (opts: { json?: boolean; strict?: boolean }) => {
      const { runDoctor } = await import("./onboarding/doctor.js");
      let report;
      if (!opts.json && process.stdout.isTTY) {
        const { spinner } = await import("@clack/prompts");
        const spin = spinner();
        spin.start("Running diagnostics...");
        report = await runDoctor();
        const { ok: okN, warn: warnN, fail: failN } = report.summary;
        spin.stop(`Done — ${okN} ok · ${warnN} warn · ${failN} fail`);
      } else {
        report = await runDoctor();
      }
      if (opts.json) { console.log(JSON.stringify(report, null, 2)); } else { printDoctorReport(report); }
      if (report.summary.fail > 0 || (opts.strict && report.summary.warn > 0)) process.exit(1);
    });

  // ─── completion ───────────────────────────────────────────────────────────

  program.command("completion").description("Print shell completion script")
    .argument("<shell>", "Shell type: bash | zsh | powershell")
    .addHelpText("after", "\nExamples:\n  eval \"$(scrybe completion bash)\"\n  scrybe completion zsh > ~/.zsh/completions/_scrybe\n  scrybe completion powershell | Out-String | Invoke-Expression")
    .action((shell: string) => { printCompletion(shell); });

  // ─── Zero-config default action ───────────────────────────────────────────

  program.action(async () => {
    const { execSync } = await import("child_process");
    const { basename } = await import("path");
    const cwd = process.cwd();
    let isGit = false;
    try { execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" }); isGit = true; } catch { /* not a git repo */ }
    if (!isGit) { console.error("Not a git repository. Run `scrybe init` to set up scrybe."); process.exit(1); }
    const projects = listProjects();
    const alreadyRegistered = projects.some((p) => p.sources.some((s) => s.source_config.type === "code" && (s.source_config as any).root_path === cwd));
    if (alreadyRegistered) {
      console.log("Repo already registered in scrybe. Try:");
      console.log(`  scrybe index -P <id>`);
      console.log(`  scrybe search code -P <id> "your query"`);
      console.log(`  scrybe status`);
      return;
    }
    if (!process.stdin.isTTY) {
      console.log("Repo not yet registered. Run:"); console.log(`  scrybe init          # full wizard (recommended)`);
      return;
    }
    const projectId = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    process.stdout.write(`Register '${projectId}' at ${cwd} and run incremental index? [y/N] `);
    const confirmed = await new Promise<boolean>((resolve) => { process.stdin.once("data", (d) => { process.stdin.pause(); resolve(d.toString().trim().toLowerCase() === "y"); }); });
    if (!confirmed) { console.log("Aborted."); return; }
    addProject({ id: projectId, description: "" });
    addSource(projectId, { source_id: "primary", source_config: { type: "code", root_path: cwd, languages: [] } });
    console.log(`Registered '${projectId}'. Indexing...`);
    await indexProject(projectId, "incremental");
    console.log(`Done. Try: scrybe search code -P ${projectId} "your query"`);
  });

  // ─── Deprecated aliases ───────────────────────────────────────────────────
  // Hidden via addCommand(cmd, { hidden: true }).
  // Print warning to stderr, execute canonical handler. Removed at v1.0.

  program.addCommand(
    createCommand("add-project").description("[deprecated] Use: scrybe project add")
      .requiredOption("--id <id>", "Project identifier").option("--desc <text>", "Description", "")
      .action(async (opts: any) => {
        warnDeprecated("add-project", "project add");
        const result = await addProjectTool.handler({ project_id: opts.id, description: opts.desc });
        printResult(result, addProjectTool.formatCli!);
      }),
    { hidden: true }
  );

  program.addCommand(
    createCommand("update-project").description("[deprecated] Use: scrybe project update")
      .requiredOption("--id <id>", "Project identifier").option("--desc <text>", "New description")
      .action(async (opts: any) => {
        warnDeprecated("update-project", "project update");
        const result = await updateProjectTool.handler({ project_id: opts.id, description: opts.desc });
        printResult(result, updateProjectTool.formatCli!);
      }),
    { hidden: true }
  );

  program.addCommand(
    createCommand("remove-project").description("[deprecated] Use: scrybe project remove")
      .requiredOption("--id <id>", "Project identifier")
      .action(async (opts: any) => {
        warnDeprecated("remove-project", "project remove");
        const result = await removeProjectTool.handler({ project_id: opts.id });
        printResult(result, removeProjectTool.formatCli!);
      }),
    { hidden: true }
  );

  program.addCommand(
    createCommand("list-projects").description("[deprecated] Use: scrybe project list")
      .action(async () => {
        warnDeprecated("list-projects", "project list");
        const result = await listProjectsTool.handler({});
        printResult(result, listProjectsTool.formatCli!);
      }),
    { hidden: true }
  );

  const depAddSource = createCommand("add-source").description("[deprecated] Use: scrybe source add");
  if (addSourceTool.spec.cliArgs) addSourceTool.spec.cliArgs(depAddSource);
  depAddSource.action(async (...actionArgs: any[]) => {
    warnDeprecated("add-source", "source add");
    const cliActionArgs = actionArgs.slice(0, -1);
    const input = addSourceTool.cliOpts!(cliActionArgs);
    const result = await addSourceTool.handler(input as any);
    printResult(result, addSourceTool.formatCli!);
  });
  program.addCommand(depAddSource, { hidden: true });

  const depUpdateSource = createCommand("update-source").description("[deprecated] Use: scrybe source update");
  if (updateSourceTool.spec.cliArgs) updateSourceTool.spec.cliArgs(depUpdateSource);
  depUpdateSource.action(async (...actionArgs: any[]) => {
    warnDeprecated("update-source", "source update");
    const cliActionArgs = actionArgs.slice(0, -1);
    const input = updateSourceTool.cliOpts!(cliActionArgs);
    const result = await updateSourceTool.handler(input as any);
    printResult(result, updateSourceTool.formatCli!);
  });
  program.addCommand(depUpdateSource, { hidden: true });

  program.addCommand(
    createCommand("remove-source").description("[deprecated] Use: scrybe source remove")
      .requiredOption("--project-id <id>", "Project ID").requiredOption("--source-id <id>", "Source ID")
      .action(async (opts: any) => {
        warnDeprecated("remove-source", "source remove");
        const result = await removeSourceTool.handler({ project_id: opts.projectId, source_id: opts.sourceId });
        printResult(result, removeSourceTool.formatCli!);
      }),
    { hidden: true }
  );

  program.addCommand(
    createCommand("search-knowledge").description("[deprecated] Use: scrybe search knowledge")
      .requiredOption("--project-id <id>", "Project ID").option("--source-id <id>", "").option("--source-types <types>", "").option("--top-k <n>", "Number of results", "10").argument("<query>", "Search query")
      .action(async (query: string, opts: any) => {
        warnDeprecated("search-knowledge", "search knowledge");
        const { searchKnowledgeTool } = await import("./tools/search.js");
        const result = await searchKnowledgeTool.handler({ project_id: opts.projectId, query, top_k: parseInt(opts.topK, 10), source_id: opts.sourceId, source_types: opts.sourceTypes ? opts.sourceTypes.split(",").map((s: string) => s.trim()) : undefined });
        printResult(result, searchKnowledgeTool.formatCli!);
      }),
    { hidden: true }
  );

  // Deprecated pin group
  const pinDep = createCommand("pin").description("[deprecated] Use: scrybe branch pin/unpin/list");
  pinDep.command("list").description("[deprecated] Use: scrybe branch list --pinned")
    .requiredOption("--project-id <id>", "").option("--source-id <id>", "", "primary")
    .action(async (opts: any) => {
      warnDeprecated("pin list", "branch list --pinned");
      const result = await listPinnedBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId });
      console.log(JSON.stringify(result, null, 2));
    });
  pinDep.command("add").description("[deprecated] Use: scrybe branch pin")
    .requiredOption("--project-id <id>", "").option("--source-id <id>", "", "primary").argument("<branches...>", "")
    .action(async (branches: string[], opts: any) => {
      warnDeprecated("pin add", "branch pin");
      const { pinBranchesTool } = await import("./tools/branch.js");
      const result = await pinBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId, branches });
      printResult(result, pinBranchesTool.formatCli!);
    });
  pinDep.command("remove").description("[deprecated] Use: scrybe branch unpin")
    .requiredOption("--project-id <id>", "").option("--source-id <id>", "", "primary").argument("<branches...>", "")
    .action(async (branches: string[], opts: any) => {
      warnDeprecated("pin remove", "branch unpin");
      const result = await unpinBranchesTool.handler({ project_id: opts.projectId, source_id: opts.sourceId, branches });
      console.log(JSON.stringify(result, null, 2));
    });
  pinDep.command("clear").description("[deprecated] Use: scrybe branch unpin --all")
    .requiredOption("--project-id <id>", "").option("--source-id <id>", "", "primary").option("--yes", "", false)
    .action(async (opts: any) => {
      warnDeprecated("pin clear", "branch unpin --all");
      if (!opts.yes) {
        process.stdout.write(`Clear all pinned branches for ${opts.projectId}/${opts.sourceId}? [y/N] `);
        const confirmed = await new Promise<boolean>((resolve) => { process.stdin.once("data", (data) => { process.stdin.pause(); resolve(data.toString().trim().toLowerCase() === "y"); }); });
        if (!confirmed) { console.log("Aborted."); return; }
      }
      console.log(JSON.stringify(clearPinned(opts.projectId, opts.sourceId), null, 2));
    });
  program.addCommand(pinDep, { hidden: true });

  // Deprecated daemon kick → daemon refresh
  daemon.addCommand(
    createCommand("kick").description("[deprecated] Use: scrybe daemon refresh")
      .option("--project-id <id>", "").option("--source-id <id>", "").option("--branch <branch>", "").option("--mode <mode>", "", "incremental")
      .action(async (opts: any) => {
        warnDeprecated("daemon kick", "daemon refresh");
        const { readPidfile } = await import("./daemon/pidfile.js");
        const pidData = readPidfile();
        if (!pidData || pidData.port <= 0) { console.error("Daemon is not running (no pidfile or port not yet bound)."); process.exit(1); }
        const body: Record<string, string> = {};
        if (opts.projectId) body["projectId"] = opts.projectId;
        if (opts.sourceId) body["sourceId"] = opts.sourceId;
        if (opts.branch) body["branch"] = opts.branch;
        if (opts.mode) body["mode"] = opts.mode;
        try {
          const res = await fetch(`http://127.0.0.1:${pidData.port}/kick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
          if (!res.ok) { const text = await res.text().catch(() => ""); console.error(`Daemon returned ${res.status}: ${text}`); process.exit(1); }
          console.log(JSON.stringify(await res.json() as { jobs: unknown[] }, null, 2));
        } catch (err: any) { console.error(`Failed to reach daemon: ${err.message}`); process.exit(1); }
      }),
    { hidden: true }
  );

  await program.parseAsync(process.argv);
}

function printDoctorReport(report: import("./onboarding/doctor.js").DoctorReport): void {
  const icons: Record<string, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "–" };
  console.log(`\nScrybe Doctor — v${report.scrybeVersion} — ${report.generatedAt}`);
  console.log("─".repeat(50));
  let currentSection = "";
  for (const c of report.checks) {
    if (c.section !== currentSection) { console.log(`\n${c.section}`); currentSection = c.section; }
    const icon = icons[c.status] ?? "?";
    console.log(`  ${icon} ${c.title}: ${c.message}`);
    if (c.remedy && (c.status === "fail" || c.status === "warn")) console.log(`    → ${c.remedy}`);
  }
  const { ok, warn, fail, skip } = report.summary;
  console.log(`\nSummary: ${ok} ok, ${warn} warn, ${fail} fail${skip > 0 ? `, ${skip} skip` : ""}`);
}
