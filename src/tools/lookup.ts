import { getProject } from "../registry.js";
import { getPlugin } from "../plugins/index.js";
import { openExistingTable, escapeSql } from "../vector-store.js";
import {
  resolveBranchForSearch,
  getChunkIdsForBranch,
  getBranchesForChunks,
} from "../branch-state.js";
import type { Source } from "../types.js";
import type { Tool } from "./types.js";

// Chunk_id sets above this size are handled by JS post-filter instead of SQL IN clause.
// Mirrors the same constant in search.ts.
const BRANCH_FILTER_INLINE_LIMIT = 5000;

function getCodeSources(sources: Source[]): Source[] {
  return sources.filter((s) => {
    try {
      return getPlugin(s.source_config.type).embeddingProfile === "code";
    } catch {
      return false;
    }
  });
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LookupSymbolInput {
  project_id: string;
  symbol_name: string;
  match?: "suffix" | "exact";   // default "suffix"
  branch?: string;
  source_id?: string;
  case_sensitive?: boolean;     // default true
  limit?: number;               // default 50, max 200
}

export interface LookupResult {
  chunk_id: string;
  project_id: string;
  source_id: string;
  item_path: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol_name: string;
  content: string;
  branches: string[];
}

// ─── WHERE clause builder ─────────────────────────────────────────────────────

/**
 * Build the symbol_name predicate (without the project_id / chunk_id parts).
 *
 * Decision matrix:
 *   exact + case_sensitive:     symbol_name = '<name>'
 *   exact + case_insensitive:   LOWER(symbol_name) = LOWER('<name>')
 *   suffix + case_sensitive:    (symbol_name = '<name>' OR symbol_name LIKE '%.<name>')
 *   suffix + case_insensitive:  (LOWER(symbol_name) = LOWER('<name>') OR LOWER(symbol_name) LIKE LOWER('%.<name>'))
 *
 * Note: LanceDB SQL supports LOWER() and LIKE against Utf8 columns.
 * If a future LanceDB upgrade breaks these functions, switch to JS-side filtering
 * (fetch all rows where symbol_name != '' for the project/source, filter in JS).
 */
function buildSymbolPredicate(
  symbolName: string,
  match: "suffix" | "exact",
  caseSensitive: boolean
): string {
  const escaped = escapeSql(symbolName);

  if (match === "exact") {
    if (caseSensitive) {
      return `symbol_name = '${escaped}'`;
    } else {
      return `LOWER(symbol_name) = LOWER('${escaped}')`;
    }
  }

  // suffix mode
  if (caseSensitive) {
    return `(symbol_name = '${escaped}' OR symbol_name LIKE '%.${escaped}')`;
  } else {
    return `(LOWER(symbol_name) = LOWER('${escaped}') OR LOWER(symbol_name) LIKE LOWER('%.${escaped}'))`;
  }
}

// ─── Core lookup logic ────────────────────────────────────────────────────────

export async function lookupSymbol(
  projectId: string,
  input: LookupSymbolInput
): Promise<LookupResult[]> {
  const { symbol_name, match = "suffix", branch, source_id, case_sensitive = true, limit = 50 } = input;

  const trimmed = symbol_name.trim();
  if (!trimmed) {
    throw new Error("symbol_name must be a non-empty string after trimming");
  }
  const cappedLimit = Math.min(limit, 200);

  const project = getProject(projectId);
  if (!project) throw new Error(`Project '${projectId}' not found`);

  let codeSources = getCodeSources(project.sources);
  if (source_id) {
    codeSources = codeSources.filter((s) => s.source_id === source_id);
  }
  if (codeSources.length === 0) {
    return [];
  }

  const symbolPredicate = buildSymbolPredicate(trimmed, match, case_sensitive);

  // Fan out across all code sources in parallel (mirrors searchCode pattern)
  const perSourceResults = await Promise.all(
    codeSources
      .filter((s) => s.table_name)
      .map(async (source): Promise<LookupResult[]> => {
        const tableName = source.table_name!;

        const table = await openExistingTable(tableName);
        if (!table) return [];

        // Resolve branch filter — accepts short names or origin/-qualified refs.
        let inlineIds: string[] | undefined;
        let postFilterIds: Set<string> | undefined;

        if (branch !== undefined) {
          const resolvedBranch = resolveBranchForSearch(projectId, source.source_id, branch);
          if (resolvedBranch === null) {
            // Branch supplied but unknown to this source — contribute zero hits.
            return [];
          }
          const ids = getChunkIdsForBranch(projectId, source.source_id, resolvedBranch);
          if (ids.size <= BRANCH_FILTER_INLINE_LIMIT) {
            inlineIds = [...ids];
          } else {
            postFilterIds = ids;
          }
        }

        // Build full WHERE clause
        // Always include:
        //   - symbol_name != '' (excludes sliding-window fallback chunks and non-first sub-chunks)
        //   - project_id = X (scoped to this project)
        //   - symbol predicate
        //   - optional chunk_id IN (...) for branch filter (inline path)
        let where = `symbol_name != '' AND project_id = '${escapeSql(projectId)}' AND ${symbolPredicate}`;

        if (inlineIds !== undefined) {
          if (inlineIds.length === 0) {
            // Branch resolved but has no chunks — return empty.
            return [];
          }
          const ids = inlineIds.map((id) => `'${escapeSql(id)}'`).join(", ");
          where += ` AND chunk_id IN (${ids})`;
        }

        // Pure WHERE query — no .search() call, no vector needed
        const rows = await table.query().where(where).limit(cappedLimit).toArray();

        let results: LookupResult[] = rows.map((row) => ({
          chunk_id: String(row["chunk_id"]),
          project_id: String(row["project_id"]),
          source_id: source.source_id,
          item_path: String(row["item_path"]),
          start_line: Number(row["start_line"]),
          end_line: Number(row["end_line"]),
          language: String(row["language"]),
          symbol_name: String(row["symbol_name"]),
          content: String(row["content"]),
          branches: [],
        }));

        // Post-filter for large branch sets (> BRANCH_FILTER_INLINE_LIMIT chunk_ids)
        if (postFilterIds) {
          results = results.filter((r) => postFilterIds!.has(r.chunk_id));
        }

        return results;
      })
  );

  // Merge all per-source results
  const merged: LookupResult[] = ([] as LookupResult[]).concat(...perSourceResults);

  // Sort by (language ASC, item_path ASC, start_line ASC) — deterministic
  merged.sort((a, b) => {
    const byLang = a.language.localeCompare(b.language);
    if (byLang !== 0) return byLang;
    const byPath = a.item_path.localeCompare(b.item_path);
    if (byPath !== 0) return byPath;
    return a.start_line - b.start_line;
  });

  // Cap at limit
  const capped = merged.slice(0, cappedLimit);

  // Annotate branches[] via getBranchesForChunks (one query per source)
  const bySource = new Map<string, string[]>();
  for (const r of capped) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id)!.push(r.chunk_id);
  }

  const branchesByChunk = new Map<string, string[]>();
  for (const [sid, chunkIds] of bySource) {
    const map = getBranchesForChunks(projectId, sid, chunkIds);
    for (const [cid, branches] of map) branchesByChunk.set(cid, branches);
  }

  return capped.map((r) => ({ ...r, branches: branchesByChunk.get(r.chunk_id) ?? [] }));
}

