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
import { validateGithubToken } from "../plugins/github-issues.js";
import { submitSourceJob } from "../jobs.js";
import { ensureRunning, DaemonClient } from "../daemon/client.js";
import { config } from "../config.js";
import type { Source, SourceConfig } from "../types.js";
import type { Tool } from "./types.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Generic ticket input fields (new API) + deprecated gitlab_* aliases. */
interface TicketFields {
  // Generic (new)
  provider?: string;
  url?: string;
  project?: string;
  token?: string;
  // Deprecated aliases
  gitlab_url?: string;
  gitlab_project_id?: string;
  gitlab_token?: string;
}

/**
 * Resolve generic + deprecated-alias ticket fields into a canonical set.
 * Deprecated aliases map: gitlab_url → url, gitlab_project_id → project, gitlab_token → token.
 * Emits a deprecation warning when any alias is used.
 * Returns { provider, url, project, token } with provider defaulting to "gitlab".
 */
export function resolveTicketFields(fields: TicketFields, warnFn: (msg: string) => void = console.warn): {
  provider: string; url: string; project: string; token: string;
} {
  let { provider, url, project, token } = fields;

  // Deprecated alias mapping
  if (fields.gitlab_url !== undefined) {
    warnFn(
      "[scrybe] --gitlab-url is deprecated. Use --url instead. The --gitlab-* flags will be removed in a future major version."
    );
    url = url ?? fields.gitlab_url;
  }
  if (fields.gitlab_project_id !== undefined) {
    warnFn(
      "[scrybe] --gitlab-project-id is deprecated. Use --project instead. The --gitlab-* flags will be removed in a future major version."
    );
    project = project ?? fields.gitlab_project_id;
  }
  if (fields.gitlab_token !== undefined) {
    warnFn(
      "[scrybe] --gitlab-token is deprecated. Use --token instead. The --gitlab-* flags will be removed in a future major version."
    );
    token = token ?? fields.gitlab_token;
  }

  return {
    provider: provider ?? "gitlab",
    url: url ?? "",
    project: project ?? "",
    token: token ?? "",
  };
}

function buildSourceConfig(
  sourceType: string,
  fields: {
    root?: string; languages?: string; root_path?: string;
    // Generic ticket fields (new)
    provider?: string; url?: string; project?: string; token?: string;
    // Deprecated aliases
    gitlab_url?: string; gitlab_project_id?: string; gitlab_token?: string;
  }
): SourceConfig {
  if (sourceType === "code") {
    const root = fields.root ?? fields.root_path ?? "";
    const langs = fields.languages ? fields.languages.split(",").map((l) => l.trim()) : [];
    return { type: "code", root_path: root, languages: langs };
  }
  if (sourceType === "ticket") {
    const resolved = resolveTicketFields(fields);
    return {
      type: "ticket",
      provider: resolved.provider,
      base_url: resolved.url,
      project_id: resolved.project,
      token: resolved.token,
    };
  }
  return { type: sourceType };
}

/** Route to the appropriate token validator based on provider. */
async function validateToken(sc: SourceConfig): Promise<void> {
  if (sc.type !== "ticket") return;
  const c = sc as Extract<SourceConfig, { type: "ticket" }>;
  if (c.provider === "github") {
    await validateGithubToken(sc);
  } else {
    // Default: gitlab (covers unset provider for back-compat)
    await validateGitlabToken(sc);
  }
}

function applySourceAddOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-P, --project-id <id>", "Project ID")
    .requiredOption("-S, --source-id <id>", "Source ID (e.g. code, gitlab-issues)")
    .requiredOption("--type <type>", "Source type: code | ticket")
    .option("--root <path>", "Absolute path to repo root (required for type=code)")
    .option("--languages <langs>", "Comma-separated language hints (for type=code)", "")
    // Generic ticket fields (new)
    .option("--provider <provider>", "Ticket provider: gitlab | github (default: gitlab)")
    .option("--url <url>", "Provider base URL (required for GitLab; optional for GitHub — defaults to https://api.github.com)")
    .option("--project <id>", "Provider-scoped project identifier: GitLab numeric id or path; GitHub owner/repo")
    .option("--token <token>", "Personal access token (literal or ${VAR} form)")
    // Deprecated aliases
    .option("--gitlab-url <url>", "[deprecated: use --url] GitLab instance base URL")
    .option("--gitlab-project-id <id>", "[deprecated: use --project] GitLab project ID or path")
    .option("--gitlab-token <token>", "[deprecated: use --token] GitLab personal access token")
    .addHelpText(
      "after",
      "\nExamples:\n  scrybe source add -P myrepo -S code --type code --root /path/to/repo --languages ts,vue" +
      "\n  scrybe source add -P myrepo -S tickets --type ticket --provider gitlab --url https://gitlab.example.com --project 42 --token $TOKEN" +
      "\n  scrybe source add -P myrepo -S gh-issues --type ticket --provider github --project owner/repo --token '${SCRYBE_GITHUB_TOKEN}'"
    );
}

function applySourceUpdateOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-P, --project-id <id>", "Project ID")
    .requiredOption("-S, --source-id <id>", "Source ID")
    // Generic ticket fields (new)
    .option("--url <url>", "Provider base URL")
    .option("--project <id>", "Provider-scoped project identifier")
    .option("--token <token>", "New personal access token (literal or ${VAR} form)")
    // Deprecated aliases
    .option("--gitlab-token <token>", "[deprecated: use --token] New GitLab personal access token")
    .option("--gitlab-url <url>", "[deprecated: use --url] GitLab instance base URL")
    .option("--gitlab-project-id <id>", "[deprecated: use --project] GitLab project ID or path")
    .option("--root <path>", "Absolute path to repo root")
    .option("--languages <langs>", "Comma-separated language hints")
    .addHelpText("after", "\nExamples:\n  scrybe source update -P myrepo -S tickets --token $NEW_TOKEN\n  scrybe source update -P myrepo -S tickets --gitlab-token $NEW_TOKEN  # deprecated");
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
    // Generic ticket fields (new)
    provider?: string; url?: string; project?: string; token?: string;
    // Deprecated aliases
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
    description: "Add an indexable source to a project (code repo, GitLab/GitHub issues, etc.) and auto-enqueue a reindex. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string", description: 'User-defined label, e.g. "code", "gitlab-issues"' },
        source_type: { type: "string", enum: ["code", "ticket"], description: "Source type: code | ticket" },
        root_path: { type: "string", description: "Absolute path to repo root (required for type=code)" },
        languages: { type: "array", items: { type: "string" }, description: "Language hints for code source" },
        // Generic ticket fields (new)
        provider: { type: "string", enum: ["gitlab", "github"], description: "Ticket provider (default: gitlab)" },
        url: { type: "string", description: "Provider base URL. Required for GitLab; optional for GitHub (defaults to https://api.github.com)" },
        project: { type: "string", description: "Provider-scoped project identifier: GitLab numeric id or path; GitHub owner/repo" },
        token: { type: "string", description: "Personal access token (literal or ${VAR} form)" },
        // Deprecated aliases
        gitlab_url: { type: "string", description: "[deprecated: use url] GitLab instance base URL" },
        gitlab_project_id: { type: "string", description: "[deprecated: use project] GitLab project ID or path" },
        gitlab_token: { type: "string", description: "[deprecated: use token] GitLab personal access token" },
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
      provider: input.provider,
      url: input.url,
      project: input.project,
      token: input.token,
      gitlab_url: input.gitlab_url,
      gitlab_project_id: input.gitlab_project_id,
      gitlab_token: input.gitlab_token,
    });
    await validateToken(sc);

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
    // Generic ticket fields
    provider: opts.provider ? String(opts.provider) : undefined,
    url: opts.url ? String(opts.url) : undefined,
    project: opts.project ? String(opts.project) : undefined,
    token: opts.token ? String(opts.token) : undefined,
    // Deprecated aliases
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
    // Generic ticket fields (new)
    url?: string; project?: string; token?: string;
    // Deprecated aliases
    gitlab_token?: string; gitlab_url?: string; gitlab_project_id?: string;
    root_path?: string; languages?: string;
  },
  { ok: boolean; project_id: string; source_id: string; updated: boolean }
> = {
  spec: {
    name: "update_source",
    cliName: "source update",
    description: "Update an existing source's config — e.g. refresh a token, change root path, or update language hints. Only the fields you provide are changed.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
        // Generic ticket fields (new)
        url: { type: "string", description: "Provider base URL" },
        project: { type: "string", description: "Provider-scoped project identifier" },
        token: { type: "string", description: "New personal access token (literal or ${VAR} form)" },
        // Deprecated aliases
        gitlab_token: { type: "string", description: "[deprecated: use token] New GitLab personal access token" },
        gitlab_url: { type: "string", description: "[deprecated: use url] GitLab instance base URL" },
        gitlab_project_id: { type: "string", description: "[deprecated: use project] GitLab project ID or path" },
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
      // Resolve generic + deprecated aliases for update (no provider change allowed)
      const resolved = resolveTicketFields({
        url: input.url,
        project: input.project,
        token: input.token,
        gitlab_url: input.gitlab_url,
        gitlab_project_id: input.gitlab_project_id,
        gitlab_token: input.gitlab_token,
      });
      if (input.token || input.gitlab_token) scPatch["token"] = resolved.token;
      if (input.url || input.gitlab_url) scPatch["base_url"] = resolved.url;
      if (input.project || input.gitlab_project_id) scPatch["project_id"] = resolved.project;
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
    // Generic ticket fields
    url: opts.url ? String(opts.url) : undefined,
    project: opts.project ? String(opts.project) : undefined,
    token: opts.token ? String(opts.token) : undefined,
    // Deprecated aliases
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
