import type { Command } from "commander";
import {
  listProjects,
  addSource,
  updateSource,
  getSource,
  removeSource,
  getProject,
  isSearchable,
} from "../registry.js";
import { validateGitlabToken } from "../plugins/gitlab-issues.js";
import { submitSourceJob } from "../jobs.js";
import { ensureRunning, DaemonClient } from "../daemon/client.js";
import { config } from "../config.js";
import type { Source, SourceConfig } from "../types.js";
import type { Tool } from "./types.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function buildSourceConfig(
  sourceType: string,
  fields: {
    root?: string; languages?: string; root_path?: string;
    gitlab_url?: string; gitlab_project_id?: string; gitlab_token?: string;
  }
): SourceConfig {
  if (sourceType === "code") {
    const root = fields.root ?? fields.root_path ?? "";
    const langs = fields.languages ? fields.languages.split(",").map((l) => l.trim()) : [];
    return { type: "code", root_path: root, languages: langs };
  }
  if (sourceType === "ticket") {
    return {
      type: "ticket",
      provider: "gitlab",
      base_url: fields.gitlab_url ?? "",
      project_id: fields.gitlab_project_id ?? "",
      token: fields.gitlab_token ?? "",
    };
  }
  return { type: sourceType };
}

function applySourceAddOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-P, --project-id <id>", "Project ID")
    .requiredOption("-S, --source-id <id>", "Source ID (e.g. code, gitlab-issues)")
    .requiredOption("--type <type>", "Source type: code | ticket")
    .option("--root <path>", "Absolute path to repo root (required for type=code)")
    .option("--languages <langs>", "Comma-separated language hints (for type=code)", "")
    .option("--gitlab-url <url>", "GitLab instance base URL (required for type=ticket)")
    .option("--gitlab-project-id <id>", "GitLab project ID or path (required for type=ticket)")
    .option("--gitlab-token <token>", "GitLab personal access token (required for type=ticket)")
    .addHelpText(
      "after",
      "\nExamples:\n  scrybe source add -P myrepo -S code --type code --root /path/to/repo --languages ts,vue" +
      "\n  scrybe source add -P myrepo -S tickets --type ticket --gitlab-url https://gitlab.example.com --gitlab-project-id 42 --gitlab-token $TOKEN"
    );
}

function applySourceUpdateOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-P, --project-id <id>", "Project ID")
    .requiredOption("-S, --source-id <id>", "Source ID")
    .option("--gitlab-token <token>", "New GitLab personal access token")
    .option("--gitlab-url <url>", "GitLab instance base URL")
    .option("--gitlab-project-id <id>", "GitLab project ID or path")
    .option("--root <path>", "Absolute path to repo root")
    .option("--languages <langs>", "Comma-separated language hints")
    .addHelpText("after", "\nExample:\n  scrybe source update -P myrepo -S tickets --gitlab-token $NEW_TOKEN");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const listSourcesTool: Tool<
  { project_id?: string },
  { id: string; sources: { source_id: string; source_type: string; searchable: boolean; last_indexed: string | null }[] }[]
> = {
  spec: {
    name: "list_sources",
    cliName: "source list",
    cliOnly: true,
    description: "List all sources (optionally filter by project).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Limit to a specific project" } },
    },
    cliArgs: (cmd: Command) => cmd
      .option("-P, --project-id <id>", "Limit to a specific project")
      .addHelpText("after", "\nExamples:\n  scrybe source list\n  scrybe source list -P myrepo"),
  },
  handler: async ({ project_id }) => {
    const projects = project_id
      ? (() => { const p = getProject(project_id); return p ? [p] : []; })()
      : listProjects();
    return projects.map((p) => ({
      id: p.id,
      sources: p.sources.map((s) => ({
        source_id: s.source_id,
        source_type: s.source_config.type,
        searchable: isSearchable(s).ok,
        last_indexed: s.last_indexed ?? null,
      })),
    }));
  },
  cliOpts: ([opts]) => ({ project_id: opts.projectId ? String(opts.projectId) : undefined }),
  formatCli: (result) => {
    if (result.every((p) => p.sources.length === 0)) return "No sources found.";
    return result.flatMap((p) =>
      p.sources.map((s) => {
        const indexed = s.last_indexed ? `indexed: ${s.last_indexed}` : "never indexed";
        return `${p.id}  [${s.source_id}] type=${s.source_type}  ${indexed}  ${s.searchable ? "searchable" : "not searchable"}`;
      })
    ).join("\n");
  },
};

