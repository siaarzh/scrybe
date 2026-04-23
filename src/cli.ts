import { Command } from "commander";
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
    .description("Show project info")
    .requiredOption("--project-id <id>")
    .action((opts: { projectId: string }) => {
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
            ? getBranchesForSource(opts.projectId, s.source_id)
            : ["*"],
        })),
      };
      console.log(JSON.stringify(info, null, 2));
      console.log(`Data dir: ${config.dataDir}`);
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
        console.error("[scrybe] Daemon is already running. Use 'scrybe daemon status' to check.");
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
    .description("Show daemon status (--watch for live Ink dashboard)")
    .option("--watch", "Live dashboard — polls /status every 2s and streams /events via SSE")
    .action(async (opts: { watch?: boolean }) => {
      if (opts.watch) {
        // Lazy import — React/Ink only loaded when --watch is requested
        const { renderStatusDashboard } = await import("./daemon/status-cli.js");
        await renderStatusDashboard();
        return;
      }
      const { readPidfile } = await import("./daemon/pidfile.js");
      const pidData = readPidfile();
      if (!pidData?.port) {
        console.log("Daemon is not running.");
        return;
      }
      const { DaemonClient } = await import("./daemon/client.js");
      const client = new DaemonClient({ port: pidData.port });
      try {
        const s = await client.status();
        console.log(JSON.stringify(s, null, 2));
      } catch (err: any) {
        console.error(`Failed to reach daemon: ${err.message}`);
        process.exit(1);
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
        console.log(`Removed scrybe block from: ${result.removed.join(", ")}`);
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
    .option("--skip-index", "Configure everything but defer the initial reindex")
    .action(async (opts: { skipIndex?: boolean }) => {
      const { runWizard } = await import("./onboarding/wizard.js");
      await runWizard({ skipIndex: opts.skipIndex });
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
        console.log(`  scrybe daemon status`);
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
