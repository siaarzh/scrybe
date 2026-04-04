import { Command } from "commander";
import {
  listProjects,
  addProject,
  updateProject,
  removeProject,
  getProject,
} from "./registry.js";
import { searchCode } from "./search.js";
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
    .requiredOption("--root <path>", "Absolute path to repo root")
    .option("--languages <langs>", "Comma-separated language hints", "")
    .option("--desc <text>", "Description", "")
    .action((opts: { id: string; root: string; languages: string; desc: string }) => {
      addProject({
        id: opts.id,
        root_path: opts.root,
        languages: opts.languages ? opts.languages.split(",").map((l) => l.trim()) : [],
        description: opts.desc,
      });
      console.log(`Added project '${opts.id}'`);
    });

  program
    .command("update-project")
    .description("Update a project's metadata")
    .requiredOption("--id <id>", "Project identifier")
    .option("--root <path>", "New root path")
    .option("--languages <langs>", "Comma-separated languages")
    .option("--desc <text>", "New description")
    .action((opts: { id: string; root?: string; languages?: string; desc?: string }) => {
      const updated = updateProject(opts.id, {
        ...(opts.root && { root_path: opts.root }),
        ...(opts.languages && { languages: opts.languages.split(",").map((l) => l.trim()) }),
        ...(opts.desc !== undefined && { description: opts.desc }),
      });
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
    .description("Semantic search across a project")
    .requiredOption("--project-id <id>")
    .option("--top-k <n>", "Number of results", "10")
    .argument("<query>", "Search query")
    .action(async (query: string, opts: { projectId: string; topK: string }) => {
      const topK = parseInt(opts.topK, 10);
      const results = await searchCode(query, opts.projectId, topK);
      for (const r of results) {
        console.log(`\n[${r.score.toFixed(3)}] ${r.file_path}:${r.start_line}-${r.end_line} (${r.language})`);
        console.log(r.content.slice(0, 300));
      }
    });

  await program.parseAsync(process.argv);
}
