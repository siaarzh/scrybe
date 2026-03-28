import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listProjects, getProject, addProject, updateProject } from "./registry.js";
import { search } from "./vector-store.js";
import { embedQuery } from "./embedder.js";
import { submitJob, getJobStatus, cancelJob } from "./jobs.js";
import type { IndexMode } from "./types.js";

const TOOLS = [
  {
    name: "list_projects",
    description: "List all registered projects",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "add_project",
    description: "Register a new project for indexing",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "Unique project identifier" },
        root_path: { type: "string", description: "Absolute path to repo root" },
        languages: { type: "array", items: { type: "string" }, description: "Language hints (informational)" },
        description: { type: "string", description: "Human-readable description" },
      },
      required: ["project_id", "root_path"],
    },
  },
  {
    name: "update_project",
    description: "Update an existing project's metadata",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        root_path: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "search_code",
    description: "Semantically search code in a project using natural language",
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
    name: "reindex_project",
    description: "Trigger background reindexing of a project. Returns a job_id to poll with reindex_status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string" },
        mode: { type: "string", enum: ["full", "incremental"], default: "incremental" },
      },
      required: ["project_id"],
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
      },
      required: ["job_id"],
    },
  },
];

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "scrybe", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "list_projects":
          return jsonResult(listProjects());

        case "add_project": {
          const project = {
            id: String(a.project_id),
            root_path: String(a.root_path),
            languages: Array.isArray(a.languages) ? (a.languages as string[]) : typeof a.languages === "string" ? (() => { try { return JSON.parse(a.languages as string); } catch { return [a.languages as string]; } })() : [],
            description: a.description ? String(a.description) : "",
          };
          addProject(project);
          return jsonResult({ ok: true, project });
        }

        case "update_project": {
          let languages: string[] | undefined;
          if (a.languages !== undefined) {
            if (typeof a.languages === "string") {
              try { languages = JSON.parse(a.languages); } catch { languages = [a.languages]; }
            } else {
              languages = a.languages as string[];
            }
          }
          const updated = updateProject(String(a.project_id), {
            ...(a.root_path !== undefined && { root_path: String(a.root_path) }),
            ...(languages !== undefined && { languages }),
            ...(a.description !== undefined && { description: String(a.description) }),
          });
          return jsonResult(updated);
        }

        case "search_code": {
          const projectId = String(a.project_id);
          const query = String(a.query);
          const topK = typeof a.top_k === "number" ? a.top_k : 10;
          if (!getProject(projectId)) {
            return jsonResult({ error: `Project '${projectId}' not found` });
          }
          const queryVec = await embedQuery(query);
          const results = await search(queryVec, projectId, topK);
          return jsonResult(results);
        }

        case "reindex_project": {
          const projectId = String(a.project_id);
          const mode: IndexMode =
            a.mode === "full" ? "full" : "incremental";
          if (!getProject(projectId)) {
            return jsonResult({ error: `Project '${projectId}' not found` });
          }
          const jobId = submitJob(projectId, mode);
          return jsonResult({ job_id: jobId, status: "started", project_id: projectId, mode });
        }

        case "reindex_status": {
          const jobId = String(a.job_id);
          const status = getJobStatus(jobId);
          if (!status) {
            return jsonResult({ error: `Job '${jobId}' not found (jobs are lost on server restart)` });
          }
          return jsonResult(status);
        }

        case "cancel_reindex": {
          const jobId = String(a.job_id);
          const cancelled = cancelJob(jobId);
          return jsonResult({ job_id: jobId, cancelled });
        }

        default:
          return jsonResult({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
