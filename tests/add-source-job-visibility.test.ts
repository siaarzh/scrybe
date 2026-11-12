/**
 * Plan 67 — add_source auto-enqueue + job visibility.
 *
 * 5 test cases:
 *   T1 — happy path: daemon up → returns job_id + status
 *   T2 — visibility-within-1s: job appears in queue_status immediately after add_source
 *   T3 — embedding-broken: throws embeddingConfigError before registry write; source NOT registered
 *   T4 — daemon spawn-failed / health-timeout: throws daemon_unavailable; source NOT registered
 *   T5 — opt-out (SCRYBE_NO_AUTO_DAEMON / container): registers + returns in-process job_id
 *
 * Approach: all mocks are at top level (hoisted by vitest). The config mock exposes a
 * `_setEmbeddingError` helper so T3 can simulate a broken embedding config without
 * requiring module re-evaluation.
 *
 * isolate.ts (setupFiles) handles per-test DATA_DIR + vi.resetModules() between describe
 * blocks — but we DON'T rely on resetModules here because all our mocks are static.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Top-level mocks (hoisted by vitest) ─────────────────────────────────────

// Mutable embedding error — null means "healthy"
let _embeddingConfigError: string | null = null;

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  config: {
    get embeddingConfigError() { return _embeddingConfigError; },
    get dataDir() { return process.env["SCRYBE_DATA_DIR"]!; },
    embeddingApiKey: "test",
    embeddingBaseUrl: "http://localhost:11111/v1",
    embeddingModel: "test-model",
    embeddingDimensions: 384,
    embedBatchSize: 100,
    embedBatchDelayMs: 0,
    hybridEnabled: false,
    rrfK: 60,
  },
  VERSION: "0.0.0-test",
}));

// Spread the REAL module and override only what this test controls.
//
// A factory that lists exports explicitly silently rots: the moment production
// code imports one more symbol from this module, every test using the mock dies
// with `No "X" export is defined on the mock` -- a failure tsc cannot see and
// that only a full-suite run surfaces. That is exactly what happened here (two
// separate symbols, from two separate commits, both invisible until the suite
// ran end-to-end). Spreading `importOriginal` keeps the mock honest by default;
// pure helpers then run for real, which is what the assertions want anyway.
vi.mock("../src/daemon/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/client.js")>()),
  ensureRunning: vi.fn(),
  DaemonClient: {
    fromPidfile: vi.fn(),
  },
}));

vi.mock("../src/jobs.js", () => ({
  submitSourceJob: vi.fn(),
  submitJob: vi.fn(),
  submitAllJob: vi.fn(),
  getJobStatus: vi.fn().mockReturnValue(null),
  cancelJob: vi.fn().mockReturnValue(false),
  cancelAllJobs: vi.fn(),
  listJobs: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/registry.js", () => ({
  addSource: vi.fn(),
  addProject: vi.fn(),
  getProject: vi.fn().mockReturnValue({ id: "proj1", sources: [] }),
  getSource: vi.fn().mockReturnValue(null),
  updateSource: vi.fn(),
  removeSource: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockReturnValue([]),
  isSearchable: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock("../src/plugins/gitlab-issues.js", () => ({
  validateGitlabToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/daemon/pidfile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/pidfile.js")>()),
  readPidfile: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/daemon/spawn-detached.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/spawn-detached.js")>()),
  processEnvNames: vi.fn().mockReturnValue("gone"),
}));

vi.mock("../src/jobs-store.js", () => ({
  getQueueStatus: vi.fn().mockReturnValue({ running: [], queued: [] }),
  insertJob: vi.fn(),
  updateJobStatus: vi.fn(),
  getJobRow: vi.fn().mockReturnValue(null),
  listJobRows: vi.fn().mockReturnValue([]),
  jobRowToState: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal code-source input */
const baseInput = {
  project_id: "proj1",
  source_id: "code",
  source_type: "code",
  root_path: "/tmp/repo",
  languages: "ts",
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _embeddingConfigError = null; // healthy by default
});

// ─── T1 — happy path ─────────────────────────────────────────────────────────

