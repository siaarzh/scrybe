/**
 * downloading-model job phase + progress_callback wiring.
 *
 * Covers:
 * 1. SourceTask.phase type includes "downloading-model" (runtime shape).
 * 2. getPipeline progress_callback aggregation logic — single file and multi-file.
 * 3. embedLocalBatched threads onDownloadProgress to getPipeline (no-op on cached model).
 * 4. onDownloadProgress is optional — existing call sites with no callback still work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-plan82-s2-"));
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = tmp;
  process.env["SCRYBE_MODEL_CACHE_DIR"] = join(tmp, "models");
});

afterEach(() => {
  delete process.env["SCRYBE_DATA_DIR"];
  delete process.env["SCRYBE_MODEL_CACHE_DIR"];
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── 1. SourceTask phase type is additive ────────────────────────────────────

describe("SourceTask.phase — downloading-model is a valid phase value", () => {
  it("accepts downloading-model as a phase string at runtime", async () => {
    // Import types indirectly via jobs-store shape. This test is mainly a TS gate
    // but we exercise it at runtime to confirm no runtime assertion strips it.
    vi.resetModules();
    // We just confirm the string is accepted in a SourceTask-shaped object.
    const task: import("../src/types.js").SourceTask = {
      source_id: "s1",
      mode: "incremental",
      status: "running",
      phase: "downloading-model",
      percent: 42,
      files_scanned: 0,
      chunks_prepared: 0,
      started_at: Date.now(),
      finished_at: null,
      error: null,
    };
    expect(task.phase).toBe("downloading-model");
    expect(task.percent).toBe(42);
  });

  it("percent is undefined when not downloading", async () => {
    const task: import("../src/types.js").SourceTask = {
      source_id: "s1",
      mode: "incremental",
      status: "running",
      phase: "scanning",
      files_scanned: 5,
      chunks_prepared: 0,
      started_at: Date.now(),
      finished_at: null,
      error: null,
    };
    expect(task.percent).toBeUndefined();
  });
});

// ─── 2. Progress aggregation logic ───────────────────────────────────────────

describe("getPipeline progress_callback aggregation", () => {
  it("reports byte-weighted rising percent; a tiny sidecar file cannot pin it to 100", async () => {
    vi.resetModules();

    const MB = 1_000_000;
    // Mirror a real multi-file model download: a tiny config.json completes
    // before the multi-MB weights start streaming. @xenova/transformers fires
    // `status: "progress"` events (NOT "downloading") with byte loaded/total.
    const fakeEvents = [
      // config.json finishes first — far below the 1 MB report floor, so it
      // must NOT emit anything (the old bug pinned percent to 100 here).
      { status: "progress", file: "config.json", loaded: 500, total: 500 },
      // weights begin streaming — now the cumulative size is meaningful.
      { status: "progress", file: "model.onnx", loaded: 0, total: 113 * MB },
      { status: "progress", file: "model.onnx", loaded: 28 * MB, total: 113 * MB },
      { status: "progress", file: "model.onnx", loaded: 56 * MB, total: 113 * MB },
      { status: "progress", file: "model.onnx", loaded: 113 * MB, total: 113 * MB },
      { status: "done", file: "model.onnx" },
      { status: "ready" },
    ];

    vi.doMock("../src/util/transformers-loader.js", () => ({
      getTransformers: async () => ({
        env: { cacheDir: "" },
        pipeline: async (
          _task: string,
          _model: string,
          opts: { progress_callback?: (e: Record<string, unknown>) => void; revision?: string },
        ) => {
          for (const e of fakeEvents) opts.progress_callback?.(e);
          const extractor = async (batch: string[]) =>
            Object.assign(
              batch.map(() => ({ data: new Float32Array([0.1, 0.2]) })),
              { dims: [batch.length, 2] }
            );
          return extractor;
        },
      }),
      resolveModelCacheDir: () => join(tmp, "models"),
    }));

    const { embedLocalBatched, resetLocalEmbedderCache } = await import("../src/local-embedder.js");
    resetLocalEmbedderCache();

    const percents: number[] = [];
    const onDownloadProgress = (p: { percent: number }) => percents.push(p.percent);

    await embedLocalBatched(["hello"], { modelId: "test/model", dimensions: 2 }, 64, onDownloadProgress);

    expect(percents.length).toBeGreaterThan(0);
    // Regression: the tiny config.json must not have produced a reading at all —
    // the first emitted percent reflects the weights, near 0, not 100.
    expect(percents[0]).toBeLessThan(10);
    // Monotonically non-decreasing across the dominant file.
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
    // Climbs to a meaningful high value, but is capped at 99 during download —
    // the job's flip to the "embedding" phase signals completion, not a 100 here.
    expect(Math.max(...percents)).toBeGreaterThanOrEqual(49);
    expect(Math.max(...percents)).toBeLessThanOrEqual(99);
    expect(percents).not.toContain(100);
  });

  it("does NOT fire onDownloadProgress when model is already cached", async () => {
    vi.resetModules();

    const fakePipeline = vi.fn();

    vi.doMock("../src/util/transformers-loader.js", () => ({
      getTransformers: async () => ({ pipeline: fakePipeline, env: { cacheDir: "" } }),
      resolveModelCacheDir: () => join(tmp, "models"),
    }));

    const { embedLocalBatched, resetLocalEmbedderCache } = await import("../src/local-embedder.js");
    resetLocalEmbedderCache();

    // Prime the cache by providing a fake pipeline result
    const mockExtractor = vi.fn(async () => ({
      data: new Float32Array([0.1]),
      dims: [1, 1],
    }));
    fakePipeline.mockResolvedValue(mockExtractor);

    // First call — loads pipeline (progress_callback could fire, but our fake doesn't emit download events)
    try { await embedLocalBatched(["prime"], { modelId: "cached/model", dimensions: 1 }, 64); } catch { /* ignore */ }

    // Second call — model is cached, pipeline() is NOT called again
    const percents: number[] = [];
    const onDownloadProgress = (p: { percent: number }) => percents.push(p.percent);
    try { await embedLocalBatched(["hello"], { modelId: "cached/model", dimensions: 1 }, 64, onDownloadProgress); } catch { /* ignore */ }

    // pipeline() should only have been called once (first call to prime)
    expect(fakePipeline).toHaveBeenCalledTimes(1);
    // No download events were fired on the cached path
    expect(percents).toHaveLength(0);
  });

  it("callback is optional — embedLocalBatched works without it", async () => {
    vi.resetModules();

    const mockExtractor = vi.fn(async () => ({
      data: new Float32Array([0.1, 0.2]),
      dims: [1, 2],
    }));
    const fakePipeline = vi.fn().mockResolvedValue(mockExtractor);

    vi.doMock("../src/util/transformers-loader.js", () => ({
      getTransformers: async () => ({ pipeline: fakePipeline, env: { cacheDir: "" } }),
      resolveModelCacheDir: () => join(tmp, "models"),
    }));

    const { embedLocalBatched, resetLocalEmbedderCache } = await import("../src/local-embedder.js");
    resetLocalEmbedderCache();

    // Should not throw — callback is undefined
    await expect(
      embedLocalBatched([], { modelId: "test/model", dimensions: 2 })
    ).resolves.toEqual([]);
  });
});
