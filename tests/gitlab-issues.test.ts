/**
 * Plan 42 — GitLab issues plugin: metadata passthrough (Slice 2).
 *
 * Verifies that `fetchChunks` emits correctly-stamped chunks with:
 *   - normalized `state` ("opened" → "open"; "closed" stays "closed") [D4]
 *   - `labels` / `assignees` / `milestone` serialized as JSON strings [D3]
 *   - `confidential` serialized as "true" / "false" [D3]
 *   - comment chunks inherit parent issue metadata but keep their own `author` [D5]
 *
 * Strategy: mock `globalThis.fetch` to serve canned issue + notes responses.
 * No real network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Project, Source } from "../src/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(): Project {
  return {
    id: "test-project",
    description: "test",
    sources: [],
  };
}

function makeSource(): Source {
  return {
    source_id: "gl-issues",
    source_config: {
      type: "ticket",
      provider: "gitlab",
      base_url: "https://gitlab.example.com",
      project_id: "42",
      token: "test-token",
    },
  };
}

/** Build a minimal GitLab issue API response. */
function makeIssueResponse(overrides: Partial<{
  iid: number;
  title: string;
  description: string | null;
  author_username: string;
  state: "opened" | "closed";
  labels: string[];
  milestone: { title: string; due_date: string | null } | null;
  assignees: Array<{ username: string }>;
  confidential: boolean;
  updated_at: string;
  web_url: string;
}> = {}) {
  const iid = overrides.iid ?? 1;
  return {
    iid,
    title: overrides.title ?? "Test issue",
    description: overrides.description ?? "Issue body",
    author: { username: overrides.author_username ?? "author1" },
    state: overrides.state ?? "opened",
    labels: overrides.labels ?? [],
    milestone: overrides.milestone ?? null,
    assignees: overrides.assignees ?? [],
    confidential: overrides.confidential ?? false,
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
    web_url: overrides.web_url ?? `https://gitlab.example.com/project/issues/${iid}`,
  };
}

/** Build a minimal GitLab note API response. */
function makeNoteResponse(overrides: Partial<{
  id: number;
  body: string;
  author_username: string;
  system: boolean;
  created_at: string;
}> = {}) {
  return {
    id: overrides.id ?? 100,
    body: overrides.body ?? "A comment",
    author: { username: overrides.author_username ?? "commenter1" },
    system: overrides.system ?? false,
    created_at: overrides.created_at ?? "2026-01-02T00:00:00Z",
  };
}

/**
 * Install a fetch mock that serves the given issue and notes.
 * Returns the original fetch so we can restore it in afterEach.
 */
function mockFetch(issueResponse: object, notesResponse: object[]): typeof globalThis.fetch {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const urlStr = String(url);
    // notes endpoint has "/notes" in the URL
    if (urlStr.includes("/notes")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => notesResponse,
      } as Response);
    }
    // single-issue endpoint
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => issueResponse,
    } as Response);
  });
  return original;
}