describe("T1 — happy path: daemon up → returns job_id + status", () => {
  it("returns job_id and status from daemon submitReindex", async () => {
    const { ensureRunning, DaemonClient } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: true });

    const mockClient = {
      submitReindex: vi.fn().mockResolvedValue({
        jobs: [{
          jobId: "job-abc123",
          projectId: "proj1",
          sourceId: "code",
          branch: "",
          status: "queued",
          queuePosition: 1,
        }],
      }),
    };
    vi.mocked(DaemonClient.fromPidfile).mockReturnValue(mockClient as any);

    const { addSourceTool } = await import("../src/tools/source.js");
    const result = await addSourceTool.handler(baseInput);

    expect(result.ok).toBe(true);
    expect(result.project_id).toBe("proj1");
    expect(result.source_id).toBe("code");
    expect(result.job_id).toBe("job-abc123");
    expect(result.status).toBe("queued");
    expect(result.queue_position).toBe(1);

    // Registry was written
    const { addSource } = await import("../src/registry.js");
    expect(addSource).toHaveBeenCalledOnce();

    // submitReindex called with correct shape
    expect(mockClient.submitReindex).toHaveBeenCalledWith({
      projectId: "proj1",
      sourceId: "code",
      mode: "incremental",
    });
  });

  it("includes duplicate_of_pending when daemon signals a duplicate", async () => {
    const { ensureRunning, DaemonClient } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: true });

    const mockClient = {
      submitReindex: vi.fn().mockResolvedValue({
        jobs: [{
          jobId: "job-dup-456",
          projectId: "proj1",
          sourceId: "code",
          branch: "",
          status: "queued",
          duplicateOfPending: true,
        }],
      }),
    };
    vi.mocked(DaemonClient.fromPidfile).mockReturnValue(mockClient as any);

    const { addSourceTool } = await import("../src/tools/source.js");
    const result = await addSourceTool.handler(baseInput);

    expect(result.duplicate_of_pending).toBe(true);
    expect(result.job_id).toBe("job-dup-456");
  });
});

// ─── T2 — visibility-within-1s ───────────────────────────────────────────────

describe("T2 — visibility-within-1s: job appears in queue_status after add_source", () => {
  it("queue_status returns submitted job within 1s of add_source returning", async () => {
    const { ensureRunning, DaemonClient } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: true });

    const queuedJob = {
      jobId: "job-vis-001",
      projectId: "proj1",
      sourceId: "code",
      branch: "",
      status: "queued" as const,
      queuePosition: 1,
    };

    const mockClient = {
      submitReindex: vi.fn().mockResolvedValue({ jobs: [queuedJob] }),
      queueStatus: vi.fn().mockResolvedValue({
        running: [],
        queued: [{ job_id: "job-vis-001", project_id: "proj1", source_id: "code", status: "queued" }],
      }),
    };
    vi.mocked(DaemonClient.fromPidfile).mockReturnValue(mockClient as any);

    const { addSourceTool } = await import("../src/tools/source.js");
    const t0 = Date.now();
    const addResult = await addSourceTool.handler(baseInput);
    const elapsed = Date.now() - t0;

    // add_source must return quickly (no blocking poll)
    expect(elapsed).toBeLessThan(1000);
    expect(addResult.job_id).toBe("job-vis-001");

    // queue_status shows the job immediately (synchronous mock — simulates sub-1s SQLite write)
    const queueResult = await mockClient.queueStatus("proj1");
    expect(queueResult.queued.length + queueResult.running.length).toBeGreaterThanOrEqual(1);
    const allJobs = [...queueResult.running, ...queueResult.queued] as Array<{ job_id: string }>;
    expect(allJobs.some((j) => j.job_id === addResult.job_id)).toBe(true);
  });
});

// ─── T3 — embedding-broken ───────────────────────────────────────────────────

describe("T3 — embedding-broken: throws before registry write", () => {
  it("throws embeddingConfigError and does NOT register the source", async () => {
    _embeddingConfigError = "No embedding provider configured. Run: scrybe init";

    const { addSourceTool } = await import("../src/tools/source.js");
    const { addSource } = await import("../src/registry.js");
    const { ensureRunning } = await import("../src/daemon/client.js");

    await expect(addSourceTool.handler(baseInput)).rejects.toThrow(
      "No embedding provider configured. Run: scrybe init"
    );

    // Source must NOT have been registered — D5 gate fires before any side effect
    expect(addSource).not.toHaveBeenCalled();
    // ensureRunning must NOT have been called either
    expect(ensureRunning).not.toHaveBeenCalled();
  });
});

// ─── T4 — daemon spawn-failed / health-timeout ───────────────────────────────

