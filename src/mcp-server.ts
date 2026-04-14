import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  listProjects,
  getProject,
  addProject,
  updateProject,
  removeProject,
  addSource,
  updateSource,
  getSource,
  removeSource,
  isSearchable,
  resolveEmbeddingConfig,
} from "./registry.js";
import { getPlugin } from "./plugins/index.js";
import { validateGitlabToken } from "./plugins/gitlab-issues.js";
import { VERSION } from "./config.js";
import { searchCode, searchKnowledge } from "./search.js";
import { submitJob, submitSourceJob, submitAllJob, getJobStatus, cancelJob, listJobs } from "./jobs.js";
import type { IndexMode, Source, SourceConfig, EmbeddingConfig } from "./types.js";

const TOOLS = [
  {
    name: "list_projects",
    description:
      "List all registered projects and their sources. Use this first to see what's indexed and searchable before calling search_code or search_knowledge.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "add_project",
    description: "Register a new project container. Add sources to it with add_source.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "Unique project identifier" },
        description: { type: "string", description: "Human-readable description" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "remove_project",
    description:
      "Unregister a project and drop all its source tables (vector data deleted).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "update_project",
    description: "Update a project's description.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        description: { type: "string" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "add_source",
    description:
      "Add an indexable source to a project (code repo, GitLab issues, etc.). " +
      "Then call reindex_source to index it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        source_id: {
          type: "string",
          description: 'User-defined label, e.g. "code", "gitlab-issues"',
        },
        source_type: {
          type: "string",
          enum: ["code", "ticket"],
          description: "Source type: code | ticket",
        },
        // code source fields
        root_path: {
          type: "string",
          description: "Absolute path to repo root (required for type=code)",
        },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Language hints for code source",
        },
        // ticket source fields
        gitlab_url: {
          type: "string",
          description: "GitLab instance base URL (required for type=ticket)",
        },
        gitlab_project_id: {
          type: "string",
          description: "GitLab project ID or path (required for type=ticket)",
        },
        gitlab_token: {
          type: "string",
          description: "GitLab personal access token (required for type=ticket)",
        },
        // optional embedding override
        embedding_base_url: { type: "string" },
        embedding_model: { type: "string" },
        embedding_dimensions: { type: "number" },
        embedding_api_key_env: {
          type: "string",
          description: "Env var NAME holding the API key (never the key itself)",
        },
      },
      required: ["project_id", "source_id", "source_type"],
    },
  },
  {
    name: "update_source",
    description:
      "Update an existing source's config — e.g. refresh a GitLab token, change root path, or update language hints. " +
      "Only the fields you provide are changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
        // ticket source fields
        gitlab_token: { type: "string", description: "New GitLab personal access token" },
        gitlab_url: { type: "string", description: "GitLab instance base URL" },
        gitlab_project_id: { type: "string", description: "GitLab project ID or path" },
        // code source fields
        root_path: { type: "string", description: "Absolute path to repo root" },
        languages: { type: "array", items: { type: "string" }, description: "Language hints" },
        // optional embedding override
        embedding_base_url: { type: "string" },
        embedding_model: { type: "string" },
        embedding_dimensions: { type: "number" },
        embedding_api_key_env: { type: "string", description: "Env var NAME holding the API key" },
      },
      required: ["project_id", "source_id"],
    },
  },
  {
    name: "remove_source",
    description: "Remove a source from a project and drop its vector table.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
      },
      required: ["project_id", "source_id"],
    },
  },
  {
    name: "search_code",
    description:
      "Semantically search code in a project using natural language. " +
      "Use list_projects first to confirm the project has an indexed code source.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        top_k: { type: "number", default: 10 },
      },
      required: ["project_id", "query"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "Semantically search GitLab issues, webpages, or other knowledge sources indexed in a project. " +
      "Use list_projects first to confirm the project has indexed knowledge sources. " +
      "Optionally filter by source_id (specific source) or source_types (e.g. [\"ticket\"]).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        query: { type: "string" },
        top_k: { type: "number", default: 10 },
        source_id: {
          type: "string",
          description: "Limit search to a specific source (optional)",
        },
        source_types: {
          type: "array",
          items: { type: "string" },
          description: 'Filter by source_type values, e.g. ["ticket"] (optional)',
        },
      },
      required: ["project_id", "query"],
    },
  },
  {
    name: "reindex_all",
    description:
      "Incrementally reindex all registered projects (all sources) in the background. Returns a job_id to poll with reindex_status. Check current_project in the status to see which project is currently being indexed.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "reindex_project",
    description:
      "Trigger background reindexing of all sources in a project. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        mode: {
          type: "string",
          enum: ["full", "incremental"],
          default: "incremental",
        },
        source_ids: {
          type: "array",
          items: { type: "string" },
          description: "Sources to reindex. Required when mode is 'full'.",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "reindex_source",
    description:
      "Trigger background reindexing of a single source. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
        mode: {
          type: "string",
          enum: ["full", "incremental"],
          default: "incremental",
        },
      },
      required: ["project_id", "source_id"],
    },
  },
  {
    name: "reindex_status",
    description: "Get the status of a background reindex job",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "cancel_reindex",
    description: "Cancel a running reindex job",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: { type: "string" },
        source_id: { type: "string", description: "Cancel only this source (omit to cancel entire job)" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "list_jobs",
    description: "List background reindex jobs. Like 'docker ps' — shows all jobs or filter by status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["running", "done", "failed", "cancelled"],
          description: "Filter by status (omit for all jobs)",
        },
      },
    },
  },
];

