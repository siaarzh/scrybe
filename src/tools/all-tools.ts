import type { Tool } from "./types.js";
import { listProjectsTool, addProjectTool, updateProjectTool, removeProjectTool } from "./project.js";
import { listSourcesTool, addSourceTool, updateSourceTool, removeSourceTool } from "./source.js";
import { searchCodeTool, searchKnowledgeTool } from "./search.js";
import {
  reindexAllTool,
  reindexProjectTool,
  reindexSourceTool,
  reindexStatusTool,
  cancelReindexTool,
  listJobsTool,
  queueStatusTool,
} from "./reindex.js";
import { listBranchesTool, listPinnedBranchesTool, pinBranchesTool, unpinBranchesTool } from "./branch.js";

/** All tools in the registry (MCP + CLI). */
export const allTools: Tool<any, any>[] = [
  // Project
  listProjectsTool,
  addProjectTool,
  updateProjectTool,
  removeProjectTool,
  // Source
  listSourcesTool,
  addSourceTool,
  updateSourceTool,
  removeSourceTool,
  // Search
  searchCodeTool,
  searchKnowledgeTool,
  // Reindex
  reindexAllTool,
  reindexProjectTool,
  reindexSourceTool,
  reindexStatusTool,
  cancelReindexTool,
  listJobsTool,
  queueStatusTool,
  // Branch
  listBranchesTool,
  listPinnedBranchesTool,
  pinBranchesTool,
  unpinBranchesTool,
];

/** MCP-registered tools only (excludes cliOnly). */
export const mcpTools = allTools.filter((t) => !t.spec.cliOnly);

/** CLI-registered tools only (those with cliName set). */
export const cliTools = allTools.filter((t) => t.spec.cliName);