describe("T4 — daemon spawn-failed: throws daemon_unavailable; source rolled back", () => {
  it("throws with error_type=daemon_unavailable on spawn-failed", async () => {
    const { ensureRunning, DaemonClient } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: false, reason: "spawn-failed" });
    vi.mocked(DaemonClient.fromPidfile).mockReturnValue(null as any);

    const { addSourceTool } = await import("../src/tools/source.js");
    const { addSource } = await import("../src/registry.js");

    let caught: (Error & { error_type?: string }) | null = null;
    try {
      await addSourceTool.handler(baseInput);
    } catch (e) {
      caught = e as Error & { error_type?: string };
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("daemon failed to start");
    expect(caught!.error_type).toBe("daemon_unavailable");
    // Saved first so a spawned daemon sees it, then removed again because it was never indexed
    const { removeSource } = await import("../src/registry.js");
    expect(addSource).toHaveBeenCalledOnce();
    expect(removeSource).toHaveBeenCalledWith("proj1", "code");
    expect(vi.mocked(removeSource).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(addSource).mock.invocationCallOrder[0]!);
  });

  it("throws daemon_unavailable on health-timeout", async () => {
    const { ensureRunning } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: false, reason: "health-timeout" });

    const { addSourceTool } = await import("../src/tools/source.js");
    const { addSource } = await import("../src/registry.js");

    let caught: (Error & { error_type?: string }) | null = null;
    try {
      await addSourceTool.handler(baseInput);
    } catch (e) {
      caught = e as Error & { error_type?: string };
    }

    expect(caught).not.toBeNull();
    expect(caught!.error_type).toBe("daemon_unavailable");
    const { removeSource } = await import("../src/registry.js");
    expect(addSource).toHaveBeenCalledOnce();
    expect(removeSource).toHaveBeenCalledWith("proj1", "code");
  });
});

// ─── T5 — opt-out fallback ───────────────────────────────────────────────────

describe("T5 — opt-out: registers + returns in-process job_id", () => {
  it("uses in-process submitSourceJob when daemon is opted out (SCRYBE_NO_AUTO_DAEMON)", async () => {
    const { ensureRunning } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: false, reason: "opted-out" });

    const { submitSourceJob } = await import("../src/jobs.js");
    vi.mocked(submitSourceJob).mockReturnValue("job-inproc-007");

    const { addSourceTool } = await import("../src/tools/source.js");
    const result = await addSourceTool.handler(baseInput);

    expect(result.ok).toBe(true);
    expect(result.job_id).toBe("job-inproc-007");
    expect(result.status).toBe("started");

    // Registry was written
    const { addSource } = await import("../src/registry.js");
    expect(addSource).toHaveBeenCalledOnce();

    // submitSourceJob called with correct args
    expect(submitSourceJob).toHaveBeenCalledWith("proj1", "code", "incremental");
  });

  it("uses in-process fallback in container environments", async () => {
    const { ensureRunning } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: false, reason: "container" });

    const { submitSourceJob } = await import("../src/jobs.js");
    vi.mocked(submitSourceJob).mockReturnValue("job-container-008");

    const { addSourceTool } = await import("../src/tools/source.js");
    const result = await addSourceTool.handler(baseInput);

    expect(result.ok).toBe(true);
    expect(result.job_id).toBe("job-container-008");
    expect(result.status).toBe("started");

    const { addSource } = await import("../src/registry.js");
    expect(addSource).toHaveBeenCalledOnce();
  });
});

// ─── T6 — the source is saved before the daemon is started ───────────────────

describe("T6 — order: registry write before ensureRunning", () => {
  it("saves the source before it can spawn a daemon, so the daemon sees the source's ${VAR} reference", async () => {
    const { ensureRunning, DaemonClient } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: true });
    vi.mocked(DaemonClient.fromPidfile).mockReturnValue({
      submitReindex: vi.fn().mockResolvedValue({ jobs: [{ jobId: "j", status: "queued" }] }),
    } as any);
    const { addSourceTool } = await import("../src/tools/source.js");
    const { addSource } = await import("../src/registry.js");
    await addSourceTool.handler(baseInput);
    expect(vi.mocked(addSource).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ensureRunning).mock.invocationCallOrder[0]!);
  });
});

// ─── T7 — warning when the running daemon lacks the token variable ──────────

type EnvNames = Set<string> | "gone" | null;

async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: any) => { writes.push(String(c)); return true; });
  try { await fn(); } finally { spy.mockRestore(); }
  return writes.join("");
}

async function stubDaemon(names: EnvNames, pid: number | null = 100) {
  const { readPidfile } = await import("../src/daemon/pidfile.js");
  const { processEnvNames } = await import("../src/daemon/spawn-detached.js");
  vi.mocked(readPidfile).mockReset().mockReturnValue(pid === null ? null : { pid, port: 1 } as any);
  vi.mocked(processEnvNames).mockReset().mockReturnValue(names);
}

