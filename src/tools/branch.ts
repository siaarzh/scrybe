import { getProject } from "../registry.js";
import { listBranches } from "../branch-state.js";
import {
  listPinned,
  addPinned,
  removePinned,
  clearPinned,
  InvalidSourceTypeError,
  SourceNotFoundError,
  ProjectNotFoundError,
} from "../pinned-branches.js";
import { checkIgnoreCoverage } from "../private-ignore.js";
import type { Tool } from "./types.js";

type BranchEntry = { source_id: string; branches: string[] };

export const listBranchesTool: Tool<
  { project_id: string; source_id?: string },
  BranchEntry[]
> = {
  spec: {
    name: "list_branches",
    // No cliName — CLI registration handles branch list / branch list --pinned as a composite
    description: "List branches that have been indexed for a project's sources. Each code source maintains separate indexed chunks per branch. Non-code sources (tickets) always use the branch sentinel '*'.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string", description: "Limit to a specific source (omit for all sources)" },
      },
      required: ["project_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ project_id, source_id }) => {
    const project = getProject(project_id);
    if (!project) throw new Error(`Project '${project_id}' not found`);
    const sources = source_id
      ? project.sources.filter((s) => s.source_id === source_id)
      : project.sources;
    return sources.map((s) => ({
      source_id: s.source_id,
      branches: s.source_config.type === "code" ? listBranches(project_id, s.source_id) : ["*"],
    }));
  },
};

export const listPinnedBranchesTool: Tool<
  { project_id: string; source_id?: string },
  BranchEntry[]
> = {
  spec: {
    name: "list_pinned_branches",
    description: "List branches pinned for background daemon indexing on a project's code source(s). Pinned branches are kept current by the daemon without requiring a manual scrybe index --branch call.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string", description: "Specific source (omit to list all code sources)" },
      },
      required: ["project_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async ({ project_id, source_id }) => {
    const project = getProject(project_id);
    if (!project) throw new Error(`Project '${project_id}' not found`);
    const sources = source_id
      ? project.sources.filter((s) => s.source_id === source_id && s.source_config.type === "code")
      : project.sources.filter((s) => s.source_config.type === "code");
    return sources.map((s) => ({
      source_id: s.source_id,
      branches: listPinned(project_id, s.source_id),
    }));
  },
};

// Pin result type extended with ignore coverage warnings
type PinResult = ReturnType<typeof addPinned> & { ignore_warnings?: string[] };

export const pinBranchesTool: Tool<
  { project_id: string; source_id?: string; branches: string[]; mode?: "add" | "set" },
  PinResult
> = {
  spec: {
    name: "pin_branches",
    cliName: "branch pin",
    description: "Add (or replace) pinned branches on a code source. mode='add' (default) merges with the existing list; mode='set' replaces it. Returns warnings if pinned count exceeds 20 or if a branch has no ignore coverage.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string", description: "Source identifier (default: primary)" },
        branches: { type: "array", items: { type: "string" }, description: "Branch names to pin" },
        mode: { type: "string", enum: ["add", "set"], description: "add (default) or set (replace)" },
      },
      required: ["project_id", "branches"],
    },
    annotations: { idempotentHint: true, openWorldHint: false },
    cliArgs: (cmd) => cmd
      .requiredOption("-P, --project-id <id>", "Project identifier")
      .option("-S, --source-id <id>", "Source identifier", "primary")
      .argument("<branches...>", "Branch names to pin")
      .addHelpText("after", "\nExample:\n  scrybe branch pin -P myrepo feature/my-feature"),
  },
  handler: async ({ project_id, source_id, branches, mode }) => {
    const resolvedSourceId = source_id ?? "primary";
    try {
      const result = addPinned(project_id, resolvedSourceId, branches, mode ?? "add");

      // Check ignore coverage for each newly-pinned branch
      const ignore_warnings: string[] = [];
      const project = getProject(project_id);
      const codeSource = project?.sources.find((s) => s.source_id === resolvedSourceId && s.source_config.type === "code");
      if (codeSource) {
        const rootPath = (codeSource.source_config as { type: "code"; root_path: string }).root_path;
        for (const branch of result.added) {
          const coverage = checkIgnoreCoverage(rootPath, branch, project_id, resolvedSourceId);
          if (!coverage.hasCoverage && coverage.message) {
            ignore_warnings.push(coverage.message);
          }
        }
      }

      return { ...result, ignore_warnings: ignore_warnings.length > 0 ? ignore_warnings : undefined };
    } catch (err) {
      if (err instanceof InvalidSourceTypeError || err instanceof SourceNotFoundError || err instanceof ProjectNotFoundError) {
        throw new Error(err.message);
      }
      throw err;
    }
  },
  cliOpts: ([branches, opts]) => ({
    project_id: String(opts.projectId),
    source_id: String(opts.sourceId ?? "primary"),
    branches: branches as string[],
  }),
  formatCli: (result) => {
    const lines = [JSON.stringify(result, null, 2)];
    for (const w of result.warnings) lines.push(`warning: ${w}`);
    if (result.ignore_warnings) {
      for (const w of result.ignore_warnings) process.stderr.write(`\x1b[33m${w}\x1b[0m\n`);
    }
    return lines.join("\n");
  },
};

export const unpinBranchesTool: Tool<
  { project_id: string; source_id?: string; branches: string[] },
  ReturnType<typeof removePinned>
> = {
  spec: {
    name: "unpin_branches",
    cliName: "branch unpin",
    description: "Remove branches from the pinned list. Silently no-ops on branches not currently pinned. Does NOT delete indexed data — run scrybe gc to remove orphan chunks.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string", description: "Source identifier (default: primary)" },
        branches: { type: "array", items: { type: "string" }, description: "Branch names to unpin" },
      },
      required: ["project_id", "branches"],
    },
    annotations: { idempotentHint: true, openWorldHint: false },
    // cliArgs handled in thin cli.ts (the --all/--yes flags need special CLI logic)
  },
  handler: async ({ project_id, source_id, branches }) => {
    try {
      return removePinned(project_id, source_id ?? "primary", branches);
    } catch (err) {
      if (err instanceof InvalidSourceTypeError || err instanceof SourceNotFoundError || err instanceof ProjectNotFoundError) {
        throw new Error(err.message);
      }
      throw err;
    }
  },
};

/** clearPinned exported for CLI 'branch unpin --all' special case. */
export { clearPinned };
