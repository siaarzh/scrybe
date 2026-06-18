import { chunkLines, stampChunkId } from "../chunker.js";
import { normalizeContent } from "../normalize.js";
import { resolveEnvRef } from "../config.js";
import type { KnowledgeChunk, RawKnowledgeChunk, Project, Source, SourceConfig } from "../types.js";
import type { AnyChunk, SourcePlugin } from "./base.js";

interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  author: { username: string };
  updated_at: string;
  web_url: string;
  // Plan 42 metadata fields — present on both list and single-issue endpoints
  state: "opened" | "closed";
  labels: string[];
  milestone: { title: string; due_date: string | null } | null;
  assignees: Array<{ username: string }>;
  confidential: boolean;
}

/** Serialized (D3) metadata to thread onto every chunk for a given issue. */
interface IssueMetadata {
  state: string;         // normalized: "open" | "closed"
  labels: string;        // JSON array string, e.g. '["Bug","Search"]'
  assignees: string;     // JSON array string of usernames, e.g. '["alice"]'
  milestone: string;     // JSON object string or '' if no milestone
  confidential: string;  // "true" | "false"
}

interface GitLabNote {
  id: number;
  body: string;
  author: { username: string };
  system: boolean;
  created_at: string;
}

type TicketConfig = Extract<SourceConfig, { type: "ticket" }>;

function ticketConfig(source: Source): TicketConfig {
  if (source.source_config.type !== "ticket") {
    throw new Error(`Source "${source.source_id}" is not a ticket source`);
  }
  return source.source_config as TicketConfig;
}

