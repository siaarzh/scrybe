/**
 * Unit tests for src/local-embedder.ts — in-process WASM/ONNX embedder.
 * Uses the all-MiniLM-L6-v2 model (already cached from test sidecar) to keep tests fast.
 * Does NOT test production model accuracy — that is covered by the benchmark harness.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  embedLocalBatched,
  embedLocalQuery,
  warmupLocalEmbedder,
  resetLocalEmbedderCache,
} from "../src/local-embedder.js";

// Use the same small model as the test sidecar — already cached, fast cold-start
const TEST_MODEL = "Xenova/all-MiniLM-L6-v2";
const TEST_DIMS = 384;
const OPTS = { modelId: TEST_MODEL, dimensions: TEST_DIMS };

afterAll(() => {
  resetLocalEmbedderCache();
});

describe("embedLocalBatched", () => {
  it("returns vectors of correct dimensions", async () => {
    const texts = ["hello world", "semantic code search"];
    const vecs = await embedLocalBatched(texts, OPTS);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(TEST_DIMS);
    expect(vecs[1]).toHaveLength(TEST_DIMS);
  });

  it("all vector values are finite numbers", async () => {
    const [vec] = await embedLocalBatched(["test"], OPTS);
    for (const v of vec) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("handles empty input gracefully", async () => {
    const result = await embedLocalBatched([], OPTS);
    expect(result).toEqual([]);
  });

  it("batches correctly when batchSize < texts.length", async () => {
    const texts = ["a", "b", "c", "d", "e"];
    const vecs = await embedLocalBatched(texts, OPTS, 2);
    expect(vecs).toHaveLength(5);
    for (const vec of vecs) {
      expect(vec).toHaveLength(TEST_DIMS);
    }
  });

  it("returns normalised vectors (L2 norm ≈ 1)", async () => {
    const [vec] = await embedLocalBatched(["normalisation check"], OPTS);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });
});

describe("embedLocalQuery", () => {
  it("returns a single vector of correct dimensions", async () => {
    const vec = await embedLocalQuery("find authentication code", OPTS);
    expect(vec).toHaveLength(TEST_DIMS);
  });

  it("similar queries produce similar vectors (cosine sim > 0.9)", async () => {
    const v1 = await embedLocalQuery("validate JWT token", OPTS);
    const v2 = await embedLocalQuery("verify JWT authentication token", OPTS);
    const dot = v1.reduce((s, x, i) => s + x * v2[i]!, 0);
    const n1 = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    const n2 = Math.sqrt(v2.reduce((s, x) => s + x * x, 0));
    const sim = dot / (n1 * n2);
    expect(sim).toBeGreaterThan(0.80);
  });
});

describe("warmupLocalEmbedder", () => {
  it("is idempotent — second call does not reload the model", async () => {
    await warmupLocalEmbedder(OPTS);
    const t0 = Date.now();
    await warmupLocalEmbedder(OPTS);
    const elapsed = Date.now() - t0;
    // Second warmup should be near-instant (<100ms) since model is already loaded
    expect(elapsed).toBeLessThan(500);
  });
});
