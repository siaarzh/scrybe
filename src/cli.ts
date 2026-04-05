import { Command } from "commander";
import {
  listProjects,
  addProject,
  updateProject,
  removeProject,
  getProject,
} from "./registry.js";
import { searchCode, searchKnowledge } from "./search.js";
import { indexProject } from "./indexer.js";
import { config } from "./config.js";

export async function runCli(): Promise<void> {
  const program = new Command();
  program
    .name("scrybe")
    .description("Self-hosted semantic code search")
    .version("0.2.0");

  program
    .command("add-project")
    .description("Register a project for indexing")
    .requiredOption("--id <id>", "Project identifier")
    .option("--root <path>", "Absolute path to repo root (required for type=code)")
    .option("--languages <langs>", "Comma-separated language hints", "")
    .option("--desc <text>", "Description", "")
    .option("--type <type>", "Source type: code | ticket", "code")
    .option("--gitlab-url <url>", "GitLab instance base URL (required for type=ticket)")
    .option("--gitlab-project-id <id>", "GitLab project ID or path (required for type=ticket)")
    .option("--gitlab-token <token>", "GitLab personal access token (required for type=ticket)")
    .action((opts: {
      id: string; root?: string; languages: string; desc: string;
      type: string; gitlabUrl?: string; gitlabProjectId?: string; gitlabToken?: string;
    }) => {
      if (opts.type === "ticket") {
        if (!opts.gitlabUrl || !opts.gitlabProjectId || !opts.gitlabToken) {
          console.error("--gitlab-url, --gitlab-project-id, and --gitlab-token are required for --type ticket");
          process.exit(1);
        }
        addProject({
          id: opts.id,
          root_path: opts.root ?? "",
          languages: [],
          description: opts.desc,
          source_config: {
            type: "ticket",
            provider: "gitlab",
            base_url: opts.gitlabUrl,
            project_id: opts.gitlabProjectId,
            token: opts.gitlabToken,
          },
        });
      } else {
        if (!opts.root) {
          console.error("--root is required for --type code");
          process.exit(1);
        }
        addProject({
          id: opts.id,
          root_path: opts.root,
          languages: opts.languages ? opts.languages.split(",").map((l) => l.trim()) : [],
          description: opts.desc,
        });
      }
      console.log(`Added project '${opts.id}' (type: ${opts.type})`);
    });

  program
    .command("update-project")
    .description("Update a project's metadata")
    .requiredOption("--id <id>", "Project identifier")
    .option("--root <path>", "New root path")
    .option("--languages <langs>", "Comma-separated languages")
    .option("--desc <text>", "New description")
    .option("--gitlab-token <token>", "New GitLab personal access token (for ticket projects)")
    .action((opts: { id: string; root?: string; languages?: string; desc?: string; gitlabToken?: string }) => {
      const fields: Parameters<typeof updateProject>[1] = {
        ...(opts.root && { root_path: opts.root }),
        ...(opts.languages && { languages: opts.languages.split(",").map((l) => l.trim()) }),
        ...(opts.desc !== undefined && { description: opts.desc }),
      };
      if (opts.gitlabToken) {
        const existing = getProject(opts.id);
        if (!existing) { console.error(`Project '${opts.id}' not found`); process.exit(1); }
        if (existing.source_config?.type !== "ticket") {
          console.error(`Project '${opts.id}' is not a ticket project`);
          process.exit(1);
        }
        fields.source_config = { ...existing.source_config, token: opts.gitlabToken };
      }
      const updated = updateProject(opts.id, fields);
      console.log(`Updated project '${opts.id}':`, updated);
    });

  program
    .command("remove-project")
    .description("Unregister a project")
    .requiredOption("--id <id>", "Project identifier")
    .action((opts: { id: string }) => {
      removeProject(opts.id);
      console.log(`Removed project '${opts.id}'`);
    });

  program
    .command("list-projects")
    .description("List all registered projects")
    .action(() => {
      const projects = listProjects();
      if (projects.length === 0) {
        console.log("No projects registered.");
        return;
      }
      for (const p of projects) {
        console.log(`  ${p.id}\t${p.root_path}\t[${p.languages.join(",")}]`);
        if (p.description) console.log(`    ${p.description}`);
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

  program
    .command("index")
    .description("Index or reindex a project")
    .requiredOption("--project-id <id>")
    .option("--full", "Full reindex (default)", false)
    .option("--incremental", "Incremental reindex", false)
    .action(async (opts: { projectId: string; full: boolean; incremental: boolean }) => {
      const mode = opts.incremental ? "incremental" : "full";
      console.log(`Indexing '${opts.projectId}' (${mode})...`);
      const result = await indexProject(opts.projectId, mode, {
        onScanProgress(n) {
          process.stdout.write(`\r  Scanning... ${n} files`);
        },
        onEmbedProgress(n) {
          process.stdout.write(`\r  Embedding... ${n} chunks`);
        },
      });
      console.log(
        `\nDone: ${result.chunks_indexed} chunks indexed, ` +
          `${result.files_reindexed} files reindexed, ` +
          `${result.files_removed} files removed`
      );
    });

  program
    .command("search")
    .description("Semantic search across a code project")
    .requiredOption("--project-id <id>")
    .option("--top-k <n>", "Number of results", "10")
    .argument("<query>", "Search query")
    .action(async (query: string, opts: { projectId: string; topK: string }) => {
      const topK = parseInt(opts.topK, 10);
      const results = await searchCode(query, opts.projectId, topK);
      for (const r of results) {
        const sym = r.symbol_name ? ` · ${r.symbol_name}` : "";
        console.log(`\n[${r.score.toFixed(3)}] ${r.file_path}:${r.start_line}-${r.end_line} (${r.language})${sym}`);
        console.log(r.content.slice(0, 300));
      }
    });

  program
    .command("search-knowledge")
    .description("Semantic search across a knowledge project (issues, webpages, etc.)")
    .requiredOption("--project-id <id>")
    .option("--top-k <n>", "Number of results", "10")
    .argument("<query>", "Search query")
    .action(async (query: string, opts: { projectId: string; topK: string }) => {
      const topK = parseInt(opts.topK, 10);
      const results = await searchKnowledge(query, opts.projectId, topK);
      for (const r of results) {
        console.log(`\n[${r.score.toFixed(3)}] ${r.source_url || r.source_path} (${r.source_type})`);
        if (r.author) console.log(`  Author: ${r.author}  ${r.timestamp}`);
        console.log(r.content.slice(0, 300));
      }
    });

  await program.parseAsync(process.argv);
}
