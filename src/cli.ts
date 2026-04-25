import { Command } from "commander";
import { join } from "path";
import {
  listProjects,
  addProject,
  updateProject,
  removeProject,
  getProject,
  addSource,
  updateSource,
  getSource,
  removeSource,
  isSearchable,
} from "./registry.js";
import { searchCode, searchKnowledge } from "./search.js";
import { indexProject, indexSource } from "./indexer.js";
import { getBranchesForSource, getAllChunkIdsForSource } from "./branch-tags.js";
import { listChunkIds, deleteChunks } from "./vector-store.js";
import { validateGitlabToken } from "./plugins/gitlab-issues.js";
import { config, VERSION } from "./config.js";
import { checkAndMigrate } from "./schema-version.js";
import type { Source, SourceConfig } from "./types.js";

export async function runCli(): Promise<void> {
  checkAndMigrate();
  const program = new Command();
  program
    .name("scrybe")
    .description("Self-hosted semantic code search")
    .version(VERSION);

  // ─── Project commands ──────────────────────────────────────────────────────

  program
    .command("add-project")
    .description("Register a project container (add sources with add-source)")
    .requiredOption("--id <id>", "Project identifier")
    .option("--desc <text>", "Description", "")
    .action((opts: { id: string; desc: string }) => {
      addProject({ id: opts.id, description: opts.desc });
      console.log(`Added project '${opts.id}'`);
    });

  program
    .command("update-project")
    .description("Update a project's description")
    .requiredOption("--id <id>", "Project identifier")
    .option("--desc <text>", "New description")
    .action((opts: { id: string; desc?: string }) => {
      const updated = updateProject(opts.id, {
        ...(opts.desc !== undefined && { description: opts.desc }),
      });
      console.log(`Updated project '${opts.id}':`, updated);
    });

  program
    .command("remove-project")
    .description("Unregister a project and drop all its source tables")
    .requiredOption("--id <id>", "Project identifier")
    .action(async (opts: { id: string }) => {
      await removeProject(opts.id);
      console.log(`Removed project '${opts.id}'`);
    });

  program
    .command("list-projects")
    .description("List all registered projects and their sources")
    .action(() => {
      const projects = listProjects();
      if (projects.length === 0) {
        console.log("No projects registered.");
        return;
      }
      for (const p of projects) {
        console.log(`\n${p.id} — ${p.description || "(no description)"}`);
        if (p.sources.length === 0) {
          console.log("  (no sources)");
        }
        for (const s of p.sources) {
          const { ok, reason } = isSearchable(s);
          const indexed = s.last_indexed ? `indexed: ${s.last_indexed}` : "never indexed";
          const searchable = ok ? "searchable" : `not searchable: ${reason}`;
          console.log(`  [${s.source_id}] type=${s.source_config.type}  ${indexed}  ${searchable}`);
        }
      }
    });

  program
    .command("status")
    .description("Show scrybe health (daemon + all projects) or single project info with --project-id")
    .option("--project-id <id>", "Show single-project info (JSON, same as before)")
    .option("--json", "Machine-readable output (schemaVersion: 1)")
    .option("--projects", "Hide daemon section, show only project registry")
    .option("--all", "Show all projects (no truncation)")
    .option("--watch", "Live dashboard (requires daemon)")
    .action(async (opts: { projectId?: string; json?: boolean; projects?: boolean; all?: boolean; watch?: boolean }) => {
      // Single-project legacy mode
      if (opts.projectId) {
        const p = getProject(opts.projectId);
        if (!p) {
          console.error(`Project '${opts.projectId}' not found`);
          process.exit(1);
        }
        const info = {
          ...p,
          sources: p.sources.map((s) => ({
            ...s,
            branches_indexed: s.source_config.type === "code"
              ? getBranchesForSource(opts.projectId!, s.source_id)
              : ["*"],
          })),
        };
        console.log(JSON.stringify(info, null, 2));
        console.log(`Data dir: ${config.dataDir}`);
        return;
      }

      // --watch: delegate to live Ink dashboard
      if (opts.watch) {
        const { readPidfile } = await import("./daemon/pidfile.js");
        const pidData = readPidfile();
        if (!pidData?.port) {
          console.error("[scrybe] watch mode requires daemon — run `scrybe daemon start`");
          process.exit(1);
        }
        const { renderStatusDashboard } = await import("./daemon/status-cli.js");
        await renderStatusDashboard();
        return;
      }

      // Unified health layout
      const { readPidfile } = await import("./daemon/pidfile.js");
      const { countTableRows } = await import("./vector-store.js");
      const pidData = readPidfile();

      let daemonInfo: { running: false } | {
        running: true;
        pid: number;
        uptimeMs: number;
        activeJobs: number;
        clientCount: number;
        mode: "on-demand" | "always-on";
        gracePeriodRemainingMs: number | null;
      } = { running: false };

      if (pidData?.port) {
        try {
          const { DaemonClient } = await import("./daemon/client.js");
          const client = new DaemonClient({ port: pidData.port });
          const signal = AbortSignal.timeout(2000);
          const s = await Promise.race([
            client.status(),
            new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new Error("timeout")))),
          ]);
          daemonInfo = {
            running: true,
            pid: s.pid,
            uptimeMs: s.uptimeMs,
            activeJobs: s.queue.active + s.queue.pending,
            clientCount: s.clientCount ?? 0,
            mode: s.mode ?? "on-demand",
            gracePeriodRemainingMs: s.gracePeriodRemainingMs ?? null,
          };
        } catch {
          // unresponsive — pidfile exists but daemon isn't reachable
        }
      }

      // Fetch always-on install status (best-effort, don't block status on it)
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

      // Gather per-source chunk counts
      const sourceSummaries = await Promise.all(
        projects.map(async (p) => ({
          id: p.id,
          sources: await Promise.all(
            p.sources.map(async (s) => ({
              sourceId: s.source_id,
              chunks: s.table_name ? await countTableRows(s.table_name) : 0,
              lastIndexed: s.last_indexed ?? null,
            }))
          ),
        }))
      );

      if (opts.json) {
        const dirPath = config.dataDir;
        const { statSync: st, existsSync: ex } = await import("fs");
        let sizeBytes = 0;
        try {
          if (ex(dirPath)) {
            const { readdirSync } = await import("fs");
            for (const entry of readdirSync(dirPath, { recursive: true } as any)) {
              try { sizeBytes += st(join(dirPath, entry as string)).size; } catch { /* skip */ }
            }
          }
        } catch { /* ignore */ }
        console.log(JSON.stringify({
          schemaVersion: 1,
          scrybeVersion: VERSION,
          dataDir: { path: dirPath, sizeBytes },
          daemon: daemonInfo,
          projects: sourceSummaries,
        }, null, 2));
        return;
      }

      // Human-readable unified layout
      function fmtUptime(ms: number): string {
        const s = Math.floor(ms / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
      }
      function fmtRelative(iso: string | null): string {
        if (!iso) return "never";
        const diff = Date.now() - new Date(iso).getTime();
        const s = Math.floor(diff / 1000);
        if (s < 60) return "just now";
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        return `${d}d ago`;
      }

      const headerLeft = `Scrybe v${VERSION}`;
      const headerRight = `DATA_DIR: ${config.dataDir}`;
      console.log(`${headerLeft.padEnd(40)}${headerRight}`);
      console.log();

      if (!opts.projects) {
        if (daemonInfo.running) {
          const uptime = fmtUptime(daemonInfo.uptimeMs);
          const jobsStr = daemonInfo.activeJobs === 0 ? "0 jobs active" : `${daemonInfo.activeJobs} jobs active`;
          const clientStr = daemonInfo.clientCount === 1 ? "1 client" : `${daemonInfo.clientCount} clients`;
          const graceStr = daemonInfo.gracePeriodRemainingMs !== null
            ? ` · grace in ~${Math.ceil(daemonInfo.gracePeriodRemainingMs / 60000)}m`
            : "";
          console.log(`Daemon         ● running · PID ${daemonInfo.pid} · uptime ${uptime} · ${clientStr}${graceStr} · ${jobsStr}`);
          const modeStr = alwaysOnMethod ? `always-on (${alwaysOnMethod})` : daemonInfo.mode;
          console.log(`Mode           ${modeStr}`);
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
      for (const p of display) {
        for (const s of p.sources) {
          const chunks = s.chunks.toLocaleString();
          const last = fmtRelative(s.lastIndexed);
          const label = `  ${p.id}`.padEnd(22) + s.sourceId.padEnd(16);
          console.log(`${label}${chunks} chunks · last indexed ${last}`);
        }
      }
      if (hidden > 0) {
        console.log(`  (${hidden} more — use --all)`);
      }
    });

  // ─── Uninstall ─────────────────────────────────────────────────────────────

  program
    .command("uninstall")
    .description("Remove all scrybe data, MCP entries, and git hook blocks. Does not remove the CLI binary (use `npm uninstall -g scrybe-cli`).")
    .option("--dry-run", "Show the plan and exit without making any changes", false)
    .option("--yes", "Skip confirmation prompt (for CI/scripting)", false)
    .action(async (opts: { dryRun: boolean; yes: boolean }) => {
      const { buildUninstallPlan, preflightUninstallPlan, executeUninstallPlan } =
        await import("./uninstall.js");

      const plan = await buildUninstallPlan();

      // Render plan
      console.log("\nScrybe uninstall plan:\n");
      if (plan.daemon.running) {
        const jobsNote = plan.daemon.activeJobs > 0
          ? ` — will stop, cancels ${plan.daemon.activeJobs} active reindex job(s)`
          : " — will stop";
        console.log(`  Daemon`);
        console.log(`    ● Running (PID ${plan.daemon.pid})${jobsNote}`);
      } else {
        console.log(`  Daemon`);
        console.log(`    ○ Not running`);
      }
      console.log();

      const toRemove = plan.mcpRemovals.filter((d) => d.action === "remove");
      if (toRemove.length > 0) {
        console.log(`  MCP entries to remove (${toRemove.length} client(s))`);
        const epoch = Math.floor(Date.now() / 1000);
        for (const d of toRemove) {
          console.log(`    ${d.file.path.padEnd(50)}→ backup: ${d.file.path}.scrybe-backup-${epoch}`);
        }
      } else {
        console.log(`  MCP entries       none detected`);
      }
      console.log();

      if (plan.hookRemovals.length > 0) {
        const total = plan.hookRemovals.reduce((n, e) => n + e.hookFiles.length, 0);
        const epoch = Math.floor(Date.now() / 1000);
        console.log(`  Git hook blocks to remove (${plan.hookRemovals.length} repo(s), ${total} hook file(s))`);
        for (const entry of plan.hookRemovals) {
          for (const f of entry.hookFiles) {
            console.log(`    ${f.padEnd(60)}→ backup: ${f}.scrybe-backup-${epoch}`);
          }
        }
      } else {
        console.log(`  Git hook blocks   none detected`);
      }
      console.log();

      if (plan.autostart.installed) {
        console.log(`  Always-on autostart entry to remove (${plan.autostart.method ?? "unknown"})`);
      } else {
        console.log(`  Autostart         not installed`);
      }
      console.log();

      function fmtBytes(b: number): string {
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
        if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
        return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
      }
      const { existsSync } = await import("fs");
      const dataDirExists = existsSync(plan.dataDir.path);
      console.log(`  Data directory`);
      if (dataDirExists) {
        console.log(`    ${plan.dataDir.path} — ${fmtBytes(plan.dataDir.sizeBytes)}, ${plan.dataDir.projectCount} project(s)`);
        console.log(`    Will be deleted. This removes all indexes and credentials stored inside.`);
      } else {
        console.log(`    ${plan.dataDir.path} — not present`);
      }

      const nothingToDo = !plan.daemon.running && toRemove.length === 0 &&
        plan.hookRemovals.length === 0 && !plan.autostart.installed && !dataDirExists;
      if (nothingToDo) {
        console.log("\nNothing to uninstall.");
        return;
      }

      const preflight = await preflightUninstallPlan(plan);
      if (!preflight.ok) {
        console.error("\nPreflight failed:");
        for (const err of preflight.errors) console.error(`  ✗ ${err}`);
        process.exit(2);
      }

      if (opts.dryRun) {
        console.log("\n[dry-run] No changes made.");
        return;
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error("\n[scrybe] Non-interactive input; pass --yes to skip confirmation.");
          process.exit(1);
        }
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((res) =>
          rl.question("\nType 'yes' to proceed (anything else cancels): ", res)
        );
        rl.close();
        if (answer.trim() !== "yes") {
          console.log("Cancelled.");
          process.exit(130);
        }
      }

      const executeEpoch = Math.floor(Date.now() / 1000);
      const result = await executeUninstallPlan(plan);

      console.log("\nUninstall summary:");
      for (const action of result.actions) {
        const icon = action.status === "ok" ? "✓" : action.status === "skipped" ? "-" : "✗";
        const msg = action.message ? ` (${action.message})` : "";
        console.log(`  ${icon} ${action.kind}: ${action.target}${msg}`);
      }

      if (!result.success) {
        console.error("\nSome actions failed. Check output above for details.");
      }

      const hookedFiles = plan.hookRemovals.flatMap((e) => e.hookFiles);
      if (hookedFiles.length > 0) {
        console.log("\nPlease verify these git hook files still work correctly:");
        for (const f of hookedFiles) {
          console.log(`  ${f}`);
        }
      }

      const modifiedFiles =
        toRemove.length + plan.hookRemovals.reduce((n, e) => n + e.hookFiles.length, 0);
      if (modifiedFiles > 0) {
        console.log(`\nBackups: ${modifiedFiles} file(s) created with \`.scrybe-backup-${executeEpoch}\` suffix.`);
        console.log(`If anything breaks, restore the backup and open an issue at https://github.com/siaarzh/scrybe/issues`);
      }

      console.log("\nRun `npm uninstall -g scrybe-cli` to remove the CLI binary.");
      process.exit(result.exitCode);
    });

  // ─── Source commands ───────────────────────────────────────────────────────

  program
    .command("add-source")
    .description("Add an indexable source to a project")
    .requiredOption("--project-id <id>", "Project ID")
    .requiredOption("--source-id <id>", "Source ID (e.g. code, gitlab-issues)")
    .requiredOption("--type <type>", "Source type: code | ticket")
    // code source options
    .option("--root <path>", "Absolute path to repo root (required for type=code)")
    .option("--languages <langs>", "Comma-separated language hints (for type=code)", "")
    // ticket source options
    .option("--gitlab-url <url>", "GitLab instance base URL (required for type=ticket)")
    .option("--gitlab-project-id <id>", "GitLab project ID or path (required for type=ticket)")
    .option("--gitlab-token <token>", "GitLab personal access token (required for type=ticket)")
    // optional embedding override
    .option("--embedding-base-url <url>", "Override embedding base URL")
    .option("--embedding-model <model>", "Override embedding model")
    .option("--embedding-dimensions <n>", "Override embedding dimensions")
    .option("--embedding-api-key-env <var>", "Env var NAME holding API key")
    .action(
      async (opts: {
        projectId: string;
        sourceId: string;
        type: string;
        root?: string;
        languages: string;
        gitlabUrl?: string;
        gitlabProjectId?: string;
        gitlabToken?: string;
        embeddingBaseUrl?: string;
        embeddingModel?: string;
        embeddingDimensions?: string;
        embeddingApiKeyEnv?: string;
      }) => {
        let sourceConfig: SourceConfig;
        if (opts.type === "ticket") {
          if (!opts.gitlabUrl || !opts.gitlabProjectId || !opts.gitlabToken) {
            console.error(
              "--gitlab-url, --gitlab-project-id, and --gitlab-token are required for --type ticket"
            );
            process.exit(1);
          }
          sourceConfig = {
            type: "ticket",
            provider: "gitlab",
            base_url: opts.gitlabUrl,
            project_id: opts.gitlabProjectId,
            token: opts.gitlabToken,
          };
          try {
            await validateGitlabToken(sourceConfig);
          } catch (err) {
            console.error(`GitLab token validation failed: ${err instanceof Error ? err.message : err}`);
            process.exit(1);
          }
        } else {
          if (!opts.root) {
            console.error("--root is required for --type code");
            process.exit(1);
          }
          sourceConfig = {
            type: "code",
            root_path: opts.root,
            languages: opts.languages ? opts.languages.split(",").map((l) => l.trim()) : [],
          };
        }

        const source: Omit<Source, "table_name" | "last_indexed"> = {
          source_id: opts.sourceId,
          source_config: sourceConfig,
        };

        if (
          opts.embeddingBaseUrl ||
          opts.embeddingModel ||
          opts.embeddingDimensions ||
          opts.embeddingApiKeyEnv
        ) {
          source.embedding = {
            base_url: opts.embeddingBaseUrl ?? "",
            model: opts.embeddingModel ?? "",
            dimensions: opts.embeddingDimensions ? parseInt(opts.embeddingDimensions, 10) : 1536,
            api_key_env: opts.embeddingApiKeyEnv ?? "EMBEDDING_API_KEY",
          };
        }

        addSource(opts.projectId, source);
        console.log(`Added source '${opts.sourceId}' (type: ${opts.type}) to project '${opts.projectId}'`);
      }
    );

  program
    .command("update-source")
    .description("Update an existing source config (e.g. refresh a token, change root path)")
    .requiredOption("--project-id <id>", "Project ID")
    .requiredOption("--source-id <id>", "Source ID")
    // ticket source options
    .option("--gitlab-token <token>", "New GitLab personal access token")
    .option("--gitlab-url <url>", "GitLab instance base URL")
    .option("--gitlab-project-id <id>", "GitLab project ID or path")
    // code source options
    .option("--root <path>", "Absolute path to repo root")
    .option("--languages <langs>", "Comma-separated language hints")
    // optional embedding override
    .option("--embedding-base-url <url>", "Override embedding base URL")
    .option("--embedding-model <model>", "Override embedding model")
    .option("--embedding-dimensions <n>", "Override embedding dimensions")
    .option("--embedding-api-key-env <var>", "Env var NAME holding API key")
    .action(
      (opts: {
        projectId: string;
        sourceId: string;
        gitlabToken?: string;
        gitlabUrl?: string;
        gitlabProjectId?: string;
        root?: string;
        languages?: string;
        embeddingBaseUrl?: string;
        embeddingModel?: string;
        embeddingDimensions?: string;
        embeddingApiKeyEnv?: string;
      }) => {
        const existing = getSource(opts.projectId, opts.sourceId);
        if (!existing) {
          console.error(`Source '${opts.sourceId}' not found in project '${opts.projectId}'`);
          process.exit(1);
        }

        const fields: Partial<Source> = {};

        // Patch source_config fields
        const scPatch: Record<string, unknown> = {};
        if (existing.source_config.type === "ticket") {
          if (opts.gitlabToken) scPatch["token"] = opts.gitlabToken;
          if (opts.gitlabUrl) scPatch["base_url"] = opts.gitlabUrl;
          if (opts.gitlabProjectId) scPatch["project_id"] = opts.gitlabProjectId;
        } else if (existing.source_config.type === "code") {
          if (opts.root) scPatch["root_path"] = opts.root;
          if (opts.languages) scPatch["languages"] = opts.languages.split(",").map((l) => l.trim());
        }
        if (Object.keys(scPatch).length > 0) {
          fields.source_config = { ...existing.source_config, ...scPatch } as Source["source_config"];
        }

        // Patch embedding override
        if (opts.embeddingBaseUrl || opts.embeddingModel || opts.embeddingDimensions || opts.embeddingApiKeyEnv) {
          fields.embedding = {
            base_url: opts.embeddingBaseUrl ?? existing.embedding?.base_url ?? "",
            model: opts.embeddingModel ?? existing.embedding?.model ?? "",
            dimensions: opts.embeddingDimensions
              ? parseInt(opts.embeddingDimensions, 10)
              : existing.embedding?.dimensions ?? 1536,
            api_key_env: opts.embeddingApiKeyEnv ?? existing.embedding?.api_key_env ?? "EMBEDDING_API_KEY",
          };
        }

        if (Object.keys(fields).length === 0) {
          console.log("Nothing to update — specify at least one option to change.");
          return;
        }

        updateSource(opts.projectId, opts.sourceId, fields);
        console.log(`Updated source '${opts.sourceId}' in project '${opts.projectId}'`);
      }
    );

  program
    .command("remove-source")
    .description("Remove a source from a project and drop its vector table")
    .requiredOption("--project-id <id>")
    .requiredOption("--source-id <id>")
    .action(async (opts: { projectId: string; sourceId: string }) => {
      await removeSource(opts.projectId, opts.sourceId);
      console.log(`Removed source '${opts.sourceId}' from project '${opts.projectId}'`);
    });

  // ─── Indexing commands ─────────────────────────────────────────────────────

  program
    .command("index")
    .description("Index or reindex a project (all sources) or specific sources")
    .option("--project-id <id>", "Project ID (omit when using --all)")
    .option("--source-ids <ids>", "Comma-separated source IDs (e.g. primary,gitlab-issues)")
    .option("--all", "Incrementally reindex all registered projects", false)
    .option("--full", "Full reindex (clears and rebuilds from scratch)", false)
    .option("--incremental", "Incremental reindex (default)", false)
    .option("--branch <name>", "Branch name to index (default: current HEAD for code sources)")
    .action(
      async (opts: { projectId?: string; sourceIds?: string; all: boolean; full: boolean; incremental: boolean; branch?: string }) => {
        if (config.embeddingConfigError) {
          console.error(`[scrybe] ${config.embeddingConfigError}`);
          process.exit(1);
        }
        if (opts.all) {
          if (opts.projectId) {
            console.warn("Warning: --project-id is ignored when --all is specified");
          }
          if (opts.sourceIds) {
            console.warn("Warning: --source-ids is ignored when --all is specified");
          }
          const projects = listProjects();
          if (projects.length === 0) {
            console.log("No projects registered.");
            return;
          }
          console.log(`Incrementally reindexing all ${projects.length} project(s)...`);
          let failed = 0;
          for (const p of projects) {
            console.log(`\n── ${p.id} (${p.sources.length} source(s))`);
            try {
              const results = await indexProject(p.id, "incremental", {
                onScanProgress(n) { process.stdout.write(`\r  Scanning... ${n} files`); },
                onEmbedProgress(n) { process.stdout.write(`\r  Embedding... ${n} chunks`); },
              });
              const totals = results.reduce(
                (acc, r) => ({
                  chunks: acc.chunks + r.chunks_indexed,
                  reindexed: acc.reindexed + r.files_reindexed,
                  removed: acc.removed + r.files_removed,
                }),
                { chunks: 0, reindexed: 0, removed: 0 }
              );
              console.log(
                `\n  Done (${results.length} source(s)): ${totals.chunks} chunks indexed, ` +
                `${totals.reindexed} files reindexed, ${totals.removed} files removed`
              );
            } catch (err) {
              console.error(`\n  Failed: ${err instanceof Error ? err.message : String(err)}`);
              failed++;
            }
          }
          console.log(`\nAll projects processed. ${failed > 0 ? `${failed} failed.` : "All succeeded."}`);
          if (failed > 0) process.exit(1);
          return;
        }

        if (!opts.projectId) {
          console.error("--project-id is required (or use --all to reindex everything)");
          process.exit(1);
        }

        const mode = opts.full ? "full" : "incremental";
        const sourceIds = opts.sourceIds?.split(",").map((s: string) => s.trim()).filter(Boolean);

        if (opts.full && !sourceIds?.length) {
          console.error("Error: --full requires --source-ids (e.g. --source-ids primary,gitlab-issues)");
          process.exit(1);
        }

        if (sourceIds?.length) {
          // Index specific sources
          const target = sourceIds.map((sid) => `${opts.projectId}/${sid}`).join(", ");
          console.log(`Indexing ${target} (${mode})...`);
          let totalChunks = 0;
          let totalReindexed = 0;
          let totalRemoved = 0;
          for (const sid of sourceIds) {
            const result = await indexSource(opts.projectId!, sid, mode, {
              onScanProgress(n) { process.stdout.write(`\r  [${sid}] Scanning... ${n} files`); },
              onEmbedProgress(n) { process.stdout.write(`\r  [${sid}] Embedding... ${n} chunks`); },
              ...(opts.branch && { branch: opts.branch }),
            });
            console.log(
              `\n  [${sid}] Done: ${result.chunks_indexed} chunks indexed, ` +
              `${result.files_reindexed} files reindexed, ${result.files_removed} files removed`
            );
            totalChunks += result.chunks_indexed;
            totalReindexed += result.files_reindexed;
            totalRemoved += result.files_removed;
          }
          if (sourceIds.length > 1) {
            console.log(`\nTotal: ${totalChunks} chunks indexed, ${totalReindexed} files reindexed, ${totalRemoved} files removed`);
          }
        } else {
          // Incremental reindex of all sources
          const target = `'${opts.projectId}' (all sources)`;
          console.log(`Indexing ${target} (${mode})...`);
          const results = await indexProject(opts.projectId, mode, {
            onScanProgress(n) { process.stdout.write(`\r  Scanning... ${n} files`); },
            onEmbedProgress(n) { process.stdout.write(`\r  Embedding... ${n} chunks`); },
            ...(opts.branch && { branch: opts.branch }),
          });
          const totals = results.reduce(
            (acc, r) => ({
              chunks: acc.chunks + r.chunks_indexed,
              reindexed: acc.reindexed + r.files_reindexed,
              removed: acc.removed + r.files_removed,
            }),
            { chunks: 0, reindexed: 0, removed: 0 }
          );
          console.log(
            `\nDone (${results.length} source(s)): ${totals.chunks} chunks indexed, ` +
            `${totals.reindexed} files reindexed, ${totals.removed} files removed`
          );
        }
      }
    );

  // ─── Search commands ───────────────────────────────────────────────────────

  program
    .command("search")
    .description("Semantic search across code sources in a project")
    .requiredOption("--project-id <id>")
    .option("--top-k <n>", "Number of results", "10")
    .option("--branch <name>", "Branch to search (default: current HEAD)")
    .argument("<query>", "Search query")
    .action(async (query: string, opts: { projectId: string; topK: string; branch?: string }) => {
      if (config.embeddingConfigError) {
        console.error(`[scrybe] ${config.embeddingConfigError}`);
        process.exit(1);
      }
      const topK = parseInt(opts.topK, 10);
      const results = await searchCode(query, opts.projectId, {
        limit: topK,
        ...(opts.branch && { branch: opts.branch }),
      });
      for (const r of results) {
        const sym = r.symbol_name ? ` · ${r.symbol_name}` : "";
        console.log(
          `\n[${r.score.toFixed(3)}] ${r.file_path}:${r.start_line}-${r.end_line} (${r.language})${sym}`
        );
        console.log(r.content.slice(0, 300));
      }
    });

  program
    .command("search-knowledge")
    .description("Semantic search across knowledge sources (issues, webpages, etc.)")
    .requiredOption("--project-id <id>")
    .option("--source-id <id>", "Limit to a specific source")
    .option("--source-types <types>", "Comma-separated source_type filter (e.g. ticket,ticket_comment)")
    .option("--top-k <n>", "Number of results", "10")
    .argument("<query>", "Search query")
    .action(
      async (
        query: string,
        opts: { projectId: string; sourceId?: string; sourceTypes?: string; topK: string }
      ) => {
        if (config.embeddingConfigError) {
          console.error(`[scrybe] ${config.embeddingConfigError}`);
          process.exit(1);
        }
        const topK = parseInt(opts.topK, 10);
        const sourceTypes = opts.sourceTypes ? opts.sourceTypes.split(",").map((s) => s.trim()) : undefined;
        const results = await searchKnowledge(
          query,
          opts.projectId,
          topK,
          opts.sourceId,
          sourceTypes
        );
        for (const r of results) {
          console.log(
            `\n[${r.score.toFixed(3)}] ${r.source_url || r.source_path} (${r.source_type})`
          );
          if (r.author) console.log(`  Author: ${r.author}  ${r.timestamp}`);
          console.log(r.content.slice(0, 300));
        }
      }
    );

  program
    .command("jobs")
    .description("List background reindex jobs (in-memory, current process only)")
    .option("--running", "Show only running jobs", false)
    .action(async (opts: { running: boolean }) => {
      const { listJobs } = await import("./jobs.js");
      const filter = opts.running ? "running" : undefined;
      const jobs = listJobs(filter);
      if (jobs.length === 0) {
        console.log("No jobs found.");
        return;
      }
      for (const job of jobs) {
        const elapsed = job.finished_at
          ? `${((job.finished_at - job.started_at) / 1000).toFixed(1)}s`
          : `${((Date.now() - job.started_at) / 1000).toFixed(1)}s (running)`;
        const taskSummary = job.tasks.map((t: any) => `${t.source_id}:${t.status}`).join(", ");
        console.log(`[${job.job_id}] ${job.project_id} | ${job.status} | ${elapsed} | ${taskSummary || job.current_project || ""}`);
      }
    });

  program
    .command("gc")
    .description("Remove orphan chunks not referenced by any indexed branch")
    .option("--project-id <id>", "Limit GC to a specific project (default: all projects)")
    .option("--dry-run", "Report orphans without deleting", false)
    .action(async (opts: { projectId?: string; dryRun: boolean }) => {
      let projects;
      if (opts.projectId) {
        const p = getProject(opts.projectId);
        if (!p) {
          console.error(`Project '${opts.projectId}' not found`);
          process.exit(1);
        }
        projects = [p];
      } else {
        projects = listProjects();
      }

      if (projects.length === 0) {
        console.log("No projects registered.");
        return;
      }

      let totalOrphans = 0;
      let totalDeleted = 0;

      for (const project of projects) {
        for (const source of project.sources) {
          if (!source.table_name) continue;
          // GC only applies to code sources. Non-code sources (tickets, etc.) don't
          // participate in branch_tags and their "orphans" are upstream deletions
          // that require an API fetch to detect — future `scrybe reconcile` command.
          if (source.source_config.type !== "code") continue;
          const lanceIds = await listChunkIds(project.id, source.table_name);
          const taggedIds = getAllChunkIdsForSource(project.id, source.source_id);
          const orphans = lanceIds.filter((id) => !taggedIds.has(id));
          if (orphans.length === 0) continue;
          totalOrphans += orphans.length;
          console.log(`  ${project.id}/${source.source_id}: ${orphans.length} orphan chunk(s)`);
          if (!opts.dryRun) {
            await deleteChunks(orphans, source.table_name);
            totalDeleted += orphans.length;
          }
        }
      }

      if (totalOrphans === 0) {
        console.log("No orphan chunks found.");
        return;
      }
      if (opts.dryRun) {
        console.log(`\nDry run: ${totalOrphans} orphan chunk(s) found (not deleted).`);
      } else {
        console.log(`\nGC complete: ${totalDeleted} orphan chunk(s) deleted.`);
      }
    });

  // ─── Daemon commands ──────────────────────────────────────────────────────

  const daemon = program
    .command("daemon")
    .description("Manage the background scrybe daemon");

  daemon
    .command("start")
    .description("Start the background daemon (runs in foreground; use OS task scheduler for autostart)")
    .action(async () => {
      const { isDaemonRunning } = await import("./daemon/pidfile.js");
      const { running } = await isDaemonRunning();
      if (running) {
        console.error("[scrybe] Daemon is already running. Use 'scrybe status' to check.");
        process.exit(1);
      }
      const { runDaemon } = await import("./daemon/main.js");
      await runDaemon();
    });

  daemon
    .command("stop")
    .description("Gracefully stop the running daemon")
    .action(async () => {
      const { isDaemonRunning, getPidfilePath } = await import("./daemon/pidfile.js");
      const { existsSync } = await import("fs");
      const { running, data } = await isDaemonRunning();
      if (!running || !data) {
        console.log("Daemon is not running.");
        return;
      }
      process.kill(data.pid, "SIGTERM");
      // Wait up to 5 s for pidfile removal (signal handler does this on Unix)
      const pidfilePath = getPidfilePath();
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!existsSync(pidfilePath)) break;
      }
      // Windows: TerminateProcess skips signal handlers — remove pidfile ourselves
      if (existsSync(pidfilePath)) {
        const { unlinkSync } = await import("fs");
        try { unlinkSync(pidfilePath); } catch { /* ignore */ }
      }
      console.log("Daemon stopped.");
    });

  daemon
    .command("status")
    .description("[deprecated] Use `scrybe status` instead (will be removed in v2.0)")
    .option("--watch", "Live dashboard")
    .action(async (opts: { watch?: boolean }) => {
      process.stderr.write("[scrybe] 'daemon status' is deprecated — use 'scrybe status' instead (will be removed in v2.0)\n");
      const { readPidfile } = await import("./daemon/pidfile.js");
      if (opts.watch) {
        const pidData = readPidfile();
        if (!pidData?.port) {
          console.error("[scrybe] watch mode requires daemon — run `scrybe daemon start`");
          process.exit(1);
        }
        const { renderStatusDashboard } = await import("./daemon/status-cli.js");
        await renderStatusDashboard();
        return;
      }
      const pidData = readPidfile();
      if (!pidData?.port) {
        console.log("Daemon is not running.");
        return;
      }
      try {
        const { DaemonClient } = await import("./daemon/client.js");
        const client = new DaemonClient({ port: pidData.port });
        const s = await client.status();
        console.log(JSON.stringify(s));
      } catch {
        console.log("Daemon is not running.");
      }
    });

  daemon
    .command("restart")
    .description("Stop and restart the daemon")
    .action(async () => {
      const { isDaemonRunning, getPidfilePath } = await import("./daemon/pidfile.js");
      const { existsSync } = await import("fs");
      const { running, data } = await isDaemonRunning();
      if (running && data) {
        process.kill(data.pid, "SIGTERM");
        const pidfilePath = getPidfilePath();
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (!existsSync(pidfilePath)) break;
        }
        if (existsSync(pidfilePath)) {
          const { unlinkSync } = await import("fs");
          try { unlinkSync(pidfilePath); } catch { /* ignore */ }
        }
      }
      const { runDaemon } = await import("./daemon/main.js");
      await runDaemon();
    });

  daemon
    .command("kick")
    .description("Trigger an incremental reindex job in the running daemon")
    .option("--project-id <id>", "Project to reindex (omit for all projects)")
    .option("--source-id <id>", "Source to reindex (default: all sources)")
    .option("--branch <branch>", "Branch to index (default: HEAD)")
    .option("--mode <mode>", "Index mode: incremental | full", "incremental")
    .action(async (opts: {
      projectId?: string;
      sourceId?: string;
      branch?: string;
      mode?: string;
    }) => {
      const { readPidfile } = await import("./daemon/pidfile.js");
      const pidData = readPidfile();
      if (!pidData || pidData.port <= 0) {
        console.error("Daemon is not running (no pidfile or port not yet bound).");
        process.exit(1);
      }
      const body: Record<string, string> = {};
      if (opts.projectId) body["projectId"] = opts.projectId;
      if (opts.sourceId) body["sourceId"] = opts.sourceId;
      if (opts.branch) body["branch"] = opts.branch;
      if (opts.mode) body["mode"] = opts.mode;
      try {
        const res = await fetch(`http://127.0.0.1:${pidData.port}/kick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`Daemon returned ${res.status}: ${text}`);
          process.exit(1);
        }
        const json = await res.json() as { jobs: unknown[] };
        console.log(JSON.stringify(json, null, 2));
      } catch (err: any) {
        console.error(`Failed to reach daemon: ${err.message}`);
        process.exit(1);
      }
    });

  daemon
    .command("install")
    .description("Register the daemon for autostart at login (always-on mode)")
    .option("--force", "Reinstall even if already installed")
    .action(async (opts: { force?: boolean }) => {
      const { isContainer } = await import("./daemon/container-detect.js");
      if (isContainer()) {
        console.error("Container environment — autostart is not supported.");
        process.exit(1);
      }
      const { getInstallStatus, installAutostart } = await import("./daemon/install/index.js");
      const existing = await getInstallStatus();
      if (existing.installed && !opts.force) {
        console.log(`Already installed (${existing.method ?? "unknown"}). Use --force to reinstall.`);
        if (existing.detail?.taskName)  console.log(`  task:   ${existing.detail.taskName}`);
        if (existing.detail?.plistPath) console.log(`  plist:  ${existing.detail.plistPath}`);
        if (existing.detail?.unitPath)  console.log(`  unit:   ${existing.detail.unitPath}`);
        return;
      }
      try {
        const status = await installAutostart({ force: opts.force });
        console.log(`Always-on enabled · ${status.method ?? "autostart"}`);
        if (status.detail?.taskName)  console.log(`  task:   ${status.detail.taskName}`);
        if (status.detail?.plistPath) console.log(`  plist:  ${status.detail.plistPath}`);
        if (status.detail?.unitPath)  console.log(`  unit:   ${status.detail.unitPath}`);
      } catch (err: any) {
        console.error(`Failed to install autostart: ${err?.message ?? String(err)}`);
        process.exit(1);
      }
    });

  daemon
    .command("uninstall")
    .description("Remove daemon autostart entry (does not stop the daemon or delete data)")
    .action(async () => {
      const { uninstallAutostart } = await import("./daemon/install/index.js");
      const result = await uninstallAutostart();
      if (result.removed) {
        console.log(`Always-on removed (${result.method ?? "unknown"})`);
      } else {
        console.log("No autostart entry found.");
      }
    });

  daemon
    .command("ensure-running")
    .description("Start the daemon if not running (idempotent, quiet by default)")
    .option("--verbose", "Print status to stdout")
    .action(async (opts: { verbose?: boolean }) => {
      if (process.env["SCRYBE_NO_AUTO_DAEMON"] === "1") {
        if (opts.verbose) console.log("SCRYBE_NO_AUTO_DAEMON is set — skipping.");
        return;
      }
      const { isDaemonRunning } = await import("./daemon/pidfile.js");
      const { running } = await isDaemonRunning();
      if (running) {
        if (opts.verbose) console.log("Daemon is already running.");
        return;
      }
      const { spawnDaemonDetached } = await import("./daemon/spawn-detached.js");
      spawnDaemonDetached({});
      if (opts.verbose) console.log("Daemon started.");
    });

  // ─── Hook commands ────────────────────────────────────────────────────────

  const hook = program
    .command("hook")
    .description("Manage git hooks that notify the daemon on commit/checkout/merge");

  hook
    .command("install")
    .description("Install scrybe daemon kick hooks in a git repo")
    .requiredOption("--project-id <id>", "Project identifier (passed to daemon kick)")
    .option("--repo <path>", "Path to the git repo root (default: current directory)", process.cwd())
    .action(async (opts: { projectId: string; repo: string }) => {
      const { installHooks } = await import("./daemon/hooks.js");
      const mainJsPath = process.argv[1]!;
      const result = installHooks(opts.repo, mainJsPath, opts.projectId);
      if (result.installed.length > 0) {
        console.log(`Installed hooks: ${result.installed.join(", ")}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Already installed (skipped): ${result.skipped.join(", ")}`);
      }
      if (result.installed.length === 0 && result.skipped.length === 0) {
        console.log("No hooks installed.");
      }
    });

  hook
    .command("uninstall")
    .description("Remove scrybe daemon kick hooks from a git repo")
    .option("--repo <path>", "Path to the git repo root (default: current directory)", process.cwd())
    .action(async (opts: { repo: string }) => {
      const { uninstallHooks } = await import("./daemon/hooks.js");
      const result = uninstallHooks(opts.repo);
      if (result.removed.length > 0) {
        console.log(`Removed scrybe block from: ${result.removed.map((r) => r.path).join(", ")}`);
        console.log(`Backups: ${result.removed.map((r) => r.backupPath).join(", ")}`);
      }
      if (result.notFound.length > 0) {
        console.log(`No scrybe block found in: ${result.notFound.join(", ")}`);
      }
    });

  // ─── Pin commands ──────────────────────────────────────────────────────────

  const pin = program
    .command("pin")
    .description("Manage pinned branches for background daemon indexing");

  pin
    .command("list")
    .description("List pinned branches for a source")
    .requiredOption("--project-id <id>", "Project identifier")
    .option("--source-id <id>", "Source identifier", "primary")
    .action(async (opts: { projectId: string; sourceId: string }) => {
      const { listPinned } = await import("./pinned-branches.js");
      try {
        const branches = listPinned(opts.projectId, opts.sourceId);
        console.log(JSON.stringify({ branches }, null, 2));
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    });

  pin
    .command("add")
    .description("Add branches to the pinned list")
    .requiredOption("--project-id <id>", "Project identifier")
    .option("--source-id <id>", "Source identifier", "primary")
    .argument("<branches...>", "Branch names to pin")
    .action(async (branches: string[], opts: { projectId: string; sourceId: string }) => {
      const { addPinned } = await import("./pinned-branches.js");
      try {
        const result = await addPinned(opts.projectId, opts.sourceId, branches, "add");
        console.log(JSON.stringify(result, null, 2));
        for (const w of result.warnings) console.warn(`warning: ${w}`);
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    });

  pin
    .command("remove")
    .description("Remove branches from the pinned list")
    .requiredOption("--project-id <id>", "Project identifier")
    .option("--source-id <id>", "Source identifier", "primary")
    .argument("<branches...>", "Branch names to unpin")
    .action(async (branches: string[], opts: { projectId: string; sourceId: string }) => {
      const { removePinned } = await import("./pinned-branches.js");
      try {
        const result = removePinned(opts.projectId, opts.sourceId, branches);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    });

  pin
    .command("clear")
    .description("Remove all pinned branches from a source")
    .requiredOption("--project-id <id>", "Project identifier")
    .option("--source-id <id>", "Source identifier", "primary")
    .option("--yes", "Skip confirmation prompt", false)
    .action(async (opts: { projectId: string; sourceId: string; yes: boolean }) => {
      const { clearPinned } = await import("./pinned-branches.js");
      if (!opts.yes) {
        // Simple confirmation via stdin (non-interactive environments use --yes)
        process.stdout.write(
          `Clear all pinned branches for ${opts.projectId}/${opts.sourceId}? [y/N] `
        );
        const confirmed = await new Promise<boolean>((resolve) => {
          process.stdin.once("data", (data) => {
            resolve(data.toString().trim().toLowerCase() === "y");
          });
        });
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }
      try {
        const result = clearPinned(opts.projectId, opts.sourceId);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    });

  // ─── Init command ─────────────────────────────────────────────────────────

  program
    .command("init")
    .description("First-run wizard: provider setup, repo discovery, MCP auto-configuration")
    .option("--register-only", "Register repos + write MCP config, skip indexing (CI/scripting)")
    .action(async (opts: { registerOnly?: boolean }) => {
      const { runWizard } = await import("./onboarding/wizard.js");
      await runWizard({ registerOnly: opts.registerOnly });
    });

  // ─── Doctor command ────────────────────────────────────────────────────────

  program
    .command("doctor")
    .description("Diagnose scrybe configuration and data integrity")
    .option("--json", "Output as JSON (schema v1)")
    .option("--strict", "Exit code 1 on warnings as well as failures")
    .action(async (opts: { json?: boolean; strict?: boolean }) => {
      const { runDoctor } = await import("./onboarding/doctor.js");
      const report = await runDoctor();
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDoctorReport(report);
      }
      const hasFail = report.summary.fail > 0;
      const hasWarn = opts.strict && report.summary.warn > 0;
      if (hasFail || hasWarn) process.exit(1);
    });

  // ─── Zero-config default action ───────────────────────────────────────────

  program
    .option("--auto", "Auto-register and index current directory as a scrybe project (must be a git repo)")
    .hook("preAction", () => { /* no-op; --auto handled in default action */ });

  program.action(async (opts: { auto?: boolean }) => {
    const { execSync } = await import("child_process");
    const { basename } = await import("path");
    const cwd = process.cwd();

    // Check if cwd is a git repo
    let isGit = false;
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });
      isGit = true;
    } catch { /* not a git repo */ }

    if (!isGit) {
      console.error("Not a git repository. Run `scrybe init` to set up scrybe.");
      process.exit(1);
    }

    const projects = listProjects();
    const alreadyRegistered = projects.some((p) =>
      p.sources.some(
        (s) => s.source_config.type === "code" && (s.source_config as any).root_path === cwd
      )
    );

    if (!opts.auto) {
      if (alreadyRegistered) {
        console.log("Repo already registered in scrybe. Try:");
        console.log(`  scrybe index --project-id <id> --incremental`);
        console.log(`  scrybe search --project-id <id> "your query"`);
        console.log(`  scrybe status`);
      } else {
        console.log("Repo not yet registered. Run:");
        console.log(`  scrybe init          # full wizard (recommended)`);
        console.log(`  scrybe --auto        # quick register + index current repo`);
      }
      return;
    }

    // --auto path: only if stdin is a TTY
    if (!process.stdin.isTTY) {
      console.error("--auto requires an interactive terminal. Run `scrybe init` instead.");
      process.exit(1);
    }

    const projectId = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    process.stdout.write(
      `Register '${projectId}' at ${cwd} and run incremental index? [y/N] `
    );
    const confirmed = await new Promise<boolean>((resolve) => {
      process.stdin.once("data", (d) => resolve(d.toString().trim().toLowerCase() === "y"));
    });
    if (!confirmed) { console.log("Aborted."); return; }

    addProject({ id: projectId, description: "" });
    addSource(projectId, {
      source_id: "primary",
      source_config: { type: "code", root_path: cwd, languages: [] },
    });
    console.log(`Registered '${projectId}'. Indexing...`);
    await indexProject(projectId, "incremental");
    console.log(`Done. Try: scrybe search --project-id ${projectId} "your query"`);
  });

  await program.parseAsync(process.argv);
}

function printDoctorReport(report: import("./onboarding/doctor.js").DoctorReport): void {
  const icons: Record<string, string> = { ok: "✓", warn: "⚠", fail: "✗", skip: "–" };
  console.log(`\nScrybe Doctor — v${report.scrybeVersion} — ${report.generatedAt}`);
  console.log("─".repeat(50));
  let currentSection = "";
  for (const c of report.checks) {
    if (c.section !== currentSection) {
      console.log(`\n${c.section}`);
      currentSection = c.section;
    }
    const icon = icons[c.status] ?? "?";
    console.log(`  ${icon} ${c.title}: ${c.message}`);
    if (c.remedy && (c.status === "fail" || c.status === "warn")) {
      console.log(`    → ${c.remedy}`);
    }
  }
  const { ok, warn, fail, skip } = report.summary;
  console.log(
    `\nSummary: ${ok} ok, ${warn} warn, ${fail} fail${skip > 0 ? `, ${skip} skip` : ""}`
  );
}
