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
import { config } from "./config.js";
import type { Source, SourceConfig } from "./types.js";

export async function runCli(): Promise<void> {
  const program = new Command();
  program
    .name("scrybe")
    .description("Self-hosted semantic code search")
    .version("0.2.0");

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
      console.log(JSON.stringify(p, null, 2));
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
      (opts: {
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
    .description("Index or reindex a project (all sources) or a specific source")
    .option("--project-id <id>", "Project ID (omit when using --all)")
    .option("--source-id <id>", "Index only this source (omit to reindex all sources)")
    .option("--all", "Incrementally reindex all registered projects", false)
    .option("--full", "Full reindex (default)", false)
    .option("--incremental", "Incremental reindex", false)
    .action(
      async (opts: { projectId?: string; sourceId?: string; all: boolean; full: boolean; incremental: boolean }) => {
        if (opts.all) {
          if (opts.projectId) {
            console.warn("Warning: --project-id is ignored when --all is specified");
          }
          if (opts.sourceId) {
            console.warn("Warning: --source-id is ignored when --all is specified");
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

        const mode = opts.incremental ? "incremental" : "full";
        const target = opts.sourceId
          ? `'${opts.projectId}/${opts.sourceId}'`
          : `'${opts.projectId}' (all sources)`;
        console.log(`Indexing ${target} (${mode})...`);

        if (opts.sourceId) {
          const result = await indexSource(opts.projectId, opts.sourceId, mode, {
            onScanProgress(n) { process.stdout.write(`\r  Scanning... ${n} files`); },
            onEmbedProgress(n) { process.stdout.write(`\r  Embedding... ${n} chunks`); },
          });
          console.log(
            `\nDone: ${result.chunks_indexed} chunks indexed, ` +
            `${result.files_reindexed} files reindexed, ` +
            `${result.files_removed} files removed`
          );
        } else {
          const results = await indexProject(opts.projectId, mode, {
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
    .argument("<query>", "Search query")
    .action(async (query: string, opts: { projectId: string; topK: string }) => {
      const topK = parseInt(opts.topK, 10);
      const results = await searchCode(query, opts.projectId, topK);
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
    .option("--source-type <type>", "Filter by source_type (e.g. ticket)")
    .option("--top-k <n>", "Number of results", "10")
    .argument("<query>", "Search query")
    .action(
      async (
        query: string,
        opts: { projectId: string; sourceId?: string; sourceType?: string; topK: string }
      ) => {
        const topK = parseInt(opts.topK, 10);
        const sourceTypes = opts.sourceType ? [opts.sourceType] : undefined;
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

  await program.parseAsync(process.argv);
}
