/**
 * Contract 5b — Search wrapper.
 * Thin wrapper around the real searchCode pipeline — same entry points
 * the CLI and MCP server use.
 */
import type { SearchResult } from "../../src/types.js";

export interface SearchOptions {
  topK?: number;
  branch?: string;
  sources?: string[];
}

export async function search(
  projectId: string,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const { searchCode } = await import("../../src/search.js");
  return searchCode(query, projectId, {
    limit: opts.topK ?? 10,
    branch: opts.branch,
    sources: opts.sources,
  });
}