describe.skipIf(process.platform !== "linux")("T7 — source add warns when the running daemon can't see its ${VAR}", () => {
  const ticketInput = (token: string) => ({
    project_id: "proj1", source_id: "issues", source_type: "ticket",
    provider: "gitlab", url: "https://gitlab.example", project: "1", token,
  });

  async function run(token: string, names: EnvNames, opts: { pid?: number | null; env?: Record<string, string>; refBefore?: boolean } = {}) {
    const { ensureRunning, DaemonClient } = await import("../src/daemon/client.js");
    vi.mocked(ensureRunning).mockResolvedValue({ ok: true });
    vi.mocked(DaemonClient.fromPidfile).mockReturnValue({
      submitReindex: vi.fn().mockResolvedValue({ jobs: [{ jobId: "j", status: "queued" }] }),
    } as any);
    await stubDaemon(names, opts.pid === undefined ? 100 : opts.pid);
    const { writeFileSync } = await import("fs");
    const { join } = await import("path");
    writeFileSync(join(process.env["SCRYBE_DATA_DIR"]!, "projects.json"), opts.refBefore ? '[{"t":"${GITLAB_PAT}"}]' : "[]");
    const saved = { ...process.env };
    Object.assign(process.env, opts.env ?? {});
    try {
      const { addSourceTool } = await import("../src/tools/source.js");
      return await captureStderr(() => addSourceTool.handler(ticketInput(token) as any));
    } finally {
      for (const k of Object.keys(opts.env ?? {})) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }

  it("warns with the remedy when the running daemon's environment lacks the variable", async () => {
    const out = await run("${GITLAB_PAT}", new Set(["PATH", "HOME"]));
    expect(out).toContain("GITLAB_PAT");
    expect(out).toContain("scrybe daemon stop");
    expect(out).toContain("SCRYBE_DAEMON_ENV_PASSTHROUGH");
    expect(out).toContain("SCRYBE_<something>");
  });

  it("stays quiet when the daemon has it, e.g. one this call spawned after saving the source", async () => {
    expect(await run("${GITLAB_PAT}", new Set(["PATH", "GITLAB_PAT"]))).toBe("");
  });

  it("warns for a second source reusing a variable the running daemon still lacks", async () => {
    expect(await run("${GITLAB_PAT}", new Set(["PATH"]), { refBefore: true })).toContain("GITLAB_PAT");
  });

  it("stays quiet with a stale pidfile or no pidfile", async () => {
    expect(await run("${GITLAB_PAT}", "gone")).toBe("");
    expect(await run("${GITLAB_PAT}", "gone", { pid: null })).toBe("");
  });

  it("falls back to whether config referenced it before when the daemon's env can't be read", async () => {
    expect(await run("${GITLAB_PAT}", null)).toContain("GITLAB_PAT");
    expect(await run("${GITLAB_PAT}", null, { refBefore: true })).toBe("");
  });

  it("stays quiet for a SCRYBE_ name, a passthrough name, or a literal token", async () => {
    expect(await run("${SCRYBE_GITLAB_TOKEN}", new Set(["PATH"]))).toBe("");
    expect(await run("${GITLAB_PAT}", new Set(["PATH"]), { env: { SCRYBE_DAEMON_ENV_PASSTHROUGH: "GITLAB_PAT" } })).toBe("");
    expect(await run("glpat-literal", new Set(["PATH"]))).toBe("");
  });
});

describe.skipIf(process.platform !== "linux")("T8 — source update warns the same way", () => {
  it("warns when the running daemon lacks the new token's variable, quiet when no daemon is running", async () => {
    const { getSource } = await import("../src/registry.js");
    const { updateSourceTool } = await import("../src/tools/source.js");
    const ticket = { source_id: "issues", source_config: { type: "ticket", provider: "gitlab", base_url: "https://g", project_id: "1", token: "x" } };
    const runUpdate = async (names: EnvNames, token: string) => {
      vi.mocked(getSource).mockReturnValueOnce(ticket as any);
      await stubDaemon(names);
      return captureStderr(() => updateSourceTool.handler({ project_id: "proj1", source_id: "issues", token }));
    };
    expect(await runUpdate(new Set(["PATH"]), "${GITLAB_PAT}")).toContain("scrybe daemon stop");
    expect(await runUpdate("gone", "${GITLAB_PAT}")).toBe("");
    expect(await runUpdate(new Set(["PATH"]), "${SCRYBE_GITLAB_TOKEN}")).toBe("");
  });
});
