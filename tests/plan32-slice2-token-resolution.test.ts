/**
 * Plan 32 — Slice 2: ${VAR} token resolution + literal warning
 *
 * Covers:
 * - validateGitlabToken: resolves ${VAR}, fails fast with actionable error on unset var,
 *   passes through literal tokens
 * - validateGithubToken: same resolution behaviour
 * - ticket-poller startTicketPoller: literal-token warning fires exactly once per daemon start
 * - ticket-poller literal-token warn-once dedup: second startTicketPoller call does not re-warn
 *   for already-warned sources (within the same module instance)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Poller mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../src/daemon/queue.js", () => ({
  enqueue: vi.fn().mockResolvedValue("job-ticket"),
  initQueue: vi.fn(),
  getQueueStats: vi.fn().mockReturnValue({ active: 0, pending: 0, maxConcurrent: 1 }),
  stopQueue: vi.fn(),
}));

vi.mock("../src/cursors.js", () => ({
  loadCursor: vi.fn().mockReturnValue("2024-01-01T00:00:00Z"),
  saveCursor: vi.fn(),
  deleteCursor: vi.fn(),
}));

vi.mock("../src/daemon/idle-state.js", () => ({
  getState: vi.fn().mockReturnValue("hot"),
  onStateChange: vi.fn(),
  touchActive: vi.fn(),
  getDebounceMs: vi.fn((ms: number) => ms),
  _resetForTests: vi.fn(),
}));

vi.mock("../src/daemon/events.js", () => ({
  diagEmit: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal ticket-source Project fixture with a controllable token. */
function makeTicketProject(opts: {
  id?: string;
  sourceId?: string;
  token?: string;
  provider?: string;
  baseUrl?: string;
}) {
  return {
    id: opts.id ?? "proj-test",
    description: "slice-2 test project",
    sources: [
      {
        source_id: opts.sourceId ?? "gl-issues",
        source_config: {
          type: "ticket" as const,
          provider: opts.provider ?? "gitlab",
          base_url: opts.baseUrl ?? "https://gitlab.example.com",
          project_id: "42",
          token: opts.token ?? "literal-tok",
        },
      },
    ],
  };
}

// ─── validateGitlabToken — token resolution ───────────────────────────────────

