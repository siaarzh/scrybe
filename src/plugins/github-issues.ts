/**
 * GitHub Issues plugin — Plan 32, Slice 3.
 * Indexes GitHub issues + issue comments via api.github.com (or a GHES base URL).
 * Mirrors the shape of gitlab-issues.ts closely: chunk emission, source_type
 * "ticket"/"ticket_comment", Plan-42 metadata, cursor-based incremental fetch.
 */

import { chunkLines, stampChunkId } from "../chunker.js";
import { normalizeContent } from "../normalize.js";
import { resolveEnvRef } from "../config.js";
import type { KnowledgeChunk, RawKnowledgeChunk, Project, Source, SourceConfig } from "../types.js";
import type { AnyChunk, SourcePlugin } from "./base.js";

// ─── API response shapes ──────────────────────────────────────────────────────

interface GitHubLabel {
  name: string;
}

interface GitHubMilestone {
  title: string;
}

interface GitHubUser {
  login: string;
}

/** A GitHub issue (or PR — identified by presence of `pull_request` key). */
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  user: GitHubUser | null;
  state: "open" | "closed";
  updated_at: string;
  html_url: string;
  labels: GitHubLabel[];
  milestone: GitHubMilestone | null;
  assignees: GitHubUser[];
  /** Present only on pull-request entries returned by the /issues endpoint. */
  pull_request?: unknown;
}

interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser | null;
  created_at: string;
}

// ─── Metadata serialisation (Plan 42, D5) ────────────────────────────────────

/** Serialised metadata threaded onto every chunk for a given issue. */
interface IssueMetadata {
  state: string;       // canonical: "open" | "closed" (GitHub is already canonical)
  labels: string;      // JSON array of name strings
  assignees: string;   // JSON array of login strings
  milestone: string;   // JSON object string or '' if no milestone
  confidential: string; // always "false" — GitHub has no equivalent
}

