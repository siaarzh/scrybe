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
import type { Source, SourceConfig, EmbeddingConfig } from "../types.js";
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

function buildEmbedding(
  f: {
    embeddingBaseUrl?: string; embeddingModel?: string;
    embeddingDimensions?: string; embeddingApiKeyEnv?: string;
    embedding_base_url?: string; embedding_model?: string;
    embedding_dimensions?: number; embedding_api_key_env?: string;
  }
): EmbeddingConfig | undefined {
  const bu = f.embeddingBaseUrl ?? f.embedding_base_url;
  const mo = f.embeddingModel ?? f.embedding_model;
  const di = f.embeddingDimensions ? parseInt(String(f.embeddingDimensions), 10) : f.embedding_dimensions;
  const ak = f.embeddingApiKeyEnv ?? f.embedding_api_key_env;
  if (!bu && !mo && !di && !ak) return undefined;
  return {
    base_url: bu ?? "",
    model: mo ?? "",
    dimensions: di ?? 1536,
    api_key_env: ak ?? "EMBEDDING_API_KEY",
  };
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
    .option("--embedding-base-url <url>", "Override embedding base URL")
    .option("--embedding-model <model>", "Override embedding model")
    .option("--embedding-dimensions <n>", "Override embedding dimensions")
    .option("--embedding-api-key-env <var>", "Env var NAME holding API key")
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
    .option("--embedding-base-url <url>", "Override embedding base URL")
    .option("--embedding-model <model>", "Override embedding model")
    .option("--embedding-dimensions <n>", "Override embedding dimensions")
    .option("--embedding-api-key-env <var>", "Env var NAME holding API key")
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
    embedding_base_url?: string; embedding_model?: string;
    embedding_dimensions?: number; embedding_api_key_env?: string;
  },
  { ok: boolean; project_id: string; source_id: string }
> = {
  spec: {
    name: "add_source",
    cliName: "source add",
    description: "Add an indexable source to a project (code repo, GitLab issues, etc.). Then call index to index it.",
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
        embedding_base_url: { type: "string" },
        embedding_model: { type: "string" },
        embedding_dimensions: { type: "number" },
        embedding_api_key_env: { type: "string", description: "Env var NAME holding the API key" },
      },
      required: ["project_id", "source_id", "source_type"],
    },
    cliArgs: (cmd: Command) => applySourceAddOptions(cmd),
  },
  handler: async (input) => {
    const { project_id, source_id, source_type } = input;
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
    const emb = buildEmbedding({
      embedding_base_url: input.embedding_base_url,
      embedding_model: input.embedding_model,
      embedding_dimensions: input.embedding_dimensions,
      embedding_api_key_env: input.embedding_api_key_env,
    });
    const src: Omit<Source, "table_name" | "last_indexed"> = {
      source_id,
      source_config: sc,
      ...(emb && { embedding: emb }),
    };
    addSource(project_id, src);
    return { ok: true, project_id, source_id };
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
    embedding_base_url: opts.embeddingBaseUrl ? String(opts.embeddingBaseUrl) : undefined,
    embedding_model: opts.embeddingModel ? String(opts.embeddingModel) : undefined,
    embedding_dimensions: opts.embeddingDimensions ? parseInt(String(opts.embeddingDimensions), 10) : undefined,
    embedding_api_key_env: opts.embeddingApiKeyEnv ? String(opts.embeddingApiKeyEnv) : undefined,
  }),
  formatCli: ({ project_id, source_id }) => `Added source '${source_id}' to project '${project_id}'`,
};

export const updateSourceTool: Tool<
  {
    project_id: string; source_id: string;
    gitlab_token?: string; gitlab_url?: string; gitlab_project_id?: string;
    root_path?: string; languages?: string;
    embedding_base_url?: string; embedding_model?: string;
    embedding_dimensions?: number; embedding_api_key_env?: string;
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
        embedding_base_url: { type: "string" },
        embedding_model: { type: "string" },
        embedding_dimensions: { type: "number" },
        embedding_api_key_env: { type: "string", description: "Env var NAME holding the API key" },
      },
      required: ["project_id", "source_id"],
    },
    annotations: { openWorldHint: false },
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
    const emb = buildEmbedding({
      embedding_base_url: input.embedding_base_url,
      embedding_model: input.embedding_model,
      embedding_dimensions: input.embedding_dimensions,
      embedding_api_key_env: input.embedding_api_key_env,
    });
    if (emb) fields.embedding = emb;
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
    embedding_base_url: opts.embeddingBaseUrl ? String(opts.embeddingBaseUrl) : undefined,
    embedding_model: opts.embeddingModel ? String(opts.embeddingModel) : undefined,
    embedding_dimensions: opts.embeddingDimensions ? parseInt(String(opts.embeddingDimensions), 10) : undefined,
    embedding_api_key_env: opts.embeddingApiKeyEnv ? String(opts.embeddingApiKeyEnv) : undefined,
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