export const addSourceTool: Tool<
  {
    project_id: string; source_id: string; source_type: string;
    root_path?: string; languages?: string;
    gitlab_url?: string; gitlab_project_id?: string; gitlab_token?: string;
  },
  {
    ok: boolean; project_id: string; source_id: string;
    job_id: string; status: string;
    queue_position?: number; duplicate_of_pending?: boolean;
  }
> = {
  spec: {
    name: "add_source",
    cliName: "source add",
    description: "Add an indexable source to a project (code repo, GitLab issues, etc.) and auto-enqueue a reindex. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string", description: 'User-defined label, e.g. "code", "gitlab-issues"' },
        source_type: { type: "string", enum: ["code", "ticket"], description: "Source type: code | ticket" },
        root_path: { type: "string", description: "Absolute path to repo root (required for type=code)" },
        languages: { type: "array", items: { type: "string" }, description: "Language hints for code source" },
        gitlab_url: { type: "string", description: "GitLab instance base URL (required for type=ticket)" },
        gitlab_project_id: { type: "string", description: "GitLab project ID or path (required for type=ticket)" },
        gitlab_token: { type: "string", description: "GitLab personal access token (required for type=ticket)" },
      },
      required: ["project_id", "source_id", "source_type"],
    },
    annotations: { openWorldHint: true },
    cliArgs: (cmd: Command) => applySourceAddOptions(cmd),
  },
  handler: async (input) => {
    const { project_id, source_id, source_type } = input;

    // D5 — gate on embedding config before any side effect
    const embErr = config.embeddingConfigError;
    if (embErr) throw new Error(embErr);

    const langStr = Array.isArray((input as any).languages)
      ? (input as any).languages.join(",")
      : (input.languages ?? "");
    const sc = buildSourceConfig(source_type, {
      root_path: input.root_path,
      languages: langStr,
      gitlab_url: input.gitlab_url,
      gitlab_project_id: input.gitlab_project_id,
      gitlab_token: input.gitlab_token,
    });
    await validateGitlabToken(sc);

    // D6 — decide daemon path BEFORE registry write so spawn-failed doesn't
    // leave a registered-but-never-indexed source behind
    const daemon = await ensureRunning();
    if (!daemon.ok && (daemon.reason === "spawn-failed" || daemon.reason === "health-timeout")) {
      throw Object.assign(new Error(
        "The scrybe daemon failed to start. Reindex requires the daemon to coordinate writes.\n" +
        "Diagnose: scrybe doctor  |  Single-shot: SCRYBE_NO_AUTO_DAEMON=1 scrybe index ..."
      ), { error_type: "daemon_unavailable" });
    }

    // Register the source
    const src: Omit<Source, "table_name" | "last_indexed"> = {
      source_id,
      source_config: sc,
    };
    addSource(project_id, src);

    // D3 — auto-enqueue via daemon when available
    if (daemon.ok) {
      const client = DaemonClient.fromPidfile();
      if (client) {
        const resp = await client.submitReindex({
          projectId: project_id,
          sourceId: source_id,
          mode: "incremental",
        });
        const job = resp.jobs[0];
        if (!job) throw new Error("Daemon returned no job");
        return {
          ok: true,
          project_id,
          source_id,
          job_id: job.jobId,
          status: job.status ?? "started",
          ...(job.queuePosition != null && { queue_position: job.queuePosition }),
          ...(job.duplicateOfPending && { duplicate_of_pending: true }),
        };
      }
    }

    // D6 opt-out path — in-process fallback (container / SCRYBE_NO_AUTO_DAEMON)
    const jobResult = submitSourceJob(project_id, source_id, "incremental");
    if (typeof jobResult === "object" && "error" in jobResult) {
      throw new Error(`A reindex job is already running for this project (job: ${jobResult.job_id})`);
    }
    return { ok: true, project_id, source_id, job_id: jobResult, status: "started" };
  },
  cliOpts: ([opts]) => ({
    project_id: String(opts.projectId),
    source_id: String(opts.sourceId),
    source_type: String(opts.type),
    root_path: opts.root ? String(opts.root) : undefined,
    languages: opts.languages ? String(opts.languages) : undefined,
    gitlab_url: opts.gitlabUrl ? String(opts.gitlabUrl) : undefined,
    gitlab_project_id: opts.gitlabProjectId ? String(opts.gitlabProjectId) : undefined,
    gitlab_token: opts.gitlabToken ? String(opts.gitlabToken) : undefined,
  }),
  formatCli: ({ project_id, source_id, job_id }) =>
    `Added source '${source_id}' to project '${project_id}' — reindex job: ${job_id}`,
};