function serializeIssueMetadata(issue: GitHubIssue): IssueMetadata {
  const labels = JSON.stringify((issue.labels ?? []).map((l) => l.name));
  const assignees = JSON.stringify((issue.assignees ?? []).map((a) => a.login));
  const milestone = issue.milestone
    ? JSON.stringify({ title: issue.milestone.title, due_date: null })
    : "";
  return {
    state: issue.state,   // already "open" | "closed" — no normalization needed (D5)
    labels,
    assignees,
    milestone,
    confidential: "false", // GitHub has no confidential concept (D5)
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type TicketConfig = Extract<SourceConfig, { type: "ticket" }>;

function ticketConfig(source: Source): TicketConfig {
  if (source.source_config.type !== "ticket") {
    throw new Error(`Source "${source.source_id}" is not a ticket source`);
  }
  return source.source_config as TicketConfig;
}

/**
 * Returns true if the GitHub API issue object is a pull request.
 * GitHub's /issues endpoint mixes PRs in — they carry a `pull_request` key.
 * D3: named + exported so it can be unit-tested and re-used.
 */
export function isPullRequest(issue: GitHubIssue): boolean {
  return "pull_request" in issue && issue.pull_request !== undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

async function githubFetch<T>(url: string, token: string, projectId: string): Promise<T> {
  let lastError: Error | null = null;
  let retryCount = 0;
  const maxRetries = 3;

  while (retryCount <= maxRetries) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    // D7: honor primary rate-limit signals (403/429 + Retry-After / x-ratelimit-reset)
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const resetHeader = res.headers.get("x-ratelimit-reset");
      let waitMs = 60_000; // default 60s
      if (retryAfterHeader) {
        waitMs = parseInt(retryAfterHeader, 10) * 1_000;
      } else if (resetHeader) {
        const resetEpoch = parseInt(resetHeader, 10) * 1_000;
        const nowMs = Date.now();
        waitMs = Math.max(0, resetEpoch - nowMs) + 1_000; // 1s safety margin
      }
      if (retryCount < maxRetries) {
        await delay(waitMs);
        retryCount++;
        continue;
      }
      throw new Error(
        `GitHub API rate limit exceeded for project "${projectId}". ` +
        `Retry after ${Math.ceil(waitMs / 1000)}s.`
      );
    }

    if (res.status === 401) {
      throw new Error(
        `GitHub token for project "${projectId}" is invalid or expired (HTTP 401). ` +
        `Ensure the token has Issues: Read-only and Metadata: Read-only scopes ` +
        `(fine-grained PAT) or repo/public_repo (classic PAT).`
      );
    }
    if (res.status === 403) {
      throw new Error(
        `GitHub token for project "${projectId}" lacks required permissions (HTTP 403). ` +
        `Ensure the token has Issues: Read-only and Metadata: Read-only scopes ` +
        `(fine-grained PAT) or repo/public_repo (classic PAT).`
      );
    }

    if (!res.ok) {
      lastError = new Error(`GitHub API error ${res.status} ${res.statusText} for ${url}`);
      if (retryCount < maxRetries) {
        await delay(1_000 * (retryCount + 1));
        retryCount++;
        continue;
      }
      throw lastError;
    }

    return res.json() as Promise<T>;
  }

  // Should not reach here
  throw lastError ?? new Error(`GitHub API request failed for ${url}`);
}

async function fetchAllPages<T>(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}per_page=100&page=${page}`;
    const batch = await githubFetch<T[]>(url, token, projectId);
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return results;
}

// ─── Token validation ─────────────────────────────────────────────────────────

/**
 * Validates a GitHub PAT by hitting GET /user on the configured base URL.
 * Resolves ${VAR} token references via resolveEnvRef at call time (ADR-0002).
 */
export async function validateGithubToken(cfg: SourceConfig): Promise<void> {
  if (cfg.type !== "ticket") return;
  const c = cfg as TicketConfig;
  let token: string;
  try {
    token = resolveEnvRef(c.token);
  } catch {
    const varMatch = c.token.match(/\$\{([A-Z_][A-Z0-9_]*)\}/);
    const varName = varMatch ? varMatch[1] : c.token;
    throw new Error(
      `Token for GitHub source "${c.project_id}" references env var ${varName} which is not set. ` +
      `Set it in your environment or in <DATA_DIR>/.env: ${varName}=<your-token>`
    );
  }
  const baseUrl = c.base_url || "https://api.github.com";
  // Cheap authenticated probe: GET /user
  const res = await fetch(`${baseUrl}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `GitHub token for project "${c.project_id}" is invalid or lacks required permissions (HTTP ${res.status}). ` +
      `Ensure the token has Issues: Read-only and Metadata: Read-only scopes (fine-grained PAT) ` +
      `or repo/public_repo (classic PAT).`
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} ${res.statusText} during token validation`);
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class GitHubIssuesPlugin implements SourcePlugin {
  readonly type = "ticket";
  readonly embeddingProfile = "text" as const;

  /**
   * Scan: returns { "issues/N": updated_at } for all non-PR issues updated
   * since the cursor (60s skew margin mirrors gitlab-issues.ts).
   */
  async scanSources(
    project: Project,
    source: Source,
    cursor?: string | null,
  ): Promise<Record<string, string>> {
    const cfg = ticketConfig(source);
    const token = resolveEnvRef(cfg.token);
    const baseUrl = cfg.base_url || "https://api.github.com";
    const [owner, repo] = cfg.project_id.split("/");

    // 60s safety margin to handle clock skew (mirrors gitlab plugin)
    const since = cursor
      ? new Date(Date.parse(cursor) - 60_000).toISOString()
      : null;

    const url = since
      ? `${baseUrl}/repos/${owner}/${repo}/issues?state=all&since=${encodeURIComponent(since)}`
      : `${baseUrl}/repos/${owner}/${repo}/issues?state=all`;

    const issues = await fetchAllPages<GitHubIssue>(url, token, project.id);
    const map: Record<string, string> = {};
    for (const issue of issues) {
      if (isPullRequest(issue)) continue; // D3: filter PRs
      map[`issues/${issue.number}`] = issue.updated_at;
    }
    return map;
  }

  /**
   * Fetch: for each changed issue key, fetches the issue + its comments and
   * yields knowledge chunks with Plan-42 metadata populated.
   */
  async *fetchChunks(
    project: Project,
    source: Source,
    changed: Set<string>,
  ): AsyncGenerator<AnyChunk> {
    const cfg = ticketConfig(source);
    const token = resolveEnvRef(cfg.token);
    const baseUrl = cfg.base_url || "https://api.github.com";
    const [owner, repo] = cfg.project_id.split("/");

    for (const key of changed) {
      const number = key.replace("issues/", "");
      const issueUrl = `${baseUrl}/repos/${owner}/${repo}/issues/${number}`;
      const commentsUrl = `${baseUrl}/repos/${owner}/${repo}/issues/${number}/comments`;

      try {
        const [issue, comments] = await Promise.all([
          githubFetch<GitHubIssue>(issueUrl, token, project.id),
          fetchAllPages<GitHubComment>(commentsUrl, token, project.id),
        ]);

        // Extra safety: skip if this turns out to be a PR (shouldn't happen from
        // scanSources but guards direct calls)
        if (isPullRequest(issue)) continue;

        const meta = serializeIssueMetadata(issue);

        const emit = function* (
          itemPath: string,
          content: string,
          author: string,
          timestamp: string,
          itemType: string,
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
        const issueBody = normalizeContent(
          `# ${issue.title}\n\n${issue.body?.trim() || ""}`.trim()
        );
        yield* emit(
          `issues/${issue.number}`,
          issueBody,
          issue.user?.login ?? "unknown",
          issue.updated_at,
          "ticket",
          issue.html_url,
        );

        // One chunk family per non-empty comment — item_path: "issues/N#comment_M"
        for (const comment of comments) {
          const body = normalizeContent(comment.body?.trim() ?? "");
          if (!body) continue;
          yield* emit(
            `issues/${issue.number}#comment_${comment.id}`,
            body,
            comment.user?.login ?? "unknown",
            comment.created_at || issue.updated_at,
            "ticket_comment",
            `${issue.html_url}#issuecomment-${comment.id}`,
          );
        }

        // Rate-limit safety: ~50ms between issues (mirrors gitlab plugin)
        await delay(50);
      } catch (err) {
        if (err instanceof Error && err.message.includes("404")) {
          console.warn(`[scrybe] GitHub issue '${key}' not found (404) — skipping`);
          continue;
        }
        throw err;
      }
    }
  }
}
