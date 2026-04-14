import { createHash } from "crypto";
import { chunkLines } from "../chunker.js";
import type { KnowledgeChunk, Project, Source, SourceConfig } from "../types.js";
import type { AnyChunk, SourcePlugin } from "./base.js";

interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  author: { username: string };
  updated_at: string;
  web_url: string;
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

export async function validateGitlabToken(cfg: SourceConfig): Promise<void> {
  if (cfg.type !== "ticket") return;
  const c = cfg as TicketConfig;
  const encodedId = encodeURIComponent(c.project_id);
  await gitlabFetch(`${c.base_url}/api/v4/projects/${encodedId}`, c.token, c.project_id);
}

export class GitLabIssuesPlugin implements SourcePlugin {
  readonly type = "ticket";
  readonly embeddingProfile = "text" as const;

  async scanSources(project: Project, source: Source, cursor?: string | null): Promise<Record<string, string>> {
    const cfg = ticketConfig(source);
    const encodedId = encodeURIComponent(cfg.project_id);
    // 60s safety margin to handle clock skew between client and GitLab server
    const since = cursor
      ? new Date(Date.parse(cursor) - 60_000).toISOString()
      : null;
    const url = since
      ? `${cfg.base_url}/api/v4/projects/${encodedId}/issues?state=all&updated_after=${encodeURIComponent(since)}`
      : `${cfg.base_url}/api/v4/projects/${encodedId}/issues?state=all`;

    const issues = await fetchAllPages<GitLabIssue>(url, cfg.token, project.id);
    const map: Record<string, string> = {};
    for (const issue of issues) {
      map[`tickets/${issue.iid}`] = issue.updated_at;
    }
    return map;
  }

  async *fetchChunks(project: Project, source: Source, changed: Set<string>): AsyncGenerator<AnyChunk> {
    const cfg = ticketConfig(source);
    const encodedId = encodeURIComponent(cfg.project_id);

    for (const key of changed) {
      const iid = key.replace("tickets/", "");
      const issueUrl = `${cfg.base_url}/api/v4/projects/${encodedId}/issues/${iid}`;
      const notesUrl = `${cfg.base_url}/api/v4/projects/${encodedId}/issues/${iid}/notes`;

      try {
        const [issue, notes] = await Promise.all([
          gitlabFetch<GitLabIssue>(issueUrl, cfg.token, project.id),
          fetchAllPages<GitLabNote>(notesUrl, cfg.token, project.id),
        ]);

        const emit = function* (
          baseId: string,
          content: string,
          author: string,
          timestamp: string,
          sourceType: string,
          sourceUrl: string,
        ): Generator<KnowledgeChunk> {
          const lines = content.split("\n").map((l) => l + "\n");
          const chunks = chunkLines(lines);
          for (let i = 0; i < chunks.length; i++) {
            const chunkSuffix = chunks.length > 1 ? `-${i}` : "";
            const chunkId = createHash("sha256")
              .update(`${project.id}:${source.source_id}:${key}:${baseId}${chunkSuffix}`)
              .digest("hex");
            yield {
              chunk_id: chunkId,
              project_id: project.id,
              source_id: source.source_id,
              source_path: key,
              source_url: sourceUrl,
              source_type: sourceType,
              author,
              timestamp,
              content: chunks[i].content,
            } satisfies KnowledgeChunk;
          }
        };

        // Issue body chunk(s)
        const issueBody = `# ${issue.title}\n\n${issue.description?.trim() || ""}`.trim();
        yield* emit(
          "issue",
          issueBody,
          issue.author.username,
          issue.updated_at,
          "ticket",
          issue.web_url,
        );

        // One chunk family per non-system, non-empty comment
        for (const note of notes) {
          if (note.system) continue;
          const body = note.body.trim();
          if (!body) continue;
          yield* emit(
            `note-${note.id}`,
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