function classifyError(err: unknown): { error: string; error_type?: string } {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 429 || /429/.test(message)) {
    return {
      error:
        "Embedding API rate limit exceeded. The reindex or search cannot proceed right now. " +
        "Wait a minute and retry, or check your embedding provider's rate limit tier " +
        "(e.g. Voyage AI requires a payment method on file to unlock standard limits).",
      error_type: "rate_limit",
    };
  }
  if (status === 401 || /401|unauthorized|api.?key/i.test(message)) {
    return {
      error:
        "Embedding API authentication failed. Check that EMBEDDING_API_KEY (or OPENAI_API_KEY) is set correctly.",
      error_type: "auth",
    };
  }
  if (/EMBEDDING_DIMENSIONS=\d+/.test(message)) {
    return { error: message, error_type: "dimensions_mismatch" };
  }
  if (message.startsWith("NO_CODE_SOURCES")) {
    return {
      error: message.replace(/^NO_CODE_SOURCES:\s*/, ""),
      error_type: "no_code_sources",
    };
  }
  if (message.startsWith("NO_KNOWLEDGE_SOURCES")) {
    return {
      error: message.replace(/^NO_KNOWLEDGE_SOURCES:\s*/, ""),
      error_type: "no_knowledge_sources",
    };
  }
  if (/Unknown embedding provider|EMBEDDING_MODEL is not set/.test(message)) {
    return { error: message, error_type: "unknown_provider" };
  }
  return { error: message };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function buildListProjectsOutput() {
  return listProjects().map((project) => ({
    id: project.id,
    description: project.description,
    sources: project.sources.map((source) => {
      let sourceType: string;
      try {
        sourceType = source.source_config.type;
      } catch {
        sourceType = "unknown";
      }
      let profile: string;
      try {
        profile = getPlugin(source.source_config.type).embeddingProfile;
      } catch {
        profile = "unknown";
      }
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

function buildSourceConfig(a: Record<string, unknown>): SourceConfig {
  const sourceType = String(a.source_type);
  if (sourceType === "code") {
    return {
      type: "code",
      root_path: String(a.root_path ?? ""),
      languages: Array.isArray(a.languages)
        ? (a.languages as string[])
        : typeof a.languages === "string"
        ? a.languages.split(",").map((l: string) => l.trim())
        : [],
    };
  }
  if (sourceType === "ticket") {
    return {
      type: "ticket",
      provider: "gitlab",
      base_url: String(a.gitlab_url ?? ""),
      project_id: String(a.gitlab_project_id ?? ""),
      token: String(a.gitlab_token ?? ""),
    };
  }
  return { type: sourceType };
}

function buildEmbeddingOverride(a: Record<string, unknown>): EmbeddingConfig | undefined {
  if (
    a.embedding_base_url ||
    a.embedding_model ||
    a.embedding_dimensions ||
    a.embedding_api_key_env
  ) {
    return {
      base_url: String(a.embedding_base_url ?? ""),
      model: String(a.embedding_model ?? ""),
      dimensions: typeof a.embedding_dimensions === "number" ? a.embedding_dimensions : 1536,
      api_key_env: String(a.embedding_api_key_env ?? "EMBEDDING_API_KEY"),
    };
  }
  return undefined;
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "scrybe", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "list_projects":
          return jsonResult(buildListProjectsOutput());

        case "add_project": {
          addProject({
            id: String(a.project_id),
            description: a.description ? String(a.description) : "",
          });
          return jsonResult({ ok: true, project_id: String(a.project_id) });
        }

        case "remove_project": {
          await removeProject(String(a.project_id));
          return jsonResult({ ok: true, project_id: String(a.project_id) });
        }

        case "update_project": {
          const updated = updateProject(String(a.project_id), {
            ...(a.description !== undefined && { description: String(a.description) }),
          });
          return jsonResult(updated);
        }

        case "add_source": {
          const projectId = String(a.project_id);
          const sourceId = String(a.source_id);
          const sourceConfig = buildSourceConfig(a);
          const embedding = buildEmbeddingOverride(a);

          await validateGitlabToken(sourceConfig);

          const source: Omit<Source, "table_name" | "last_indexed"> = {
            source_id: sourceId,
            source_config: sourceConfig,
            ...(embedding && { embedding }),
          };
          addSource(projectId, source);
          return jsonResult({ ok: true, project_id: projectId, source_id: sourceId });
        }

        case "update_source": {
          const projectId = String(a.project_id);
          const sourceId = String(a.source_id);
          const existing = getSource(projectId, sourceId);
          if (!existing) {
            return jsonResult({ error: `Source '${sourceId}' not found in project '${projectId}'` });
          }

          const fields: Partial<Source> = {};

          const scPatch: Record<string, unknown> = {};
          if (existing.source_config.type === "ticket") {
            if (a.gitlab_token) scPatch["token"] = String(a.gitlab_token);
            if (a.gitlab_url) scPatch["base_url"] = String(a.gitlab_url);
            if (a.gitlab_project_id) scPatch["project_id"] = String(a.gitlab_project_id);
          } else if (existing.source_config.type === "code") {
            if (a.root_path) scPatch["root_path"] = String(a.root_path);
            if (Array.isArray(a.languages)) scPatch["languages"] = a.languages as string[];
          }
          if (Object.keys(scPatch).length > 0) {
            fields.source_config = { ...existing.source_config, ...scPatch } as Source["source_config"];
          }

          const embedding = buildEmbeddingOverride(a);
          if (embedding) fields.embedding = embedding;

          if (Object.keys(fields).length === 0) {
            return jsonResult({ ok: true, project_id: projectId, source_id: sourceId, updated: false, message: "Nothing to update" });
          }

          const updated = updateSource(projectId, sourceId, fields);
          return jsonResult({ ok: true, project_id: projectId, source_id: sourceId, updated: true, source: updated });
        }

        case "remove_source": {
          await removeSource(String(a.project_id), String(a.source_id));
          return jsonResult({
            ok: true,
            project_id: String(a.project_id),
            source_id: String(a.source_id),
          });
        }

        case "search_code": {
          const projectId = String(a.project_id);
          const query = String(a.query);
          const topK = typeof a.top_k === "number" ? a.top_k : 10;
          if (!getProject(projectId)) {
            return jsonResult({ error: `Project '${projectId}' not found` });
          }
          const results = await searchCode(query, projectId, topK);
          return jsonResult(results);
        }

        case "search_knowledge": {
          const projectId = String(a.project_id);
          const query = String(a.query);
          const topK = typeof a.top_k === "number" ? a.top_k : 10;
          const sourceId = a.source_id ? String(a.source_id) : undefined;
          const sourceTypes = Array.isArray(a.source_types)
            ? (a.source_types as string[])
            : undefined;
          if (!getProject(projectId)) {
            return jsonResult({ error: `Project '${projectId}' not found` });
          }
          const results = await searchKnowledge(query, projectId, topK, sourceId, sourceTypes);
          return jsonResult(results);
        }

        case "reindex_all": {
          const jobId = submitAllJob();
          const projectCount = listProjects().length;
          return jsonResult({ job_id: jobId, status: "started", project_count: projectCount, mode: "incremental" });
        }

        case "reindex_project": {
          const projectId = String(a.project_id);
          const mode: IndexMode = a.mode === "full" ? "full" : "incremental";
          const sourceIds: string[] | undefined = Array.isArray(a.source_ids) ? a.source_ids : undefined;
          if (mode === "full" && !sourceIds?.length) {
            return jsonResult({ error: "source_ids is required for mode: full", error_type: "invalid_request" });
          }
          if (!getProject(projectId)) {
            return jsonResult({ error: `Project '${projectId}' not found` });
          }
          const jobResult = submitJob(projectId, mode, sourceIds);
          if (typeof jobResult === "object" && "error" in jobResult) {
            return jsonResult({ error: "A reindex job is already running for this project", error_type: "already_running", job_id: jobResult.job_id });
          }
          return jsonResult({ job_id: jobResult, status: "started", project_id: projectId, mode });
        }

        case "reindex_source": {
          const projectId = String(a.project_id);
          const sourceId = String(a.source_id);
          const mode: IndexMode = a.mode === "full" ? "full" : "incremental";
          if (!getProject(projectId)) {
            return jsonResult({ error: `Project '${projectId}' not found` });
          }
          const sourceJobResult = submitSourceJob(projectId, sourceId, mode);
          if (typeof sourceJobResult === "object" && "error" in sourceJobResult) {
            return jsonResult({ error: "A reindex job is already running for this project", error_type: "already_running", job_id: sourceJobResult.job_id });
          }
          return jsonResult({
            job_id: sourceJobResult,
            status: "started",
            project_id: projectId,
            source_id: sourceId,
            mode,
          });
        }

        case "reindex_status": {
          const jobId = String(a.job_id);
          const status = getJobStatus(jobId);
          if (!status) {
            return jsonResult({
              error: `Job '${jobId}' not found (jobs are lost on server restart)`,
            });
          }
          if (status.status === "done" && status.project_id === "*") {
            const projects = listProjects().map((p) => ({
              project_id: p.id,
              sources: p.sources.map((s) => ({ source_id: s.source_id, last_indexed: s.last_indexed })),
            }));
            return jsonResult({ ...status, projects });
          }
          return jsonResult(status);
        }

        case "cancel_reindex": {
          const jobId = String(a.job_id);
          const sourceId = a.source_id ? String(a.source_id) : undefined;
          const cancelled = cancelJob(jobId, sourceId);
          return jsonResult({ job_id: jobId, cancelled });
        }

        case "list_jobs": {
          const statusFilter = a.status ? String(a.status) : undefined;
          const jobs = listJobs(statusFilter);
          return jsonResult({ jobs, count: jobs.length });
        }

        default:
          return jsonResult({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      return jsonResult(classifyError(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
