/**
 * MCP tools for managing per-source private ignore rules.
 * Storage: DATA_DIR/ignores/<project_id>/<source_id>.gitignore
 */
import { existsSync, statSync } from "fs";
import { getProject, listProjects } from "../registry.js";
import {
  loadPrivateIgnore,
  savePrivateIgnore,
  getPrivateIgnorePath,
  isMissingOrEmpty,
  countRules,
} from "../private-ignore.js";
import type { Tool } from "./types.js";

// ─── set_private_ignore ───────────────────────────────────────────────────────

interface SetPrivateIgnoreInput {
  project_id: string;
  source_id: string;
  content: string;
}

interface SetPrivateIgnoreOutput {
  ok: boolean;
  path: string;
  action: "written" | "deleted" | "unchanged";
  hint: string;
}

export const setPrivateIgnoreTool: Tool<SetPrivateIgnoreInput, SetPrivateIgnoreOutput> = {
  spec: {
    name: "set_private_ignore",
    description:
      "Set or clear private ignore rules for a code source. " +
      "**Replaces the entire file content** — to add a single pattern to existing rules, " +
      "call `get_private_ignore` first, append your pattern, then call `set_private_ignore` " +
      "with the concatenated content. Pass empty string to delete the file. " +
      "Only code sources are supported (knowledge sources have a different ignore model). " +
      "Returns `{ ok, path, action, hint }`. `hint` includes the exact reindex command to apply changes.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project identifier" },
        source_id: { type: "string", description: "Source identifier (must be a code source)" },
        content: {
          type: "string",
          description:
            "Full new content of the private ignore file (gitignore syntax). " +
            "Empty string = delete the file (no private ignore rules).",
        },
      },
      required: ["project_id", "source_id", "content"],
    },
    annotations: { idempotentHint: false, openWorldHint: false },
  },
  handler: async ({ project_id, source_id, content }) => {
    // Validate: project + source must exist and be a code source
    const project = getProject(project_id);
    if (!project) throw new Error(`Project '${project_id}' not found`);
    const source = project.sources.find((s) => s.source_id === source_id);
    if (!source) throw new Error(`Source '${source_id}' not found in project '${project_id}'`);
    if (source.source_config.type !== "code") {
      throw new Error(
        `Source '${source_id}' in project '${project_id}' is a '${source.source_config.type}' source. ` +
        `Private ignore rules only apply to code sources. Knowledge source ignores are on the roadmap.`
      );
    }

    const filePath = getPrivateIgnorePath(project_id, source_id);
    const isEmpty = !content || isMissingOrEmpty(content);

    const prevContent = loadPrivateIgnore(project_id, source_id);
    let action: "written" | "deleted" | "unchanged";

    if (isEmpty) {
      if (prevContent === null || isMissingOrEmpty(prevContent)) {
        action = "unchanged";
      } else {
        savePrivateIgnore(project_id, source_id, null);
        action = "deleted";
      }
    } else if (content === prevContent) {
      action = "unchanged";
    } else {
      savePrivateIgnore(project_id, source_id, content);
      action = "written";
    }

    const hint =
      `To apply changes, run: scrybe index -P ${project_id} -S ${source_id} --incremental` +
      `\n  (or via MCP: reindex_source with project_id="${project_id}", source_id="${source_id}", mode="incremental")`;

    return { ok: true, path: filePath, action, hint };
  },
};

// ─── get_private_ignore ───────────────────────────────────────────────────────

interface GetPrivateIgnoreInput {
  project_id: string;
  source_id: string;
}

interface GetPrivateIgnoreOutput {
  project_id: string;
  source_id: string;
  content: string | null;
  path: string;
  rule_count: number;
}

export const getPrivateIgnoreTool: Tool<GetPrivateIgnoreInput, GetPrivateIgnoreOutput> = {
  spec: {
    name: "get_private_ignore",
    description:
      "Read the current private ignore content for a code source. " +
      "Returns `null` if no file exists. " +
      "Use before `set_private_ignore` when adding patterns to existing rules.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project identifier" },
        source_id: { type: "string", description: "Source identifier" },
      },
      required: ["project_id", "source_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ project_id, source_id }) => {
    const project = getProject(project_id);
    if (!project) throw new Error(`Project '${project_id}' not found`);
    const source = project.sources.find((s) => s.source_id === source_id);
    if (!source) throw new Error(`Source '${source_id}' not found in project '${project_id}'`);

    const content = loadPrivateIgnore(project_id, source_id);
    const path = getPrivateIgnorePath(project_id, source_id);

    return {
      project_id,
      source_id,
      content,
      path,
      rule_count: countRules(content),
    };
  },
};

// ─── list_private_ignores ─────────────────────────────────────────────────────

interface ListPrivateIgnoresInput {
  project_id?: string;
}

interface PrivateIgnoreEntry {
  project_id: string;
  source_id: string;
  path: string;
  rule_count: number;
  mtime: string | null;
}

export const listPrivateIgnoresTool: Tool<ListPrivateIgnoresInput, PrivateIgnoreEntry[]> = {
  spec: {
    name: "list_private_ignores",
    description:
      "Enumerate all private ignore files across all registered projects. " +
      "Returns metadata only (project_id, source_id, mtime, rule_count). " +
      "For full content, use `get_private_ignore`.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Limit to a specific project (omit for all projects)",
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ project_id }) => {
    const projects = project_id ? (() => {
      const p = getProject(project_id);
      if (!p) throw new Error(`Project '${project_id}' not found`);
      return [p];
    })() : listProjects();

    const results: PrivateIgnoreEntry[] = [];

    for (const project of projects) {
      for (const source of project.sources) {
        if (source.source_config.type !== "code") continue;
        const content = loadPrivateIgnore(project.id, source.source_id);
        if (isMissingOrEmpty(content)) continue; // skip sources with no effective rules
        const path = getPrivateIgnorePath(project.id, source.source_id);
        let mtime: string | null = null;
        if (existsSync(path)) {
          try {
            mtime = statSync(path).mtime.toISOString();
          } catch { /* ignore */ }
        }
        results.push({
          project_id: project.id,
          source_id: source.source_id,
          path,
          rule_count: countRules(content),
          mtime,
        });
      }
    }

    return results;
  },
};