async function gitlabFetch<T>(url: string, token: string, projectId: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `GitLab token for project "${projectId}" is expired or invalid (HTTP ${res.status}). ` +
      `Update it with: scrybe update-source --project-id ${projectId} --source-id <source-id> --gitlab-token <new-token>`
    );
  }
  if (!res.ok) {
    throw new Error(`GitLab API error ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json() as Promise<T>;
}

async function fetchAllPages<T>(baseUrl: string, token: string, projectId: string): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}per_page=100&page=${page}`;
    const batch = await gitlabFetch<T[]>(url, token, projectId);
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return results;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize GitLab state and serialize issue metadata to D3 (JSON strings).
 * D4: GitLab "opened" → canonical "open"; "closed" stays "closed".
 */
function serializeIssueMetadata(issue: GitLabIssue): IssueMetadata {
  const state = issue.state === "opened" ? "open" : "closed";
  const labels = JSON.stringify(issue.labels ?? []);
  const assignees = JSON.stringify((issue.assignees ?? []).map((a) => a.username));
  const milestone = issue.milestone
    ? JSON.stringify({ title: issue.milestone.title, due_date: issue.milestone.due_date ?? null })
    : "";
  const confidential = issue.confidential ? "true" : "false";
  return { state, labels, assignees, milestone, confidential };
}

export async function validateGitlabToken(cfg: SourceConfig): Promise<void> {
  if (cfg.type !== "ticket") return;
  const c = cfg as TicketConfig;
  let token: string;
  try {
    token = resolveEnvRef(c.token);
  } catch {
    // Extract variable name from the ${VAR} pattern for a more actionable error.
    const varMatch = c.token.match(/\$\{([A-Z_][A-Z0-9_]*)\}/);
    const varName = varMatch ? varMatch[1] : c.token;
    throw new Error(
      `Token for GitLab source "${c.project_id}" references env var ${varName} which is not set. ` +
      `Set it in your environment or in <DATA_DIR>/.env: ${varName}=<your-token>`
    );
  }
  const encodedId = encodeURIComponent(c.project_id);
  await gitlabFetch(`${c.base_url}/api/v4/projects/${encodedId}`, token, c.project_id);
}

export class GitLabIssuesPlugin implements SourcePlugin {
  readonly type = "ticket";
  readonly embeddingProfile = "text" as const;

  async scanSources(project: Project, source: Source, cursor?: string | null): Promise<Record<string, string>> {
    const cfg = ticketConfig(source);
    const token = resolveEnvRef(cfg.token);
    const encodedId = encodeURIComponent(cfg.project_id);
    // 60s safety margin to handle clock skew between client and GitLab server
    const since = cursor
      ? new Date(Date.parse(cursor) - 60_000).toISOString()
      : null;
    const url = since
      ? `${cfg.base_url}/api/v4/projects/${encodedId}/issues?state=all&updated_after=${encodeURIComponent(since)}`
      : `${cfg.base_url}/api/v4/projects/${encodedId}/issues?state=all`;

    const issues = await fetchAllPages<GitLabIssue>(url, token, project.id);
    const map: Record<string, string> = {};
    for (const issue of issues) {
      map[`issues/${issue.iid}`] = issue.updated_at;
    }
    return map;
  }

  async *fetchChunks(project: Project, source: Source, changed: Set<string>): AsyncGenerator<AnyChunk> {
    const cfg = ticketConfig(source);
    const token = resolveEnvRef(cfg.token);
    const encodedId = encodeURIComponent(cfg.project_id);

    for (const key of changed) {
      const iid = key.replace("issues/", "");
      const issueUrl = `${cfg.base_url}/api/v4/projects/${encodedId}/issues/${iid}`;
      const notesUrl = `${cfg.base_url}/api/v4/projects/${encodedId}/issues/${iid}/notes`;

      try {
        const [issue, notes] = await Promise.all([
          gitlabFetch<GitLabIssue>(issueUrl, token, project.id),
          fetchAllPages<GitLabNote>(notesUrl, token, project.id),
        ]);

        const meta = serializeIssueMetadata(issue);

        const emit = function* (
          itemPath: string,
          content: string,
          author: string,
          timestamp: string,
          itemType: string,
          // Code item_url must be ref-less; see ADR-0004.
          itemUrl: string,
        ): Generator<KnowledgeChunk> {
          const lines = content.split("\n").map((l) => l + "\n");
          const chunks = chunkLines(lines);
          for (const chunk of chunks) {
            yield stampChunkId({
              project_id: project.id,
              source_id: source.source_id,
              item_path: itemPath,
              item_url: itemUrl,
              item_type: itemType,
              author,
              timestamp,
              content: chunk.content,
              // Plan 42: issue-level metadata threaded onto every chunk (D5).
              // Comment chunks inherit the parent issue's metadata but keep their own author.
              state: meta.state,
              labels: meta.labels,
              assignees: meta.assignees,
              milestone: meta.milestone,
              confidential: meta.confidential,
            } satisfies RawKnowledgeChunk) as KnowledgeChunk;
          }
        };

        // Issue body chunk(s) — item_path: "issues/N"
        const issueBody = normalizeContent(`# ${issue.title}\n\n${issue.description?.trim() || ""}`.trim());
        yield* emit(
          `issues/${issue.iid}`,
          issueBody,
          issue.author.username,
          issue.updated_at,
          "ticket",
          issue.web_url,
        );

        // One chunk family per non-system, non-empty comment — item_path: "issues/N#note_M"
        for (const note of notes) {
          if (note.system) continue;
          const body = normalizeContent(note.body.trim());
          if (!body) continue;
          yield* emit(
            `issues/${issue.iid}#note_${note.id}`,
            body,
            note.author.username,
            note.created_at || issue.updated_at,
            "ticket_comment",
            `${issue.web_url}#note_${note.id}`,
          );
        }

        // Rate-limit safety: ~50ms between issues (GitLab: 10 req/s)
        await delay(50);
      } catch (err) {
        if (err instanceof Error && err.message.includes("404")) {
          console.warn(`[scrybe] Issue '${key}' not found (404) — skipping`);
          continue;
        }
        throw err;
      }
    }
  }
}
