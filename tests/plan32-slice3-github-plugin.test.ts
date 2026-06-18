/**
 * Plan 32 — Slice 3: GitHub issues plugin
 *
 * Covers:
 * - isPullRequest() unit test (helper, D3)
 * - Integration-style: mocked fetch → scanSources filters PRs
 * - Integration-style: fetchChunks emits issue + comment chunks with Plan-42 metadata
 * - Incremental cursor: second scan passes `since` param
 * - Metadata mapping: state (native open/closed), labels names, milestone title,
 *   assignee logins, confidential always false (D5)
 * - 403 with Retry-After header: backoff then success (D7)
 * - Unset-var token error on validateGithubToken
 * - PR in mocked feed is skipped end-to-end
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeSource(overrides: {
  token?: string;
  base_url?: string;
  project_id?: string;
} = {}) {
  return {
    source_id: "gh-issues",
    source_config: {
      type: "ticket" as const,
      provider: "github",
      base_url: overrides.base_url ?? "https://api.github.com",
      project_id: overrides.project_id ?? "owner/repo",
      token: overrides.token ?? "ghp_testtoken",
    },
    table_name: "test_table",
    last_indexed: null,
  };
}

function makeProject() {
  return {
    id: "proj-gh",
    description: "GitHub test project",
    sources: [makeSource()],
  };
}

function makeIssue(overrides: Partial<{
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  pull_request: unknown;
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
  assignees: Array<{ login: string }>;
  updated_at: string;
  html_url: string;
  user: { login: string };
}> = {}) {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? "Test issue",
    body: overrides.body ?? "Issue body",
    state: overrides.state ?? "open" as const,
    user: overrides.user ?? { login: "alice" },
    updated_at: overrides.updated_at ?? "2024-06-01T10:00:00Z",
    html_url: overrides.html_url ?? "https://github.com/owner/repo/issues/1",
    labels: overrides.labels ?? [{ name: "bug" }, { name: "good-first-issue" }],
    milestone: overrides.milestone !== undefined ? overrides.milestone : { title: "v1.0" },
    assignees: overrides.assignees ?? [{ login: "bob" }],
    ...(overrides.pull_request !== undefined && { pull_request: overrides.pull_request }),
  };
}

function makeComment(overrides: Partial<{
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}> = {}) {
  return {
    id: overrides.id ?? 100,
    body: overrides.body ?? "A comment",
    user: overrides.user ?? { login: "carol" },
    created_at: overrides.created_at ?? "2024-06-01T11:00:00Z",
  };
}

// ─── isPullRequest unit tests ─────────────────────────────────────────────────

describe("isPullRequest()", () => {
  it("returns false for a plain issue (no pull_request key)", async () => {
    const { isPullRequest } = await import("../src/plugins/github-issues.js");
    const issue = makeIssue(); // no pull_request key
    expect(isPullRequest(issue as Parameters<typeof isPullRequest>[0])).toBe(false);
  });

  it("returns true when pull_request key is present (object)", async () => {
    const { isPullRequest } = await import("../src/plugins/github-issues.js");
    const pr = makeIssue({ pull_request: { url: "https://..." } });
    expect(isPullRequest(pr as Parameters<typeof isPullRequest>[0])).toBe(true);
  });

  it("returns true when pull_request key is present (empty object)", async () => {
    const { isPullRequest } = await import("../src/plugins/github-issues.js");
    const pr = makeIssue({ pull_request: {} });
    expect(isPullRequest(pr as Parameters<typeof isPullRequest>[0])).toBe(true);
  });
});

// ─── validateGithubToken — unset var ─────────────────────────────────────────

describe("validateGithubToken — unset var throws actionable error", () => {
  afterEach(() => {
    delete process.env["SCRYBE_TEST_GH_MISSING_S3"];
  });

  it("throws with variable name and fix guidance", async () => {
    delete process.env["SCRYBE_TEST_GH_MISSING_S3"];
    const { validateGithubToken } = await import("../src/plugins/github-issues.js");
    let msg = "";
    try {
      await validateGithubToken({
        type: "ticket",
        provider: "github",
        base_url: "https://api.github.com",
        project_id: "owner/repo",
        token: "${SCRYBE_TEST_GH_MISSING_S3}",
      });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/SCRYBE_TEST_GH_MISSING_S3/);
    expect(msg).toMatch(/owner\/repo/);
    expect(msg).toMatch(/DATA_DIR|environment|\.env/i);
  });
});

// ─── scanSources — PR filtering ───────────────────────────────────────────────

describe("GitHubIssuesPlugin.scanSources — PR filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits PRs from the returned map", async () => {
    const issue = makeIssue({ number: 1 });
    const pr = makeIssue({ number: 2, pull_request: { url: "https://..." } });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => [issue, pr],
    }) as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      const result = await plugin.scanSources(makeProject(), makeSource(), null);

      expect(Object.keys(result)).toContain("issues/1");
      expect(Object.keys(result)).not.toContain("issues/2");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("passes `since` param when cursor is provided", async () => {
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => [],
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      await plugin.scanSources(makeProject(), makeSource(), "2024-06-01T00:00:00Z");

      const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain("since=");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does NOT include `since` param on initial full scan (null cursor)", async () => {
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => [],
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      await plugin.scanSources(makeProject(), makeSource(), null);

      const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).not.toContain("since=");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── fetchChunks — metadata mapping + comment inheritance ────────────────────

describe("GitHubIssuesPlugin.fetchChunks — metadata + comments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits ticket chunk with correct Plan-42 metadata", async () => {
    const issue = makeIssue({
      number: 42,
      state: "closed",
      labels: [{ name: "bug" }, { name: "wontfix" }],
      milestone: { title: "v2.0" },
      assignees: [{ login: "dave" }],
    });

    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ // GET /issues/42
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => issue,
      })
      .mockResolvedValueOnce({ // GET /issues/42/comments (page 1 — empty)
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => [],
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      const chunks: unknown[] = [];
      for await (const chunk of plugin.fetchChunks(makeProject(), makeSource(), new Set(["issues/42"]))) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const c = chunks[0] as Record<string, unknown>;
      expect(c["item_type"]).toBe("ticket");
      expect(c["state"]).toBe("closed");
      expect(c["labels"]).toBe(JSON.stringify(["bug", "wontfix"]));
      expect(c["assignees"]).toBe(JSON.stringify(["dave"]));
      expect(c["milestone"]).toMatch(/v2\.0/);
      expect(c["confidential"]).toBe("false");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("comment chunks inherit parent issue metadata but have their own author", async () => {
    const issue = makeIssue({
      number: 7,
      state: "open",
      labels: [{ name: "enhancement" }],
      assignees: [],
      milestone: null,
      user: { login: "alice" },
    });
    const comment = makeComment({ id: 999, body: "Great idea!", user: { login: "eve" } });

    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => issue,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => [comment],
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      const chunks: unknown[] = [];
      for await (const chunk of plugin.fetchChunks(makeProject(), makeSource(), new Set(["issues/7"]))) {
        chunks.push(chunk);
      }

      const commentChunks = (chunks as Array<Record<string, unknown>>).filter(
        (c) => c["item_type"] === "ticket_comment"
      );
      expect(commentChunks.length).toBeGreaterThan(0);
      const cc = commentChunks[0]!;

      // Comment inherits parent metadata
      expect(cc["state"]).toBe("open");
      expect(cc["labels"]).toBe(JSON.stringify(["enhancement"]));
      expect(cc["confidential"]).toBe("false");
      // Comment keeps its own author
      expect(cc["author"]).toBe("eve");
      // item_path has comment suffix
      expect(cc["item_path"]).toMatch(/issues\/7#comment_999/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("skips a PR that slips into fetchChunks (paranoia guard)", async () => {
    const pr = makeIssue({ number: 55, pull_request: { url: "https://..." } });

    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => pr,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => [],
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      const chunks: unknown[] = [];
      for await (const chunk of plugin.fetchChunks(makeProject(), makeSource(), new Set(["issues/55"]))) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("confidential is always false for GitHub issues", async () => {
    const issue = makeIssue({ number: 3 });
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => issue,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => [],
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      const chunks: unknown[] = [];
      for await (const chunk of plugin.fetchChunks(makeProject(), makeSource(), new Set(["issues/3"]))) {
        chunks.push(chunk);
      }
      for (const c of chunks as Array<Record<string, unknown>>) {
        expect(c["confidential"]).toBe("false");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── fetchChunks — pagination ─────────────────────────────────────────────────

describe("GitHubIssuesPlugin.fetchChunks — pagination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches subsequent pages of comments when first page is full (100 items)", async () => {
    const issue = makeIssue({ number: 5 });
    const comments100 = Array.from({ length: 100 }, (_, i) =>
      makeComment({ id: i + 1, body: `Comment ${i + 1}` })
    );
    const commentsPage2 = [makeComment({ id: 200, body: "Last comment" })];

    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ // GET /issues/5
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => issue,
      })
      .mockResolvedValueOnce({ // comments page 1 — full
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => comments100,
      })
      .mockResolvedValueOnce({ // comments page 2 — last
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => commentsPage2,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();
      const chunks: unknown[] = [];
      for await (const chunk of plugin.fetchChunks(makeProject(), makeSource(), new Set(["issues/5"]))) {
        chunks.push(chunk);
      }

      // Should have been called 3 times: issue + 2 comment pages
      expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
      const commentChunks = (chunks as Array<Record<string, unknown>>).filter(
        (c) => c["item_type"] === "ticket_comment"
      );
      // 101 comments total (100 + 1)
      expect(commentChunks.length).toBe(101);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── scanSources — incremental cursor (second pass) ──────────────────────────

describe("GitHubIssuesPlugin — incremental cursor behaviour", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("second scan only returns items updated after cursor (mocked `since` check)", async () => {
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: { get: () => null },
      json: async () => [],
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();

      const cursor = "2024-06-01T00:00:00Z";
      await plugin.scanSources(makeProject(), makeSource(), cursor);

      const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // Must include a `since` param derived from the cursor (with 60s skew applied)
      expect(calledUrl).toContain("since=");
      // The since value must be before the cursor (skew: 60s back)
      const sinceMatch = calledUrl.match(/since=([^&]+)/);
      if (sinceMatch) {
        const sinceMs = Date.parse(decodeURIComponent(sinceMatch[1]!));
        const cursorMs = Date.parse(cursor);
        // sinceMs should be ~60s before cursorMs
        expect(sinceMs).toBeLessThan(cursorMs);
        expect(cursorMs - sinceMs).toBeCloseTo(60_000, -3); // within ~1s of exactly 60s
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── Rate limiting: 403 with Retry-After ─────────────────────────────────────

describe("GitHubIssuesPlugin — 403 rate limit with Retry-After", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries after Retry-After delay on 403 with x-ratelimit-remaining: 0, then succeeds", async () => {
    vi.useFakeTimers();

    const issue = makeIssue({ number: 1 });
    let callCount = 0;

    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call to scan: 403 rate limited
        return {
          ok: false, status: 403, statusText: "Forbidden",
          headers: { get: (h: string) => {
            if (h === "Retry-After") return "1"; // 1 second
            if (h === "x-ratelimit-remaining") return "0";
            return null;
          }},
          json: async () => ({}),
        };
      }
      // Second call: success (scan page)
      return {
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        json: async () => [issue],
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { GitHubIssuesPlugin } = await import("../src/plugins/github-issues.js");
      const plugin = new GitHubIssuesPlugin();

      // Start the scan (it will hit 403, then wait, then retry)
      const resultPromise = plugin.scanSources(makeProject(), makeSource(), null);

      // Advance fake timers past the Retry-After delay (1s = 1000ms)
      await vi.advanceTimersByTimeAsync(1500);

      const result = await resultPromise;
      expect(Object.keys(result)).toContain("issues/1");
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── Provider dispatch via index.ts ──────────────────────────────────────────

describe("plugin index — provider dispatch", () => {
  it("getPlugin('ticket').scanSources dispatches to GitHub plugin for provider=github", async () => {
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: { get: () => null },
      json: async () => [],
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const { getPlugin } = await import("../src/plugins/index.js");
      const plugin = getPlugin("ticket");
      const source = makeSource({ base_url: "https://api.github.com", project_id: "owner/myrepo" });
      await plugin.scanSources(makeProject(), source, null);

      const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // GitHub plugin uses /repos/owner/myrepo/issues
      expect(calledUrl).toContain("/repos/owner/myrepo/issues");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("getPlugin('ticket').scanSources dispatches to GitLab plugin for provider=gitlab", async () => {
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: { get: () => null },
      json: async () => [],
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    try {
      const { getPlugin } = await import("../src/plugins/index.js");
      const plugin = getPlugin("ticket");
      const source = {
        source_id: "gl-issues",
        source_config: {
          type: "ticket" as const,
          provider: "gitlab",
          base_url: "https://gitlab.example.com",
          project_id: "42",
          token: "tok",
        },
        table_name: "test_gl",
        last_indexed: null,
      };
      const project = { id: "proj-gl", description: "", sources: [source] };
      await plugin.scanSources(project, source, null);

      const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // GitLab plugin uses /api/v4/projects/
      expect(calledUrl).toContain("/api/v4/projects/");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
