/**
 * Unit tests for init MCP tool — per-provider hybrid validation (Plan 83, Phase 2).
 *
 * Verifies:
 * 1. Local provider + registered project → returns ok:true + job_id WITHOUT calling validateLocal.
 * 2. Bad API key → returns synchronous validation_failed with typed errorType.
 * 3. Mixed code=local / text=api → validates the API provider synchronously; local is deferred.
 * 4. Local + no registered projects → returns status:"configured" (no job_id, no blocking).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

let dataDir = "";
let repoDir = "";

function makeFixtureRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "index.ts"), "export const x = 1;");
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-init-defer-"));
  repoDir = mkdtempSync(join(tmpdir(), "scrybe-init-defer-repo-"));
  makeFixtureRepo(repoDir);
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = dataDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  delete process.env["SCRYBE_DATA_DIR"];
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function loadInitTool() {
  const { initTool } = await import("../src/tools/init-mcp.js");
  return initTool;
}

// Mock validate-provider so we can assert call counts
function mockValidateProvider(ok: boolean = true) {
  const validateProviderMock = vi.fn().mockResolvedValue(
    ok
      ? { ok: true, dimensions: 1024, model: "voyage-code-3" }
      : { ok: false, errorType: "auth", message: "Invalid API key" }
  );
  const validateLocalMock = vi.fn().mockResolvedValue(
    { ok: true, dimensions: 384, model: "Xenova/multilingual-e5-small", coldStartMs: 50 }
  );
  vi.doMock("../src/onboarding/validate-provider.js", () => ({
    validateProvider: validateProviderMock,
    validateLocal: validateLocalMock,
    classifyLocalLoadError: (err: unknown) => ({ message: String(err) }),
  }));
  return { validateProviderMock, validateLocalMock };
}

// Register a project so init has something to enqueue
async function registerProject(projectId: string) {
  const { addProject } = await import("../src/registry.js");
  addProject({
    id: projectId,
    name: "test-project",
    sources: [
      {
        source_id: "src-1",
        table_name: null,
        source_config: {
          type: "code",
          root_path: repoDir,
          branch_filter: null,
        },
        embedding_preset: null,
        filters: null,
      },
    ],
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("init — local provider defers download (no validateLocal call)", () => {
  it("returns ok:true + job_id without calling validateLocal", async () => {
    const { validateLocalMock } = mockValidateProvider();

    // Mock daemon so init can enqueue the job without a real daemon
    vi.doMock("../src/daemon/client.js", () => ({
      ensureRunning: vi.fn().mockResolvedValue({ ok: false }),
      DaemonClient: { fromPidfile: vi.fn().mockReturnValue(null) },
    }));
    vi.doMock("../src/jobs.js", () => ({
      submitSourceJob: vi.fn().mockReturnValue("fake-job-id"),
    }));

    await registerProject("proj-local");

    const tool = await loadInitTool();
    const result = await tool.handler({
      code_provider: "local",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("configured");
    // validateLocal must NOT have been called — local providers are deferred
    expect(validateLocalMock).not.toHaveBeenCalled();
    // A job_id is returned for the caller to poll
    expect(typeof result.job_id).toBe("string");
  });
});

describe("init — bad API key → synchronous validation_failed", () => {
  it("returns validation_failed with errorType for a bad Voyage key", async () => {
    const { validateLocalMock } = mockValidateProvider(false /* auth fail */);

    vi.doMock("../src/daemon/client.js", () => ({
      ensureRunning: vi.fn().mockResolvedValue({ ok: false }),
      DaemonClient: { fromPidfile: vi.fn().mockReturnValue(null) },
    }));

    const tool = await loadInitTool();
    const result = await tool.handler({
      code_provider: "voyage",
      code_api_key: "bad-key",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("validation_failed");
    expect(result.validation?.errorType).toBe("auth");
    // validateLocal should NOT have been called for an API provider failure
    expect(validateLocalMock).not.toHaveBeenCalled();
  });
});

describe("init — mixed code=local / text=api validates API synchronously", () => {
  it("validates API text provider and defers local code provider", async () => {
    const { validateProviderMock, validateLocalMock } = mockValidateProvider(true);

    vi.doMock("../src/daemon/client.js", () => ({
      ensureRunning: vi.fn().mockResolvedValue({ ok: false }),
      DaemonClient: { fromPidfile: vi.fn().mockReturnValue(null) },
    }));
    vi.doMock("../src/jobs.js", () => ({
      submitSourceJob: vi.fn().mockReturnValue("fake-job-id"),
    }));

    await registerProject("proj-mixed");

    const tool = await loadInitTool();
    const result = await tool.handler({
      code_provider: "local",
      text_provider: "voyage",
      text_api_key: "valid-key",
    });

    expect(result.ok).toBe(true);
    // validateProvider MUST have been called for the API text provider
    expect(validateProviderMock).toHaveBeenCalled();
    // validateLocal must NOT have been called — local code provider is deferred
    expect(validateLocalMock).not.toHaveBeenCalled();
  });
});

describe("init — local provider with no registered projects", () => {
  it("returns status:configured without a job_id (nothing to index)", async () => {
    const { validateLocalMock } = mockValidateProvider();

    vi.doMock("../src/daemon/client.js", () => ({
      ensureRunning: vi.fn().mockResolvedValue({ ok: false }),
      DaemonClient: { fromPidfile: vi.fn().mockReturnValue(null) },
    }));

    // No registerProject call — no projects registered

    const tool = await loadInitTool();
    const result = await tool.handler({
      code_provider: "local",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("configured");
    expect(result.job_id).toBeUndefined();
    // validateLocal must NOT have been called
    expect(validateLocalMock).not.toHaveBeenCalled();
  });
});
