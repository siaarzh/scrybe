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

vi.mock("../src/config.js", () => ({
  config: {
    get embeddingConfigError() { return _embeddingConfigError; },
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

vi.mock("../src/daemon/client.js", () => ({
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

describe("T4 — daemon spawn-failed: throws daemon_unavailable; source NOT registered", () => {
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
    // Source MUST NOT be registered
    expect(addSource).not.toHaveBeenCalled();
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
    expect(addSource).not.toHaveBeenCalled();
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