// ─── MCP Tool registration ────────────────────────────────────────────────────

export const lookupSymbolTool: Tool<LookupSymbolInput, LookupResult[]> = {
  spec: {
    name: "lookup_symbol",
    // cliName deliberately omitted — MCP-only tool.
    description:
      "Deterministic exact-symbol lookup in a project's code index. " +
      "Returns all chunks whose symbol_name matches the supplied name, " +
      "without paying embedding / rerank cost. " +
      "Use when you know a symbol name and need its location and source. " +
      "No 'score' field — results are sorted by language, file path, start line. " +
      "Empty symbol_name chunks (sliding-window fallback files, non-first sub-chunks of large decls) are always excluded.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        symbol_name: {
          type: "string",
          description:
            "Symbol name to look up. In 'suffix' mode (default), 'getName' matches both " +
            "top-level 'getName' and dotted forms like 'User.getName'. In 'exact' mode, " +
            "the full stored name must match (e.g. 'User.getName').",
        },
        match: {
          type: "string",
          enum: ["suffix", "exact"],
          description:
            "Match mode. 'suffix' (default): matches bare name OR any 'Qualifier.name' form. " +
            "'exact': full stored symbol_name must equal the supplied value.",
          default: "suffix",
        },
        branch: {
          type: "string",
          description:
            "Branch to scope results to. Accepts either a short name ('feat/example') or a " +
            "qualified ref ('origin/feat/example') — the server resolves whichever form is indexed. " +
            "If omitted, all indexed branches are searched.",
        },
        source_id: {
          type: "string",
          description: "Restrict lookup to a specific source. Omit to search all code sources.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Case-sensitive match (default true). Pass false to match case-insensitively.",
          default: true,
        },
        limit: {
          type: "number",
          description: "Max results to return (default 50, max 200).",
          default: 50,
        },
      },
      required: ["project_id", "symbol_name"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async (input) => {
    const { project_id, symbol_name } = input;
    if (!project_id) throw new Error("project_id is required");
    const trimmed = (symbol_name ?? "").trim();
    if (!trimmed) throw new Error("symbol_name must be non-empty after trimming");
    const limit = input.limit ?? 50;
    if (limit > 200) throw new Error("limit must be ≤ 200");
    return lookupSymbol(project_id, { ...input, symbol_name: trimmed, limit });
  },
};
