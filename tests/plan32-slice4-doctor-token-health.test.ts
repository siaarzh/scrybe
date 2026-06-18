/**
 * Plan 32 — Slice 4: Doctor token health checks
 *
 * Covers the "Ticket Sources" section added to runDoctor():
 * - resolve-fail: ${VAR} token with unset env var → fail on token_resolve, skip on token_probe
 * - probe-fail: token resolves but provider probe rejects → ok on token_resolve, fail on token_probe
 * - healthy: token resolves + probe passes → ok on both
 * Both GitLab and GitHub providers are exercised.
 *
 * The MCP doctor tool (doctor-mcp.ts) is a thin pass-through of runDoctor(); the
 * "Ticket Sources" section filter is verified as a bonus case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp = "";

// ── Shared standard mocks (always applied) ─────────────────────────────────────

/**
 * Registers the set of mocks required by runDoctor() for infrastructure that
 * is not under test in this file. Call before importing runDoctor().
 */
function mockDoctorInfra() {
  vi.doMock("../src/onboarding/validate-provider.js", () => ({
    validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
    validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
  }));
  vi.doMock("../src/daemon/pidfile.js", () => ({
    readPidfile: () => null,
    isDaemonRunning: () => false,
  }));
  vi.doMock("../src/onboarding/mcp-config.js", () => ({
    detectMcpConfigs: () => [],
    readScrybeEntry: () => null,
    proposeScrybeEntry: () => ({}),
  }));
  vi.doMock("../src/daemon/container-detect.js", () => ({
    isContainer: () => false,
  }));
  vi.doMock("../src/daemon/install/index.js", () => ({
    getInstallStatus: async () => ({ installed: false }),
  }));
  vi.doMock("../src/vector-store.js", () => ({
    countTableRows: async () => 0,
    readTableMeta: () => null,
  }));
  vi.doMock("../src/branch-state.js", () => ({
    getLastIndexedSha: vi.fn(() => null),
    listBranches: vi.fn(() => []),
  }));
  vi.doMock("../src/util/git-exec.js", () => ({
    gitExec: vi.fn(() => null),
  }));
  vi.doMock("../src/install-doctor.js", () => ({
    detectBrokenInstall: () => null,
    attemptSelfRepair: vi.fn(),
  }));
}

/** Write a projects.json with one ticket source fixture. */
function writeTicketProject(opts: {
  dir: string;
  provider?: string;
  token?: string;
  projectId?: string;
  baseUrl?: string;
  sourceId?: string;
}) {
  const {
    dir,
    provider = "gitlab",
    token = "${SCRYBE_TEST_TOKEN}",
    projectId = "owner/repo",
    baseUrl = provider === "github" ? "https://api.github.com" : "https://gitlab.com",
    sourceId = "issues",
  } = opts;

  const project = {
    id: "test-proj",
    description: "test project",
    sources: [
      {
        source_id: sourceId,
        source_config: {
          type: "ticket",
          provider,
          base_url: baseUrl,
          project_id: projectId,
          token,
        },
        last_indexed: new Date().toISOString(),
      },
    ],
  };
  writeFileSync(join(dir, "projects.json"), JSON.stringify([project]), "utf8");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-doctor-ticket-test-"));
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = tmp;
  process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
  process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = "voyage-code-3";
  process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = "1024";
  process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test-key";
  // Ensure the test token var is not set by default
  delete process.env["SCRYBE_TEST_TOKEN"];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env["SCRYBE_DATA_DIR"];
  delete process.env["SCRYBE_TEST_TOKEN"];
});

// ─── GitLab ───────────────────────────────────────────────────────────────────

describe("runDoctor — ticket source token health (GitLab)", () => {
  it("resolve-fail: unset ${VAR} → fail on token_resolve, skip on token_probe", async () => {
    writeTicketProject({ dir: tmp, provider: "gitlab", token: "${SCRYBE_TEST_TOKEN}" });
    // SCRYBE_TEST_TOKEN is NOT set
    mockDoctorInfra();
    // Validate fns should NOT be called (skip guard)
    const validateGitlabMock = vi.fn();
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: validateGitlabMock,
      GitLabIssuesPlugin: class {},
    }));
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn(),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const resolveCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_resolve",
    );
    expect(resolveCheck).toBeDefined();
    expect(resolveCheck!.status).toBe("fail");
    expect(resolveCheck!.message).toContain("SCRYBE_TEST_TOKEN");
    expect(resolveCheck!.remedy).toContain("SCRYBE_TEST_TOKEN");
    expect(resolveCheck!.remedy).toContain(".env");

    const probeCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_probe",
    );
    expect(probeCheck).toBeDefined();
    expect(probeCheck!.status).toBe("skip");
    expect(probeCheck!.message).toContain("SCRYBE_TEST_TOKEN");

    // Validate fn must not have been called
    expect(validateGitlabMock).not.toHaveBeenCalled();
  });

  it("probe-fail: token resolves but validateGitlabToken throws → fail on token_probe", async () => {
    process.env["SCRYBE_TEST_TOKEN"] = "bad-token";
    writeTicketProject({ dir: tmp, provider: "gitlab", token: "${SCRYBE_TEST_TOKEN}" });

    mockDoctorInfra();
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn().mockRejectedValue(
        new Error("GitLab token for project is expired (HTTP 401)"),
      ),
      GitLabIssuesPlugin: class {},
    }));
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn(),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const resolveCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_resolve",
    );
    expect(resolveCheck!.status).toBe("ok");
    expect(resolveCheck!.message).toContain("SCRYBE_TEST_TOKEN");

    const probeCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_probe",
    );
    expect(probeCheck).toBeDefined();
    expect(probeCheck!.status).toBe("fail");
    expect(probeCheck!.message).toContain("401");
    expect(probeCheck!.remedy).toContain("read_api");
  });

  it("healthy: token resolves and validateGitlabToken succeeds → ok on both", async () => {
    process.env["SCRYBE_TEST_TOKEN"] = "valid-token";
    writeTicketProject({ dir: tmp, provider: "gitlab", token: "${SCRYBE_TEST_TOKEN}" });

    mockDoctorInfra();
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn().mockResolvedValue(undefined),
      GitLabIssuesPlugin: class {},
    }));
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn(),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const resolveCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_resolve",
    );
    expect(resolveCheck!.status).toBe("ok");

    const probeCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_probe",
    );
    expect(probeCheck!.status).toBe("ok");
    expect(probeCheck!.message).toContain("accepted");
  });

  it("literal token: no ${VAR} reference → ok on token_resolve", async () => {
    writeTicketProject({ dir: tmp, provider: "gitlab", token: "glpat-literal-token-here" });

    mockDoctorInfra();
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn().mockResolvedValue(undefined),
      GitLabIssuesPlugin: class {},
    }));
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn(),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const resolveCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_resolve",
    );
    expect(resolveCheck!.status).toBe("ok");
    expect(resolveCheck!.message).toContain("Literal");
  });
});

