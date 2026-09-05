/**
 * Guard tests for the embedder-bench decision logic (Plan 126, commit
 * 4b19279). `run.ts` is a CLI script (matches no vitest include glob, calls
 * `process.exit`, and downloads/runs real ONNX models), so nothing ever
 * exercised these guards. This file imports the pure decision functions
 * `run.ts` exports — `pickRecommendation` and `checkSaturation` — and drives
 * them directly with synthetic `BenchResult` fixtures. No model is loaded,
 * no network call is made, and `main()` is never imported.
 *
 * Guards under test:
 *   1. A single-candidate run (`--model X`) must never name a recommended
 *      default, even when that one candidate would otherwise clear every
 *      threshold.
 *   2. When more than one candidate scores 100% recall@3, the run must
 *      report the fixture as saturated rather than silently picking a
 *      winner off the tie.
 */
import { describe, it, expect } from "vitest";
import {
  pickRecommendation,
  checkSaturation,
  type BenchResult,
} from "./run.js";

function result(overrides: Partial<BenchResult>): BenchResult {
  return {
    modelId: "test/model",
    notes: "fixture",
    diskMb: 50,
    coldStartMs: 100,
    actualDims: 384,
    warmRps: 100,
    recall3: 0.5,
    recall5: 0.6,
    mrr: 0.4,
    xRecall3: 0.5,
    xMrr: 0.4,
    xN: 2,
    ...overrides,
  };
}

describe("pickRecommendation — single-candidate guard", () => {
  it("refuses to recommend when only one candidate ran and it is valid", () => {
    const valid = [result({ modelId: "only/candidate", mrr: 0.9, xMrr: 0.9 })];
    const { recommended, reason } = pickRecommendation(valid, /* candidatesRun */ 1);
    expect(reason).toBe("single-candidate-run");
    expect(recommended).toBeNull();
  });

  it("does recommend when the same result appears but two candidates ran", () => {
    const valid = [
      result({ modelId: "a", mrr: 0.9, xMrr: 0.9 }),
      result({ modelId: "b", mrr: 0.1, xMrr: 0.1 }),
    ];
    const { recommended, reason } = pickRecommendation(valid, /* candidatesRun */ 2);
    expect(reason).toBe("recommended");
    expect(recommended?.modelId).toBe("a");
  });

  it("reports no-valid-candidates (not single-candidate-run) when a solo run produced nothing valid", () => {
    const { recommended, reason } = pickRecommendation([], /* candidatesRun */ 1);
    expect(reason).toBe("no-valid-candidates");
    expect(recommended).toBeNull();
  });
});

describe("checkSaturation — tie guard", () => {
  it("flags the fixture as saturated when more than one candidate hits 100% recall@3", () => {
    const results = [
      result({ modelId: "a", recall3: 1 }),
      result({ modelId: "b", recall3: 1 }),
      result({ modelId: "c", recall3: 0.5 }),
    ];
    const s = checkSaturation(results);
    expect(s.saturated).toBe(true);
    expect(s.solvedCount).toBe(2);
    expect(s.solvedModelIds.sort()).toEqual(["a", "b"]);
  });

  it("does not flag saturation when only one candidate hits 100% recall@3", () => {
    const results = [
      result({ modelId: "a", recall3: 1 }),
      result({ modelId: "b", recall3: 0.5 }),
    ];
    const s = checkSaturation(results);
    expect(s.saturated).toBe(false);
    expect(s.solvedCount).toBe(1);
  });

  it("excludes errored candidates from the saturation count even if recall3 is stale/undefined", () => {
    const results = [
      result({ modelId: "a", recall3: 1 }),
      { modelId: "b", notes: "fixture", error: "boom", recall3: 1 } as BenchResult,
    ];
    const s = checkSaturation(results);
    expect(s.saturated).toBe(false);
    expect(s.solvedCount).toBe(1);
  });
});