export const updateSourceTool: Tool<
  {
    project_id: string; source_id: string;
    gitlab_token?: string; gitlab_url?: string; gitlab_project_id?: string;
    root_path?: string; languages?: string;
  },
  { ok: boolean; project_id: string; source_id: string; updated: boolean }
> = {
  spec: {
    name: "update_source",
    cliName: "source update",
    description: "Update an existing source's config — e.g. refresh a GitLab token, change root path, or update language hints. Only the fields you provide are changed.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
        gitlab_token: { type: "string", description: "New GitLab personal access token" },
        gitlab_url: { type: "string", description: "GitLab instance base URL" },
        gitlab_project_id: { type: "string", description: "GitLab project ID or path" },
        root_path: { type: "string", description: "Absolute path to repo root" },
        languages: { type: "array", items: { type: "string" }, description: "Language hints" },
      },
      required: ["project_id", "source_id"],
    },
    annotations: { idempotentHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => applySourceUpdateOptions(cmd),
  },
  handler: async (input) => {
    const { project_id, source_id } = input;
    const existing = getSource(project_id, source_id);
    if (!existing) throw new Error(`Source '${source_id}' not found in project '${project_id}'`);

    const fields: Partial<Source> = {};
    const scPatch: Record<string, unknown> = {};
    if (existing.source_config.type === "ticket") {
      if (input.gitlab_token) scPatch["token"] = input.gitlab_token;
      if (input.gitlab_url) scPatch["base_url"] = input.gitlab_url;
      if (input.gitlab_project_id) scPatch["project_id"] = input.gitlab_project_id;
    } else if (existing.source_config.type === "code") {
      if (input.root_path) scPatch["root_path"] = input.root_path;
      if (input.languages) scPatch["languages"] = input.languages.split(",").map((l) => l.trim());
    }
    if (Object.keys(scPatch).length > 0) {
      fields.source_config = { ...existing.source_config, ...scPatch } as Source["source_config"];
    }
    if (Object.keys(fields).length === 0) {
      return { ok: true, project_id, source_id, updated: false };
    }
    updateSource(project_id, source_id, fields);
    return { ok: true, project_id, source_id, updated: true };
  },
  cliOpts: ([opts]) => ({
    project_id: String(opts.projectId),
    source_id: String(opts.sourceId),
    gitlab_token: opts.gitlabToken ? String(opts.gitlabToken) : undefined,
    gitlab_url: opts.gitlabUrl ? String(opts.gitlabUrl) : undefined,
    gitlab_project_id: opts.gitlabProjectId ? String(opts.gitlabProjectId) : undefined,
    root_path: opts.root ? String(opts.root) : undefined,
    languages: opts.languages ? String(opts.languages) : undefined,
  }),
  formatCli: ({ source_id, project_id, updated }) =>
    updated
      ? `Updated source '${source_id}' in project '${project_id}'`
      : "Nothing to update — specify at least one option to change.",
};

export const removeSourceTool: Tool<
  { project_id: string; source_id: string },
  { ok: boolean; project_id: string; source_id: string }
> = {
  spec: {
    name: "remove_source",
    cliName: "source remove",
    description: "Remove a source from a project and drop its vector table.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
      },
      required: ["project_id", "source_id"],
    },
    annotations: { destructiveHint: true, openWorldHint: false },
    cliArgs: (cmd: Command) => cmd
      .requiredOption("-P, --project-id <id>", "Project ID")
      .requiredOption("-S, --source-id <id>", "Source ID")
      .addHelpText("after", "\nExample:\n  scrybe source remove -P myrepo -S tickets"),
  },
  handler: async ({ project_id, source_id }) => {
    await removeSource(project_id, source_id);
    return { ok: true, project_id, source_id };
  },
  cliOpts: ([opts]) => ({ project_id: String(opts.projectId), source_id: String(opts.sourceId) }),
  formatCli: ({ source_id, project_id }) => `Removed source '${source_id}' from project '${project_id}'`,
};