// ─── GitHub ───────────────────────────────────────────────────────────────────

describe("runDoctor — ticket source token health (GitHub)", () => {
  it("resolve-fail: unset ${VAR} → fail on token_resolve, skip on token_probe", async () => {
    writeTicketProject({ dir: tmp, provider: "github", token: "${SCRYBE_TEST_TOKEN}" });
    // SCRYBE_TEST_TOKEN is NOT set
    mockDoctorInfra();
    const validateGithubMock = vi.fn();
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: validateGithubMock,
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn(),
      GitLabIssuesPlugin: class {},
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const resolveCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_resolve",
    );
    expect(resolveCheck!.status).toBe("fail");
    expect(resolveCheck!.message).toContain("SCRYBE_TEST_TOKEN");

    const probeCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_probe",
    );
    expect(probeCheck!.status).toBe("skip");
    expect(validateGithubMock).not.toHaveBeenCalled();
  });

  it("probe-fail: token resolves but validateGithubToken throws → fail on token_probe", async () => {
    process.env["SCRYBE_TEST_TOKEN"] = "bad-github-token";
    writeTicketProject({ dir: tmp, provider: "github", token: "${SCRYBE_TEST_TOKEN}" });

    mockDoctorInfra();
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn().mockRejectedValue(
        new Error("GitHub token for project is invalid or expired (HTTP 401)"),
      ),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn(),
      GitLabIssuesPlugin: class {},
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const probeCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_probe",
    );
    expect(probeCheck!.status).toBe("fail");
    expect(probeCheck!.message).toContain("401");
    expect(probeCheck!.remedy).toContain("Issues: Read-only");
  });

  it("healthy: token resolves and validateGithubToken succeeds → ok on both", async () => {
    process.env["SCRYBE_TEST_TOKEN"] = "valid-github-token";
    writeTicketProject({ dir: tmp, provider: "github", token: "${SCRYBE_TEST_TOKEN}" });

    mockDoctorInfra();
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn().mockResolvedValue(undefined),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn(),
      GitLabIssuesPlugin: class {},
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const resolveCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_resolve",
    );
    expect(resolveCheck!.status).toBe("ok");

    const probeCheck = report.checks.find(
      (c) => c.id === "ticket.test-proj.issues.token_probe",
    );
    expect(probeCheck!.status).toBe("ok");
    expect(probeCheck!.message).toContain("accepted");
  });
});

// ─── No ticket sources ────────────────────────────────────────────────────────

describe("runDoctor — no ticket sources", () => {
  it("no Ticket Sources checks when no ticket sources registered", async () => {
    const project = {
      id: "code-only",
      description: "code only project",
      sources: [
        {
          source_id: "primary",
          source_config: { type: "code", root_path: tmp, languages: [] },
          last_indexed: new Date().toISOString(),
        },
      ],
    };
    writeFileSync(join(tmp, "projects.json"), JSON.stringify([project]), "utf8");

    mockDoctorInfra();

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const ticketChecks = report.checks.filter((c) => c.section === "Ticket Sources");
    expect(ticketChecks).toHaveLength(0);
  });
});

// ─── MCP doctor section filter ────────────────────────────────────────────────

describe("MCP doctor — section filter for Ticket Sources", () => {
  it("section='Ticket Sources' returns only ticket token checks", async () => {
    process.env["SCRYBE_TEST_TOKEN"] = "valid-token";
    writeTicketProject({ dir: tmp, provider: "gitlab", token: "${SCRYBE_TEST_TOKEN}" });

    mockDoctorInfra();
    vi.doMock("../src/plugins/gitlab-issues.js", () => ({
      validateGitlabToken: vi.fn().mockResolvedValue(undefined),
      GitLabIssuesPlugin: class {},
    }));
    vi.doMock("../src/plugins/github-issues.js", () => ({
      validateGithubToken: vi.fn(),
      GitHubIssuesPlugin: class {},
      isPullRequest: vi.fn(() => false),
    }));

    const { doctorTool } = await import("../src/tools/doctor-mcp.js");
    const result = await doctorTool.handler({ section: "Ticket Sources" });

    expect(result.checks.every((c) => c.section === "Ticket Sources")).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    // Both token_resolve and token_probe should be present
    const ids = result.checks.map((c) => c.id);
    expect(ids.some((id) => id.includes("token_resolve"))).toBe(true);
    expect(ids.some((id) => id.includes("token_probe"))).toBe(true);
  });
});
