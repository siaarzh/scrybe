import type { Command } from "commander";
import { searchCode, searchKnowledge } from "../search.js";
import { config } from "../config.js";
import type { SearchResult, KnowledgeSearchResult } from "../types.js";
import type { Tool } from "./types.js";
import { getTableHealth, invalidateHealthCache as _invalidateHealthCache, needsMigration } from "../vector-store.js";
import { getExpectedDimensions } from "../health-probe.js";
import { getProject, resolveEmbeddingConfig, assignTableName } from "../registry.js";
import { getPlugin } from "../plugins/index.js";

// Re-export so callers can invalidate from outside this module if needed.
export { _invalidateHealthCache };

/**
 * Check the health cache for all indexed sources in a project.
 * Returns a structured error object if any source is corrupt or needs migration, or null if all healthy.
 * Only reads from cache — never triggers a fresh probe.
 */
async function checkProjectHealth(
  projectId: string,
  sourceFilter?: string[]
): Promise<{ error: string; error_type: "table_corrupt" | "needs_migration"; details: Record<string, unknown> } | null> {
  const project = getProject(projectId);
  if (!project) return null;

  for (const sourceRaw of project.sources) {
    if (sourceFilter && sourceFilter.length > 0 && !sourceFilter.includes(sourceRaw.source_id)) continue;
    const source = assignTableName(projectId, sourceRaw);
    const tableName = source.table_name;
    if (!tableName) continue;

    const embConfig = resolveEmbeddingConfig(source);
    let pluginProfile: "code" | "knowledge" = "code";
    try {
      const plugin = getPlugin(source.source_config.type);
      pluginProfile = plugin.embeddingProfile === "code" ? "code" : "knowledge";
    } catch { /* unknown plugin */ }
    const expDims = getExpectedDimensions(pluginProfile) ?? embConfig.dimensions;

    let health;
    try {
      health = await getTableHealth(tableName, { expectedDimensions: expDims });
    } catch {
      continue; // non-fatal
    }

    // Check for pending migration before corruption (migration is recoverable; not a hard block)
    if (tableName && needsMigration(tableName)) {
      const msg =
        `Source '${projectId}/${source.source_id}' uses an old chunk-ID scheme. ` +
        `Run: scrybe migrate --source-id ${source.source_id} --project-id ${projectId}`;
      return {
        error: msg,
        error_type: "needs_migration",
        details: {
          project_id: projectId,
          source_id: source.source_id,
          table_name: tableName,
          migrate_command: `scrybe migrate --source-id ${source.source_id} --project-id ${projectId}`,
        },
      };
    }

    if (health.state === "corrupt") {
      const reasons = health.reasons;
      let msg: string;
      if (reasons.includes("dimensions_mismatch") && health.details.expected_dimensions != null) {
        msg =
          `Source '${projectId}/${source.source_id}' has a dimensions mismatch ` +
          `(indexed at ${health.details.actual_dimensions}, embedder is now ${health.details.expected_dimensions}). ` +
          `Run: scrybe index -P ${projectId} -S ${source.source_id} --full`;
      } else if (reasons.includes("manifest_missing_data")) {
        const n = health.details.missing_files?.length ?? 1;
        msg =
          `Source '${projectId}/${source.source_id}' has a corrupt index ` +
          `(manifest references ${n} missing data file${n === 1 ? "" : "s"}). ` +
          `Run: scrybe index -P ${projectId} -S ${source.source_id} --full`;
      } else {
        msg =
          `Source '${projectId}/${source.source_id}' has an unreadable index. ` +
          `Run: scrybe index -P ${projectId} -S ${source.source_id} --full`;
      }
      return {
        error: msg,
        error_type: "table_corrupt",
        details: {
          project_id: projectId,
          source_id: source.source_id,
          reasons,
          ...health.details,
        },
      };
    }
  }
  return null;
}

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
    const healthErr = await checkProjectHealth(project_id);
    if (healthErr) {
      const err = new Error(healthErr.error) as Error & { error_type?: string; details?: Record<string, unknown> };
      err.error_type = healthErr.error_type;
      err.details = healthErr.details;
      throw err;
    }
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
    return `\n[${r.score.toFixed(3)}] ${r.item_path}:${r.start_line}-${r.end_line} (${r.language})${sym}${branchLine}\n${r.content.slice(0, 300)}`;
  }).join(""),
};

export const searchKnowledgeTool: Tool<
  { project_id: string; query: string; top_k?: number; source_id?: string; item_types?: string[] },
  KnowledgeSearchResult[]
> = {
  spec: {
    name: "search_knowledge",
    cliName: "search knowledge",
    description:
      "Semantically search GitLab issues, webpages, or other knowledge sources indexed in a project. " +
      "Use list_projects first to confirm the project has indexed knowledge sources. " +
      "Optionally filter by source_id (specific source) or item_types. " +
      "Known item_types: \"ticket\" = GitLab issue bodies; \"ticket_comment\" = individual issue comments (each with its own author, timestamp, and #note_NNN deep-link). " +
      "Omit item_types to search both. Use [\"ticket_comment\"] to find architectural decisions made in comments, or [\"ticket\"] to find/deduplicate issue bodies.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        top_k: { type: "number", default: 10 },
        source_id: { type: "string", description: "Limit search to a specific source (optional)" },
        item_types: { type: "array", items: { type: "string" }, description: 'Filter by item_type. Known values: "ticket" (issue bodies), "ticket_comment" (individual comments). Omit to return both.' },
      },
      required: ["project_id", "query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .argument("<query>", "Search query")
      .requiredOption("-P, --project-id <id>", "Project ID")
      .option("-S, --source-id <id>", "Limit to a specific source")
      .option("--item-types <types>", "Comma-separated item_type filter (e.g. ticket,ticket_comment)")
      .option("--top-k <n>", "Number of results", "10")
      .addHelpText("after", "\nExample:\n  scrybe search knowledge -P myrepo \"login issue\""),
  },
  handler: async ({ project_id, query, top_k, source_id, item_types }) => {
    const embErr = requireEmbedding();
    if (embErr) throw new Error(embErr);
    const healthErr = await checkProjectHealth(project_id, source_id ? [source_id] : undefined);
    if (healthErr) {
      const err = new Error(healthErr.error) as Error & { error_type?: string; details?: Record<string, unknown> };
      err.error_type = healthErr.error_type;
      err.details = healthErr.details;
      throw err;
    }
    const results = await searchKnowledge(query, project_id, top_k ?? 10, source_id, item_types);
    return results;
  },
  cliOpts: ([query, opts]) => ({
    project_id: String(opts.projectId),
    query: String(query),
    top_k: parseInt(String(opts.topK ?? "10"), 10),
    source_id: opts.sourceId ? String(opts.sourceId) : undefined,
    item_types: opts.itemTypes ? String(opts.itemTypes).split(",").map((s: string) => s.trim()) : undefined,
  }),
  formatCli: (results) => results.map((r) => {
    const authorLine = r.author ? `\n  Author: ${r.author}  ${r.timestamp}` : "";
    return `\n[${r.score.toFixed(3)}] ${r.item_url || r.item_path} (${r.item_type})${authorLine}\n${r.content.slice(0, 300)}`;
  }).join(""),
};
