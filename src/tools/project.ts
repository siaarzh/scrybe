import type { Command } from "commander";
import {
  listProjects,
  addProject,
  updateProject,
  removeProject,
  isSearchable,
} from "../registry.js";
import { getPlugin } from "../plugins/index.js";
import type { Tool } from "./types.js";

type ProjectRow = {
  id: string;
  description: string;
  sources: {
    source_id: string;
    source_type: string;
    embedding_profile: string;
    last_indexed: string | null;
    searchable: boolean;
    searchable_reason: string | undefined;
  }[];
};

function buildListProjectsOutput(): ProjectRow[] {
  return listProjects().map((project) => ({
    id: project.id,
    description: project.description,
    sources: project.sources.map((source) => {
      let sourceType: string;
      try { sourceType = source.source_config.type; } catch { sourceType = "unknown"; }
      let profile: string;
      try { profile = getPlugin(source.source_config.type).embeddingProfile; } catch { profile = "unknown"; }
      const { ok, reason } = isSearchable(source);
      return {
        source_id: source.source_id,
        source_type: sourceType,
        embedding_profile: profile,
        last_indexed: source.last_indexed ?? null,
        searchable: ok,
        searchable_reason: ok ? undefined : reason,
      };
    }),
  }));
}

export const listProjectsTool: Tool<Record<string, never>, ProjectRow[]> = {
  spec: {
    name: "list_projects",
    cliName: "project list",
    description: "List all registered projects and their sources. Use this first to see what's indexed and searchable before calling search_code or search_knowledge.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async () => buildListProjectsOutput(),
  cliOpts: () => ({}),
  formatCli: (projects) => {
    if (projects.length === 0) return "No projects registered.";
    const nonSearchableReasons: string[] = [];
    const lines = projects.map((p) => {
      const header = `\n${p.id}${p.description ? ` — ${p.description}` : ""}`;
      if (p.sources.length === 0) return `${header}\n  (no sources)`;
      const srcLines = p.sources.map((s) => {
        let icon: string;
        if (!s.last_indexed) { icon = "○"; }
        else if (s.searchable) { icon = "✓"; }
        else { icon = "✗"; nonSearchableReasons.push(`  ${p.id}/${s.source_id}: ${s.searchable_reason}`); }
        const indexed = s.last_indexed ? s.last_indexed.replace("T", " ").slice(0, 16) : "never";
        return `  ${icon} ${s.source_id.padEnd(20)} ${s.source_type.padEnd(10)} ${indexed}`;
      });
      return `${header}\n${srcLines.join("\n")}`;
    });
    const footer = nonSearchableReasons.length > 0
      ? `\n\n✗ Not searchable — missing config:\n${nonSearchableReasons.join("\n")}`
      : "";
    return lines.join("") + footer;
  },
};

export const addProjectTool: Tool<
  { project_id: string; description?: string },
  { ok: boolean; project_id: string }
> = {
  spec: {
    name: "add_project",
    cliName: "project add",
    description: "Register a new project container. Add sources to it with source add.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Unique project identifier" },
        description: { type: "string", description: "Human-readable description" },
      },
      required: ["project_id"],
    },
    annotations: { openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .requiredOption("--id <id>", "Project identifier")
      .option("--desc <text>", "Description", "")
      .addHelpText("after", "\nExample:\n  scrybe project add --id myrepo --desc \"My project\""),
  },
  handler: async ({ project_id, description }) => {
    addProject({ id: project_id, description: description ?? "" });
    return { ok: true, project_id };
  },
  cliOpts: ([opts]) => ({ project_id: String(opts.id), description: opts.desc ? String(opts.desc) : undefined }),
  formatCli: ({ project_id }) => `Added project '${project_id}'`,
};

export const updateProjectTool: Tool<
  { project_id: string; description?: string },
  { id: string; description: string }
> = {
  spec: {
    name: "update_project",
    cliName: "project update",
    description: "Update a project's description.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        description: { type: "string" },
      },
      required: ["project_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .argument("[id]", "Project identifier (positional)")
      .option("--id <id>", "Project identifier (flag, backward-compat alias for positional)")
      .option("--desc <text>", "New description")
      .addHelpText("after", "\nExample:\n  scrybe project update myrepo --desc \"Updated description\""),
  },
  handler: async ({ project_id, description }) => {
    return updateProject(project_id, {
      ...(description !== undefined && { description }),
    }) as { id: string; description: string };
  },
  cliOpts: ([arg, opts]) => {
    const id = (arg as string | undefined) ?? (opts as any).id;
    if (!id) throw new Error("project id required (positional or --id)");
    return { project_id: String(id), description: (opts as any).desc ? String((opts as any).desc) : undefined };
  },
  formatCli: (updated) => `Updated project '${updated.id}'`,
};

export const removeProjectTool: Tool<
  { project_id: string },
  { ok: boolean; project_id: string }
> = {
  spec: {
    name: "remove_project",
    cliName: "project remove",
    description: "Unregister a project and drop all its source tables (vector data deleted).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
    annotations: { destructiveHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .argument("[id]", "Project identifier (positional)")
      .option("--id <id>", "Project identifier (flag, backward-compat alias for positional)")
      .addHelpText("after", "\nExamples:\n  scrybe project remove myrepo\n  scrybe project rm myrepo"),
  },
  handler: async ({ project_id }) => {
    await removeProject(project_id);
    return { ok: true, project_id };
  },
  cliOpts: ([arg, opts]) => {
    const id = (arg as string | undefined) ?? (opts as any).id;
    if (!id) throw new Error("project id required (positional or --id)");
    return { project_id: String(id) };
  },
  formatCli: ({ project_id }) => `Removed project '${project_id}'`,
};