describe("validateGitlabToken — ${VAR} resolution", () => {
  it("resolves a ${VAR} token from process.env and calls fetch with the resolved value", async () => {
    process.env["SCRYBE_TEST_GL_TOKEN_S2"] = "resolved-gl-token";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const { validateGitlabToken } = await import("../src/plugins/gitlab-issues.js");
      await validateGitlabToken({
        type: "ticket",
        provider: "gitlab",
        base_url: "https://gitlab.example.com",
        project_id: "42",
        token: "${SCRYBE_TEST_GL_TOKEN_S2}",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(call[1]?.headers).toMatchObject({
        Authorization: "Bearer resolved-gl-token",
      });
    } finally {
      globalThis.fetch = origFetch;
      delete process.env["SCRYBE_TEST_GL_TOKEN_S2"];
    }
  });

  it("passes a literal token through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const { validateGitlabToken } = await import("../src/plugins/gitlab-issues.js");
      await validateGitlabToken({
        type: "ticket",
        provider: "gitlab",
        base_url: "https://gitlab.example.com",
        project_id: "42",
        token: "glpat-literal-token",
      });
      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(call[1]?.headers).toMatchObject({
        Authorization: "Bearer glpat-literal-token",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws with an actionable message naming the variable when var is unset", async () => {
    delete process.env["SCRYBE_TEST_GL_MISSING_S2"];

    const { validateGitlabToken } = await import("../src/plugins/gitlab-issues.js");
    await expect(
      validateGitlabToken({
        type: "ticket",
        provider: "gitlab",
        base_url: "https://gitlab.example.com",
        project_id: "42",
        token: "${SCRYBE_TEST_GL_MISSING_S2}",
      })
    ).rejects.toThrow(/SCRYBE_TEST_GL_MISSING_S2/);
  });

  it("error message for unset var mentions the source/project and how to fix it", async () => {
    delete process.env["SCRYBE_TEST_GL_MISSING_S2B"];

    const { validateGitlabToken } = await import("../src/plugins/gitlab-issues.js");
    let errMsg = "";
    try {
      await validateGitlabToken({
        type: "ticket",
        provider: "gitlab",
        base_url: "https://gitlab.example.com",
        project_id: "proj-42",
        token: "${SCRYBE_TEST_GL_MISSING_S2B}",
      });
    } catch (e) {
      errMsg = String(e);
    }
    expect(errMsg).toMatch(/SCRYBE_TEST_GL_MISSING_S2B/);
    // Should name the project or source context
    expect(errMsg).toMatch(/proj-42/);
    // Should give guidance (DATA_DIR or env)
    expect(errMsg).toMatch(/DATA_DIR|environment|\.env/i);
  });
});

// ─── validateGithubToken — token resolution ───────────────────────────────────

describe("validateGithubToken — ${VAR} resolution", () => {
  it("resolves a ${VAR} token from process.env", async () => {
    process.env["SCRYBE_TEST_GH_TOKEN_S2"] = "resolved-gh-token";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const { validateGithubToken } = await import("../src/plugins/github-issues.js");
      await validateGithubToken({
        type: "ticket",
        provider: "github",
        base_url: "https://api.github.com",
        project_id: "owner/repo",
        token: "${SCRYBE_TEST_GH_TOKEN_S2}",
      });
      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(call[1]?.headers).toMatchObject({
        Authorization: "Bearer resolved-gh-token",
      });
    } finally {
      globalThis.fetch = origFetch;
      delete process.env["SCRYBE_TEST_GH_TOKEN_S2"];
    }
  });

  it("throws with an actionable message naming the variable when var is unset", async () => {
    delete process.env["SCRYBE_TEST_GH_MISSING_S2"];

    const { validateGithubToken } = await import("../src/plugins/github-issues.js");
    await expect(
      validateGithubToken({
        type: "ticket",
        provider: "github",
        base_url: "https://api.github.com",
        project_id: "owner/repo",
        token: "${SCRYBE_TEST_GH_MISSING_S2}",
      })
    ).rejects.toThrow(/SCRYBE_TEST_GH_MISSING_S2/);
  });
});

// ─── ticket-poller — literal-token warning ────────────────────────────────────

describe("ticket-poller — literal-token warn-once on daemon start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  /** Count literal-token warning events (level=warn, detail.literalTokenWarn=true). */
  function countLiteralWarnEvents(pushEvent: ReturnType<typeof vi.fn>): number {
    return pushEvent.mock.calls.filter(
      ([ev]: [unknown]) =>
        typeof ev === "object" && ev !== null &&
        (ev as { level?: string }).level === "warn" &&
        ((ev as { detail?: Record<string, unknown> }).detail ?? {})["literalTokenWarn"] === true
    ).length;
  }

  it("emits a warn event when a ticket source uses a literal token", async () => {
    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent });
    startTicketPoller([makeTicketProject({ token: "glpat-literal-token" })]);

    expect(countLiteralWarnEvents(pushEvent)).toBe(1);
  });

  it("does NOT emit a literal-token warn for a ${VAR} token", async () => {
    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent });
    startTicketPoller([makeTicketProject({ token: "${SCRYBE_GITLAB_TOKEN}" })]);

    expect(countLiteralWarnEvents(pushEvent)).toBe(0);
  });

  it("emits exactly one warn even when startTicketPoller is called twice for the same source", async () => {
    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller, stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent });

    const project = makeTicketProject({ token: "glpat-literal-rearm" });
    startTicketPoller([project]);
    expect(countLiteralWarnEvents(pushEvent)).toBe(1);

    // Stop and restart — same key, _warnedLiteralToken still holds it
    stopTicketPoller();
    startTicketPoller([project]);
    expect(countLiteralWarnEvents(pushEvent)).toBe(1); // still 1, not 2
  });

  it("emits separate warns for two different sources with literal tokens", async () => {
    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent });

    const projects = [
      makeTicketProject({ id: "proj-a", sourceId: "src-a", token: "literal-a" }),
      makeTicketProject({ id: "proj-b", sourceId: "src-b", token: "literal-b" }),
    ];
    startTicketPoller(projects);

    // One warn per distinct source
    expect(countLiteralWarnEvents(pushEvent)).toBe(2);
  });
});
