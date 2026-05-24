/**
 * Unit tests for src/daemon/embedding-migration-scan.ts (Plan 77 Slice 6).
 *
 * Covers:
 *   - local preset, version < 2, < 50k chunks  → auto_enqueued
 *   - local preset, version < 2, ≥ 50k chunks  → awaiting_user_confirm, NOT enqueued
 *   - Voyage/OpenAI preset (non-local)           → skipped_non_local
 *   - version === 2 source                       → skipped_already_migrated
 *   - active migration job already queued        → skipped_duplicate_job
 *   - getAwaitingMigration filter by project_id
 *   - queue_status awaiting_migration integration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../src/registry.js", () => ({
  listProjects: vi.fn(() => []),
}));

vi.mock("../src/config.js", () => ({
  config: { dataDir: "/tmp/scrybe-test" },
  readScrybeConfig: vi.fn(() => null),
}));

vi.mock("../src/vector-store.js", () => ({
  countTableRows: vi.fn(async () => 0),
}));

vi.mock("../src/jobs-store.js", () => ({
  getQueueStatus: vi.fn(() => ({ running: [], queued: [] })),
}));

vi.mock("../src/daemon/queue.js", () => ({
  submitToQueue: vi.fn(() => ({ jobId: "mig-job-001", status: "queued", duplicateOfPending: false })),
}));

// Suppress daemon-log.jsonl writes in tests
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    appendFileSync: vi.fn(),
  };
});

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env["SCRYBE_DAEMON_LOG_PATH"];
});

afterEach(() => {
  vi.resetModules();
});

// ─── Helper: build a minimal Source ──────────────────────────────────────

function makeSource(overrides: {
  source_id?: string;
  type?: string;
  table_name?: string;
  embedding_schema_version?: number;
}) {
  return {
    source_id: overrides.source_id ?? "primary",
    source_config: { type: overrides.type ?? "code", root_path: "/repo", languages: [] },
    table_name: overrides.table_name ?? "code_abc123",
    embedding_schema_version: overrides.embedding_schema_version,
  };
}

function makeProject(id: string, sources: ReturnType<typeof makeSource>[]) {
  return { id, description: "test", sources };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("runEmbeddingMigrationScan", () => {
  it("auto-enqueues a local-preset source at version < 2 with < 50k chunks", async () => {
    const { listProjects } = await import("../src/registry.js");
    vi.mocked(listProjects).mockReturnValue([
      makeProject("proj-a", [makeSource({ embedding_schema_version: undefined })]) as any,
    ]);

    // Simulate local preset
    const { readScrybeConfig } = await import("../src/config.js");
    vi.mocked(readScrybeConfig).mockReturnValue({
      schema_version: 1,
      embedding_presets: {
        "local-default-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: { code_preset: "local-default-code", text_preset: "local-default-code" },
    });

    const enqueueJob = vi.fn();
    const countChunks = vi.fn(async () => 1234);

    const { runEmbeddingMigrationScan } = await import("../src/daemon/embedding-migration-scan.js");
    const awaiting = await runEmbeddingMigrationScan({ countChunks, enqueueJob });

    expect(awaiting).toHaveLength(0);
    expect(enqueueJob).toHaveBeenCalledOnce();
    expect(enqueueJob).toHaveBeenCalledWith("proj-a", "primary");
  });

  it("places source in awaiting_user_confirm when chunk count ≥ 50k (does NOT enqueue)", async () => {
    const { listProjects } = await import("../src/registry.js");
    vi.mocked(listProjects).mockReturnValue([
      makeProject("proj-b", [makeSource({ embedding_schema_version: 1 })]) as any,
    ]);

    const { readScrybeConfig } = await import("../src/config.js");
    vi.mocked(readScrybeConfig).mockReturnValue({
      schema_version: 1,
      embedding_presets: {
        "local-default-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: { code_preset: "local-default-code", text_preset: "local-default-code" },
    });

    const enqueueJob = vi.fn();
    const countChunks = vi.fn(async () => 80_000);

    const { runEmbeddingMigrationScan } = await import("../src/daemon/embedding-migration-scan.js");
    const awaiting = await runEmbeddingMigrationScan({ countChunks, enqueueJob });

    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({
      project_id: "proj-b",
      source_id: "primary",
      chunk_count: 80_000,
    });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("skips a Voyage/OpenAI (non-local) preset source — no enqueue, no awaiting", async () => {
    const { listProjects } = await import("../src/registry.js");
    vi.mocked(listProjects).mockReturnValue([
      makeProject("proj-c", [makeSource({ embedding_schema_version: undefined })]) as any,
    ]);

    const { readScrybeConfig } = await import("../src/config.js");
    vi.mocked(readScrybeConfig).mockReturnValue({
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
      },
      assignments: { code_preset: "voyage-code", text_preset: "voyage-code" },
    });

    const enqueueJob = vi.fn();
    const countChunks = vi.fn(async () => 500);

    const { runEmbeddingMigrationScan } = await import("../src/daemon/embedding-migration-scan.js");
    const awaiting = await runEmbeddingMigrationScan({ countChunks, enqueueJob });

    expect(awaiting).toHaveLength(0);
    expect(enqueueJob).not.toHaveBeenCalled();
    // countChunks should NOT be called for non-local presets
    expect(countChunks).not.toHaveBeenCalled();
  });

  it("skips a source already at embedding_schema_version 2 — idempotent", async () => {
    const { listProjects } = await import("../src/registry.js");
    vi.mocked(listProjects).mockReturnValue([
      makeProject("proj-d", [makeSource({ embedding_schema_version: 2 })]) as any,
    ]);

    const { readScrybeConfig } = await import("../src/config.js");
    vi.mocked(readScrybeConfig).mockReturnValue({
      schema_version: 1,
      embedding_presets: {
        "local-default-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: { code_preset: "local-default-code", text_preset: "local-default-code" },
    });

    const enqueueJob = vi.fn();
    const countChunks = vi.fn(async () => 100);

    const { runEmbeddingMigrationScan } = await import("../src/daemon/embedding-migration-scan.js");
    const awaiting = await runEmbeddingMigrationScan({ countChunks, enqueueJob });

    expect(awaiting).toHaveLength(0);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(countChunks).not.toHaveBeenCalled();
  });

  it("skips a source that already has an active full reindex job queued", async () => {
    const { listProjects } = await import("../src/registry.js");
    vi.mocked(listProjects).mockReturnValue([
      makeProject("proj-e", [makeSource({ embedding_schema_version: 1 })]) as any,
    ]);

    const { readScrybeConfig } = await import("../src/config.js");
    vi.mocked(readScrybeConfig).mockReturnValue({
      schema_version: 1,
      embedding_presets: {
        "local-default-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: { code_preset: "local-default-code", text_preset: "local-default-code" },
    });

    // Simulate an existing queued full reindex job
    const { getQueueStatus } = await import("../src/jobs-store.js");
    vi.mocked(getQueueStatus).mockReturnValue({
      running: [],
      queued: [{ job_id: "j1", project_id: "proj-e", source_id: "primary", mode: "full" } as any],
    });

    const enqueueJob = vi.fn();
    const countChunks = vi.fn(async () => 100);

    const { runEmbeddingMigrationScan } = await import("../src/daemon/embedding-migration-scan.js");
    const awaiting = await runEmbeddingMigrationScan({ countChunks, enqueueJob });

    expect(awaiting).toHaveLength(0);
    expect(enqueueJob).not.toHaveBeenCalled();
    // countChunks should NOT be called when a job is already active
    expect(countChunks).not.toHaveBeenCalled();
  });

  it("getAwaitingMigration returns the last scan result, filtered by project_id", async () => {
    const { listProjects } = await import("../src/registry.js");
    vi.mocked(listProjects).mockReturnValue([
      makeProject("proj-x", [makeSource({ source_id: "src-x", embedding_schema_version: 1 })]) as any,
      makeProject("proj-y", [makeSource({ source_id: "src-y", embedding_schema_version: 1 })]) as any,
    ]);

    const { readScrybeConfig } = await import("../src/config.js");
    vi.mocked(readScrybeConfig).mockReturnValue({
      schema_version: 1,
      embedding_presets: {
        "local-default-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: { code_preset: "local-default-code", text_preset: "local-default-code" },
    });

    // Both sources are large — both go into awaiting_user_confirm
    const countChunks = vi.fn(async () => 99_999);
    const enqueueJob = vi.fn();

    const { runEmbeddingMigrationScan, getAwaitingMigration } = await import("../src/daemon/embedding-migration-scan.js");
    await runEmbeddingMigrationScan({ countChunks, enqueueJob });

    const all = getAwaitingMigration();
    expect(all).toHaveLength(2);

    const filtered = getAwaitingMigration("proj-x");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ project_id: "proj-x", source_id: "src-x" });
  });

  it("queue_status in-process fallback includes awaiting_migration: [] when daemon is absent", async () => {
    // Simulate daemon-absent path (DaemonClient.fromPidfile returns null)
    vi.doMock("../src/daemon/client.js", () => ({
      ensureRunning: vi.fn(async () => ({ ok: false, reason: "no-pidfile" })),
      DaemonClient: { fromPidfile: vi.fn(() => null) },
    }));

    vi.doMock("../src/jobs-store.js", () => ({
      getQueueStatus: vi.fn(() => ({ running: [], queued: [] })),
      insertJob: vi.fn(),
      updateJobStatus: vi.fn(),
    }));

    // Import queue_status tool handler via all-tools to force fresh resolution
    const { queueStatusTool } = await import("../src/tools/reindex.js");
    const result = await queueStatusTool.handler({ project_id: undefined });

    expect(result).toMatchObject({
      running: expect.any(Array),
      queued: expect.any(Array),
      awaiting_migration: [],
    });
  });
});
