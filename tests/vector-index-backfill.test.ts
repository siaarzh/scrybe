/**
 * Unit tests for the vector-index idle backfill (src/daemon/vector-index-backfill.ts).
 * Plan 95 Phase 3.
 *
 * Mirrors tests/auto-gc.test.ts's mocking shape — mocks registry/vector-store/queue,
 * but deliberately does NOT mock auto-gc.js so the real `IdleTracker` class (reused
 * from Phase-1 auto-gc) drives the idle timing.
 *
 * Fake timers are only used where a test needs to fast-forward the idle window
 * itself; once the timer has fired, tests switch back to real timers before
 * draining the backfill queue (the queue drain loop is driven by microtasks
 * from the mocked createVectorIndex plus a real-clock poll in `_drainForTests`,
 * which would never resolve under fake timers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../src/registry.js", () => ({
  listProjects: vi.fn(() => []),
  getProject: vi.fn(),
}));

vi.mock("../src/vector-store.js", () => ({
  createVectorIndex: vi.fn(() => Promise.resolve()),
}));

vi.mock("../src/branch-state.js", () => ({
  getAllChunkIdsForSource: vi.fn(),
}));

vi.mock("../src/jobs-store.js", () => ({
  getLastGcTime: vi.fn(() => null),
  insertJob: vi.fn(),
  updateJobStatus: vi.fn(),
  cancelPendingGcJobs: vi.fn(),
}));

vi.mock("../src/daemon/queue.js", () => ({
  submitToQueue: vi.fn(() => ({ jobId: "job-123", status: "queued", duplicateOfPending: false })),
  onQueueJobEvent: vi.fn(),
  cancelPendingByType: vi.fn(() => 0),
}));

vi.mock("../src/config.js", () => ({
  config: { vectorIndexEnabled: true },
}));

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS"];
  delete process.env["SCRYBE_VECTOR_INDEX_REBUILD_ROWS"];
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

function fakeProject(id: string, tableNames: string[]) {
  return {
    id,
    description: "test",
    sources: tableNames.map((tableName, i) => ({
      source_id: `source-${i}`,
      source_config: { type: "code", root_path: "/tmp", languages: ["ts"] },
      table_name: tableName,
    })),
  } as any;
}

describe("runIdleSweep", () => {
  it("calls createVectorIndex for every table_name on the project", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(fakeProject("proj-a", ["proj_a_code", "proj_a_kb"]));

    const { runIdleSweep, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
    runIdleSweep("proj-a");
    await _drainForTests();

    expect(createVectorIndex).toHaveBeenCalledWith("proj_a_code");
    expect(createVectorIndex).toHaveBeenCalledWith("proj_a_kb");
    expect(createVectorIndex).toHaveBeenCalledTimes(2);
  });

  it("does nothing when config.vectorIndexEnabled is false", async () => {
    const { config } = await import("../src/config.js");
    const typedConfig = config as { vectorIndexEnabled: boolean };
    const original = typedConfig.vectorIndexEnabled;
    typedConfig.vectorIndexEnabled = false;
    try {
      const { getProject } = await import("../src/registry.js");
      const { createVectorIndex } = await import("../src/vector-store.js");
      vi.mocked(getProject).mockReturnValue(fakeProject("proj-disabled", ["proj_disabled_code"]));

      const { runIdleSweep, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
      runIdleSweep("proj-disabled");
      await _drainForTests();

      expect(createVectorIndex).not.toHaveBeenCalled();
    } finally {
      typedConfig.vectorIndexEnabled = original;
    }
  });

  it("no-ops for an unknown/removed project", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(undefined);

    const { runIdleSweep, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
    runIdleSweep("proj-gone");
    await _drainForTests();

    expect(createVectorIndex).not.toHaveBeenCalled();
  });

  it("dedupes a table already queued/in-flight rather than double-processing it", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(fakeProject("proj-dup", ["proj_dup_code"]));

    const { runIdleSweep, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
    runIdleSweep("proj-dup");
    runIdleSweep("proj-dup"); // fires again before the first has drained
    await _drainForTests();

    expect(createVectorIndex).toHaveBeenCalledTimes(1);
  });
});

describe("sequential processing (one table at a time)", () => {
  it("does not start the second table's build until the first resolves", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");

    vi.mocked(getProject).mockImplementation((id: string) => {
      if (id === "proj-x") return fakeProject("proj-x", ["table_x"]);
      if (id === "proj-y") return fakeProject("proj-y", ["table_y"]);
      return undefined;
    });

    let resolveFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => { resolveFirst = r; });
    const order: string[] = [];

    vi.mocked(createVectorIndex).mockImplementation(async (tableName: string) => {
      order.push(`start:${tableName}`);
      if (tableName === "table_x") await firstGate;
      order.push(`end:${tableName}`);
    });

    const { runIdleSweep, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
    runIdleSweep("proj-x");
    runIdleSweep("proj-y");

    // Give the queue a tick to start processing the first item.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start:table_x"]); // second table must NOT have started yet

    resolveFirst();
    await _drainForTests();

    expect(order).toEqual(["start:table_x", "end:table_x", "start:table_y", "end:table_y"]);
  });
});

describe("initVectorIndexBackfill idle wiring", () => {
  it("fires the idle sweep after the idle window elapses, then serially builds and reports completion", async () => {
    const { getProject, listProjects } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    const proj = fakeProject("proj-idle", ["proj_idle_code"]);
    vi.mocked(listProjects).mockReturnValue([proj]);
    vi.mocked(getProject).mockReturnValue(proj);

    process.env["SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS"] = "100";
    const { initVectorIndexBackfill, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
    const pushEvent = vi.fn();

    vi.useFakeTimers();
    initVectorIndexBackfill({ pushEvent });
    vi.advanceTimersByTime(200); // fires the idle timer synchronously, invoking runIdleSweep
    vi.useRealTimers(); // switch back so _drainForTests' real-clock poll can resolve

    await _drainForTests();

    expect(createVectorIndex).toHaveBeenCalledWith("proj_idle_code");
    expect(pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "vector-index.completed", detail: expect.objectContaining({ tableName: "proj_idle_code" }) })
    );
  });

  it("cancel() on the returned tracker prevents the idle sweep from firing", async () => {
    const { getProject, listProjects } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    const proj = fakeProject("proj-cancelled", ["proj_cancelled_code"]);
    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(getProject).mockReturnValue(proj);

    process.env["SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS"] = "100";
    const { initVectorIndexBackfill } = await import("../src/daemon/vector-index-backfill.js");

    vi.useFakeTimers();
    const tracker = initVectorIndexBackfill({ pushEvent: vi.fn() });
    tracker.reset("proj-cancelled");
    tracker.cancel("proj-cancelled");

    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));

    expect(createVectorIndex).not.toHaveBeenCalled();
  });

  it("emits vector-index.failed and keeps draining the queue when a build throws", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockImplementation((id: string) => {
      if (id === "proj-err") return fakeProject("proj-err", ["table_bad", "table_good"]);
      return undefined;
    });
    vi.mocked(createVectorIndex).mockImplementation(async (tableName: string) => {
      if (tableName === "table_bad") throw new Error("boom");
    });

    const { runIdleSweep, initVectorIndexBackfill, _drainForTests } = await import("../src/daemon/vector-index-backfill.js");
    const pushEvent = vi.fn();
    initVectorIndexBackfill({ pushEvent });

    runIdleSweep("proj-err");
    await _drainForTests();

    expect(createVectorIndex).toHaveBeenCalledWith("table_bad");
    expect(createVectorIndex).toHaveBeenCalledWith("table_good");
    expect(pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "vector-index.failed", detail: expect.objectContaining({ tableName: "table_bad" }) })
    );
  });
});

describe("rebuild cadence (Plan 95 Phase 4)", () => {
  it("recordUpsertForRebuildCadence marks a table for force rebuild only once the accumulated rows cross the threshold", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(fakeProject("proj-cadence", ["table_cadence"]));

    process.env["SCRYBE_VECTOR_INDEX_REBUILD_ROWS"] = "100";
    const { recordUpsertForRebuildCadence, runIdleSweep, _drainForTests } =
      await import("../src/daemon/vector-index-backfill.js");

    // Below threshold: 50 rows added; 20% of rowsAfter (200) is 40, so the
    // absolute floor (100) governs — 50 < 100, no mark yet.
    recordUpsertForRebuildCadence("table_cadence", 50, 200);
    runIdleSweep("proj-cadence");
    await _drainForTests();
    expect(createVectorIndex).toHaveBeenCalledWith("table_cadence"); // plain additive call, not forced
    vi.mocked(createVectorIndex).mockClear();

    // Crosses threshold: accumulated 50 + 60 = 110 >= 100 → force rebuild requested.
    recordUpsertForRebuildCadence("table_cadence", 60, 260);
    runIdleSweep("proj-cadence");
    await _drainForTests();
    expect(createVectorIndex).toHaveBeenCalledWith("table_cadence", { force: true });
  });

  it("recordUpsertForRebuildCadence uses 20% of rowsAfter when it exceeds the absolute floor", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(fakeProject("proj-pct", ["table_pct"]));

    // Default floor is 1000; a 50,000-row table's 20% (10,000) is the governing threshold.
    const { recordUpsertForRebuildCadence, runIdleSweep, _drainForTests } =
      await import("../src/daemon/vector-index-backfill.js");

    recordUpsertForRebuildCadence("table_pct", 9000, 50_000); // below 10,000 → no mark
    runIdleSweep("proj-pct");
    await _drainForTests();
    expect(createVectorIndex).toHaveBeenCalledWith("table_pct");
    vi.mocked(createVectorIndex).mockClear();

    recordUpsertForRebuildCadence("table_pct", 2000, 52_000); // accumulated 11,000 >= 10,000 → mark
    runIdleSweep("proj-pct");
    await _drainForTests();
    expect(createVectorIndex).toHaveBeenCalledWith("table_pct", { force: true });
  });

  it("markFullReindexForRebuild always requests a force rebuild regardless of accumulated rows", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(fakeProject("proj-full", ["table_full"]));

    const { markFullReindexForRebuild, runIdleSweep, _drainForTests } =
      await import("../src/daemon/vector-index-backfill.js");

    markFullReindexForRebuild("table_full");
    runIdleSweep("proj-full");
    await _drainForTests();

    expect(createVectorIndex).toHaveBeenCalledWith("table_full", { force: true });
  });

  it("does not mark for rebuild when config.vectorIndexEnabled is false", async () => {
    const { config } = await import("../src/config.js");
    const typedConfig = config as { vectorIndexEnabled: boolean };
    const original = typedConfig.vectorIndexEnabled;
    typedConfig.vectorIndexEnabled = false;
    try {
      const { getProject } = await import("../src/registry.js");
      const { createVectorIndex } = await import("../src/vector-store.js");
      vi.mocked(getProject).mockReturnValue(fakeProject("proj-cadence-off", ["table_cadence_off"]));

      const { recordUpsertForRebuildCadence, markFullReindexForRebuild, runIdleSweep, _drainForTests } =
        await import("../src/daemon/vector-index-backfill.js");

      // Both entry points are no-ops with the master gate off, and runIdleSweep
      // itself short-circuits — createVectorIndex must never be invoked at all.
      recordUpsertForRebuildCadence("table_cadence_off", 1_000_000, 1_000_000);
      markFullReindexForRebuild("table_cadence_off");
      runIdleSweep("proj-cadence-off");
      await _drainForTests();

      expect(createVectorIndex).not.toHaveBeenCalled();
    } finally {
      typedConfig.vectorIndexEnabled = original;
    }
  });

  it("a force mark is consumed exactly once — the following sweep goes back to the plain additive call", async () => {
    const { getProject } = await import("../src/registry.js");
    const { createVectorIndex } = await import("../src/vector-store.js");
    vi.mocked(getProject).mockReturnValue(fakeProject("proj-once", ["table_once"]));

    const { markFullReindexForRebuild, runIdleSweep, _drainForTests } =
      await import("../src/daemon/vector-index-backfill.js");

    markFullReindexForRebuild("table_once");
    runIdleSweep("proj-once");
    await _drainForTests();
    expect(createVectorIndex).toHaveBeenLastCalledWith("table_once", { force: true });
    vi.mocked(createVectorIndex).mockClear();

    runIdleSweep("proj-once"); // no new mark since the last sweep
    await _drainForTests();
    expect(createVectorIndex).toHaveBeenLastCalledWith("table_once"); // back to plain
  });
});
