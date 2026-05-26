/**
 * Shim version compatibility: allowlist of known MCP tool names.
 * Used for version skew handling in mcp-shim.ts.
 * Populated from the mcpTools registry at build time.
 */
export const KNOWN_TOOL_NAMES = [
  "add_embedding_preset",
  "add_project",
  "add_source",
  "doctor",
  "init",
  "assign_preset",
  "status",
  "cancel_reindex",
  "gc",
  "get_private_ignore",
  "get_wiki_page",
  "list_branches",
  "list_jobs",
  "list_pinned_branches",
  "list_private_ignores",
  "list_projects",
  "list_sources",
  "lookup_symbol",
  "pin_branches",
  "queue_status",
  "reindex_all",
  "reindex_project",
  "reindex_source",
  "reindex_status",
  "remove_project",
  "remove_source",
  "search_code",
  "search_knowledge",
  "set_private_ignore",
  "unpin_branches",
  "update_project",
  "update_source",
] as const;