/** Collect all chunks from `fetchChunks` into an array. */
async function collectChunks(changed: Set<string>) {
  const { GitLabIssuesPlugin } = await import("../src/plugins/gitlab-issues.js");
  const plugin = new GitLabIssuesPlugin();
  const project = makeProject();
  const source = makeSource();
  const chunks = [];
  for await (const chunk of plugin.fetchChunks(project, source, changed)) {
    chunks.push(chunk);
  }
  return chunks;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GitLabIssuesPlugin — metadata passthrough (Plan 42, Slice 2)", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── D4: state normalization ────────────────────────────────────────────────

  describe("state normalization (D4)", () => {
    it('maps GitLab "opened" → canonical "open" on issue chunk', async () => {
      const issue = makeIssueResponse({ state: "opened" });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk as { state?: string }).state).toBe("open");
      }
    });

    it('keeps GitLab "closed" → canonical "closed" on issue chunk', async () => {
      const issue = makeIssueResponse({ state: "closed" });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk as { state?: string }).state).toBe("closed");
      }
    });
  });

  // ── D3: JSON serialization ─────────────────────────────────────────────────

  describe("JSON serialization (D3)", () => {
    it("serializes labels as a JSON array string", async () => {
      const issue = makeIssueResponse({ labels: ["Bug", "Search"] });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk as { labels?: string }).labels).toBe('["Bug","Search"]');
      }
    });

    it("serializes empty labels as '[]'", async () => {
      const issue = makeIssueResponse({ labels: [] });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      for (const chunk of chunks) {
        expect((chunk as { labels?: string }).labels).toBe("[]");
      }
    });

    it("serializes assignees as a JSON array of usernames", async () => {
      const issue = makeIssueResponse({
        assignees: [{ username: "alice" }, { username: "bob" }],
      });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk as { assignees?: string }).assignees).toBe('["alice","bob"]');
      }
    });

    it("serializes milestone as a JSON object string with title + due_date", async () => {
      const issue = makeIssueResponse({
        milestone: { title: "26.4", due_date: "2026-07-01" },
      });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        const ms = (chunk as { milestone?: string }).milestone;
        expect(ms).toBeDefined();
        const parsed = JSON.parse(ms!);
        expect(parsed.title).toBe("26.4");
        expect(parsed.due_date).toBe("2026-07-01");
      }
    });

    it("serializes milestone as '' when no milestone", async () => {
      const issue = makeIssueResponse({ milestone: null });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      for (const chunk of chunks) {
        expect((chunk as { milestone?: string }).milestone).toBe("");
      }
    });

    it("serializes null due_date inside milestone JSON as null", async () => {
      const issue = makeIssueResponse({
        milestone: { title: "Sprint 5", due_date: null },
      });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      for (const chunk of chunks) {
        const ms = (chunk as { milestone?: string }).milestone;
        expect(ms).toBeDefined();
        const parsed = JSON.parse(ms!);
        expect(parsed.title).toBe("Sprint 5");
        expect(parsed.due_date).toBeNull();
      }
    });

    it("serializes confidential=true as string 'true'", async () => {
      const issue = makeIssueResponse({ confidential: true });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect((chunk as { confidential?: string }).confidential).toBe("true");
      }
    });

    it("serializes confidential=false as string 'false'", async () => {
      const issue = makeIssueResponse({ confidential: false });
      originalFetch = mockFetch(issue, []);

      const chunks = await collectChunks(new Set(["issues/1"]));
      for (const chunk of chunks) {
        expect((chunk as { confidential?: string }).confidential).toBe("false");
      }
    });
  });

  // ── D5: comment inheritance ────────────────────────────────────────────────

  describe("comment inheritance (D5)", () => {
    it("comment chunk inherits parent issue metadata (state, labels, milestone, assignees, confidential)", async () => {
      const issue = makeIssueResponse({
        iid: 5,
        state: "opened",
        labels: ["Frontend", "Prio:High"],
        assignees: [{ username: "dev1" }],
        milestone: { title: "v2.0", due_date: "2026-08-01" },
        confidential: true,
      });
      const note = makeNoteResponse({ id: 200, author_username: "reviewer1" });
      originalFetch = mockFetch(issue, [note]);

      const chunks = await collectChunks(new Set(["issues/5"]));

      // Should have at least one issue chunk and one comment chunk
      const issueChunks = chunks.filter((c) => (c as { item_type?: string }).item_type === "ticket");
      const commentChunks = chunks.filter((c) => (c as { item_type?: string }).item_type === "ticket_comment");

      expect(issueChunks.length).toBeGreaterThan(0);
      expect(commentChunks.length).toBeGreaterThan(0);

      // Both carry the same issue-level metadata
      for (const chunk of [...issueChunks, ...commentChunks]) {
        const c = chunk as { state?: string; labels?: string; assignees?: string; milestone?: string; confidential?: string };
        expect(c.state).toBe("open");
        expect(c.labels).toBe('["Frontend","Prio:High"]');
        expect(c.assignees).toBe('["dev1"]');
        const ms = JSON.parse(c.milestone ?? "null");
        expect(ms.title).toBe("v2.0");
        expect(c.confidential).toBe("true");
      }
    });

    it("comment chunk keeps its own author (not the issue author)", async () => {
      const issue = makeIssueResponse({
        iid: 7,
        author_username: "issue-author",
        state: "opened",
      });
      const note = makeNoteResponse({ id: 300, body: "LGTM", author_username: "commenter-x" });
      originalFetch = mockFetch(issue, [note]);

      const chunks = await collectChunks(new Set(["issues/7"]));

      const commentChunks = chunks.filter(
        (c) => (c as { item_type?: string }).item_type === "ticket_comment"
      );
      expect(commentChunks.length).toBeGreaterThan(0);

      for (const chunk of commentChunks) {
        expect((chunk as { author?: string }).author).toBe("commenter-x");
        // Parent issue metadata still present
        expect((chunk as { state?: string }).state).toBe("open");
      }

      const issueChunks = chunks.filter(
        (c) => (c as { item_type?: string }).item_type === "ticket"
      );
      for (const chunk of issueChunks) {
        expect((chunk as { author?: string }).author).toBe("issue-author");
      }
    });

    it("system notes are skipped (not emitted as comment chunks)", async () => {
      const issue = makeIssueResponse({ iid: 9 });
      const systemNote = makeNoteResponse({ id: 400, body: "assigned to @alice", system: true });
      const realNote = makeNoteResponse({ id: 401, body: "Real comment", author_username: "human" });
      originalFetch = mockFetch(issue, [systemNote, realNote]);

      const chunks = await collectChunks(new Set(["issues/9"]));

      const commentChunks = chunks.filter(
        (c) => (c as { item_type?: string }).item_type === "ticket_comment"
      );
      // Only the real note should produce a comment chunk
      expect(commentChunks.length).toBe(1);
      expect((commentChunks[0] as { author?: string }).author).toBe("human");
    });
  });

  // ── Chunk-id stability: metadata does NOT affect chunk_id ─────────────────

  describe("chunk_id stability (metadata not in hash — D1)", () => {
    it("changing only labels does not change chunk_id", async () => {
      const issue1 = makeIssueResponse({ labels: [] });
      const issue2 = makeIssueResponse({ labels: ["Bug"] });

      originalFetch = mockFetch(issue1, []);
      const chunks1 = await collectChunks(new Set(["issues/1"]));

      globalThis.fetch = globalThis.fetch; // keep mock but swap response
      originalFetch = mockFetch(issue2, []);
      const chunks2 = await collectChunks(new Set(["issues/1"]));

      expect(chunks1.length).toBe(chunks2.length);
      for (let i = 0; i < chunks1.length; i++) {
        expect((chunks1[i] as { chunk_id: string }).chunk_id).toBe(
          (chunks2[i] as { chunk_id: string }).chunk_id
        );
      }
    });
  });
});
