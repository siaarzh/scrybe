import type { Command } from "commander";
import { searchCode, searchKnowledge } from "../search.js";
import { getProject } from "../registry.js";
import { config } from "../config.js";
import type { SearchResult, KnowledgeSearchResult } from "../types.js";
import type { Tool } from "./types.js";

function requireEmbedding(): string | null {
  return config.embeddingConfigError ?? null;
}

export const searchCodeTool: Tool<
  { project_id: string; query: string; top_k?: number; branch?: string },
  SearchResult[]
> = {
  spec: {
    name: "search_code",
    cliName: "search code",
    description: "Semantically search code in a project using natural language. Use list_projects first to confirm the project has an indexed code source.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        top_k: { type: "number", default: 10 },
        branch: { type: "string", description: "Branch to search (default: current HEAD for code sources)" },
      },
      required: ["project_id", "query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .argument("<query>", "Search query")
      .requiredOption("-P, --project-id <id>", "Project ID")
      .option("--top-k <n>", "Number of results", "10")
      .option("--branch <name>", "Branch to search (default: current HEAD)")
      .addHelpText("after", "\nExample:\n  scrybe search code -P myrepo \"auth flow\""),
  },
  handler: async ({ project_id, query, top_k, branch }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const results = await searchCode(query, project_id, { limit: top_k ?? 10, ...(branch && { branch }) });
    return results;
  },
  cliOpts: ([query, opts]) => ({
    project_id: String(opts.projectId),
    query: String(query),
    top_k: parseInt(String(opts.topK ?? "10"), 10),
    branch: opts.branch ? String(opts.branch) : undefined,
  }),
  formatCli: (results) => results.map((r) => {
    const sym = r.symbol_name ? ` · ${r.symbol_name}` : "";
    const branchLine = r.branches.length > 0
      ? `\n  Branches: ${r.branches.join(", ")}`
      : "";
    return `\n[${r.score.toFixed(3)}] ${r.file_path}:${r.start_line}-${r.end_line} (${r.language})${sym}${branchLine}\n${r.content.slice(0, 300)}`;
  }).join(""),
};

export const searchKnowledgeTool: Tool<
  { project_id: string; query: string; top_k?: number; source_id?: string; source_types?: string[] },
  KnowledgeSearchResult[]
> = {
  spec: {
    name: "search_knowledge",
    cliName: "search knowledge",
    description:
      "Semantically search GitLab issues, webpages, or other knowledge sources indexed in a project. " +
      "Use list_projects first to confirm the project has indexed knowledge sources. " +
      "Optionally filter by source_id (specific source) or source_types. " +
      "Known source_types: \"ticket\" = GitLab issue bodies; \"ticket_comment\" = individual issue comments (each with its own author, timestamp, and #note_NNN deep-link). " +
      "Omit source_types to search both. Use [\"ticket_comment\"] to find architectural decisions made in comments, or [\"ticket\"] to find/deduplicate issue bodies.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        top_k: { type: "number", default: 10 },
        source_id: { type: "string", description: "Limit search to a specific source (optional)" },
        source_types: { type: "array", items: { type: "string" }, description: 'Filter by source_type. Known values: "ticket" (issue bodies), "ticket_comment" (individual comments). Omit to return both.' },
      },
      required: ["project_id", "query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .argument("<query>", "Search query")
      .requiredOption("-P, --project-id <id>", "Project ID")
      .option("-S, --source-id <id>", "Limit to a specific source")
      .option("--source-types <types>", "Comma-separated source_type filter (e.g. ticket,ticket_comment)")
      .option("--top-k <n>", "Number of results", "10")
      .addHelpText("after", "\nExample:\n  scrybe search knowledge -P myrepo \"login issue\""),
  },
  handler: async ({ project_id, query, top_k, source_id, source_types }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const results = await searchKnowledge(query, project_id, top_k ?? 10, source_id, source_types);
    return results;
  },
  cliOpts: ([query, opts]) => ({
    project_id: String(opts.projectId),
    query: String(query),
    top_k: parseInt(String(opts.topK ?? "10"), 10),
    source_id: opts.sourceId ? String(opts.sourceId) : undefined,
    source_types: opts.sourceTypes ? String(opts.sourceTypes).split(",").map((s: string) => s.trim()) : undefined,
  }),
  formatCli: (results) => results.map((r) => {
    const authorLine = r.author ? `\n  Author: ${r.author}  ${r.timestamp}` : "";
    return `\n[${r.score.toFixed(3)}] ${r.source_url || r.source_path} (${r.source_type})${authorLine}\n${r.content.slice(0, 300)}`;
  }).join(""),
};
