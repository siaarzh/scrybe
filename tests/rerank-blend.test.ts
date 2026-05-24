/**
 * Unit tests for the position-aware blending math in src/reranker.ts.
 * Plan 77 Slice 5.
 *
 * Tests applyBlend() directly — verifies that blended scores produce the
 * expected ordering given different (rank, rerank_score) combinations.
 */

import { describe, it, expect } from "vitest";
import { applyBlend } from "../src/reranker.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidates(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_id: `chunk-${i + 1}`,
    content: `content for chunk ${i + 1}`,
    score: 1 - i * 0.1, // decreasing retrieval score
  }));
}

// Default blend weights (matches config defaults)
const TOP3: [number, number] = [0.75, 0.25];
const TAIL: [number, number] = [0.40, 0.60];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("applyBlend — position-aware blending math (Plan 77 Slice 5)", () => {
  it("returns top-K candidates", () => {
    const candidates = makeCandidates(10);
    const rerankScores = candidates.map((_, i) => 1 - i * 0.05); // slightly different
    const result = applyBlend(candidates, rerankScores, 5, TOP3, TAIL);
    expect(result.length).toBe(5);
  });

  it("returns fewer than K if fewer candidates exist", () => {
    const candidates = makeCandidates(3);
    const rerankScores = [0.9, 0.8, 0.7];
    const result = applyBlend(candidates, rerankScores, 10, TOP3, TAIL);
    expect(result.length).toBe(3);
  });

  it("handles empty candidates list", () => {
    const result = applyBlend([], [], 5, TOP3, TAIL);
    expect(result).toEqual([]);
  });

  it("preserves order when retrieval and rerank scores are identical", () => {
    // All rerank scores equal → normalized_rerank = 0.5 for all → rank weight dominates
    const candidates = makeCandidates(5);
    const rerankScores = [0.5, 0.5, 0.5, 0.5, 0.5]; // all equal
    const result = applyBlend(candidates, rerankScores, 5, TOP3, TAIL);
    // With equal rerank scores and decreasing retrieval rank, original order preserved
    expect(result[0]!.chunk_id).toBe("chunk-1");
  });

  it("reranks: a candidate with very high cross-encoder score rises from rank 4+ to top-3", () => {
    // Simulate: retrieval gives [A, B, C, D, E] where D is the true relevant doc.
    // D has rerank score 0.99, others ~0.1-0.3.
    const candidates = [
      { chunk_id: "A", content: "doc A", score: 0.9 },
      { chunk_id: "B", content: "doc B", score: 0.8 },
      { chunk_id: "C", content: "doc C", score: 0.7 },
      { chunk_id: "D", content: "doc D", score: 0.6 }, // rank 4 initially
      { chunk_id: "E", content: "doc E", score: 0.5 },
    ];
    // D gets a very high cross-encoder score; others get low scores
    const rerankScores = [0.15, 0.20, 0.10, 0.99, 0.05];

    const result = applyBlend(candidates, rerankScores, 5, TOP3, TAIL);

    // D should rise into top-3 (rank 4 uses interpolated weights ~0.71/0.29 → rerank still matters)
    const dIdx = result.findIndex((r) => r.chunk_id === "D");
    expect(dIdx).toBeLessThan(3); // D is in top-3 after blending
  });

  it("top-3 weighting: high retrieval rank candidates are not displaced by marginal rerank advantage", () => {
    // A is rank-1 with decent rerank; B is rank-5 with slightly better rerank score.
    // With top-3 weights (0.75, 0.25), A's rank advantage should keep it above B.
    const candidates = [
      { chunk_id: "A", content: "doc A", score: 0.9 }, // rank 1
      { chunk_id: "B", content: "doc B", score: 0.8 }, // rank 2
      { chunk_id: "C", content: "doc C", score: 0.7 }, // rank 3
      { chunk_id: "D", content: "doc D", score: 0.6 }, // rank 4
      { chunk_id: "E", content: "doc E", score: 0.5 }, // rank 5
    ];
    // B at rank 2 has better rerank score than A at rank 1, but not dramatically
    const rerankScores = [0.70, 0.80, 0.60, 0.55, 0.50];

    const result = applyBlend(candidates, rerankScores, 5, TOP3, TAIL);

    // A (rank 1, rerank 0.70) vs B (rank 2, rerank 0.80):
    // A's normalized_rank = 1.0, B's normalized_rank = 0.75
    // rerank scores normalized: 0.70 → 0.67, 0.80 → 1.0
    // A: 0.75 * 1.0 + 0.25 * 0.67 = 0.917
    // B: 0.75 * 0.75 + 0.25 * 1.0 = 0.813
    // A should remain above B
    const aIdx = result.findIndex((r) => r.chunk_id === "A");
    const bIdx = result.findIndex((r) => r.chunk_id === "B");
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("blended scores are always in [0, 1] range", () => {
    const candidates = makeCandidates(15);
    const rerankScores = candidates.map((_, i) => Math.random());
    const result = applyBlend(candidates, rerankScores, 15, TOP3, TAIL);
    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1 + 1e-9); // tiny float tolerance
    }
  });

  it("result is sorted by blended score descending", () => {
    const candidates = makeCandidates(10);
    const rerankScores = Array.from({ length: 10 }, () => Math.random());
    const result = applyBlend(candidates, rerankScores, 10, TOP3, TAIL);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score - 1e-9);
    }
  });

  it("handles single candidate gracefully", () => {
    const candidates = [{ chunk_id: "only", content: "sole doc", score: 0.8 }];
    const rerankScores = [0.95];
    const result = applyBlend(candidates, rerankScores, 1, TOP3, TAIL);
    expect(result.length).toBe(1);
    expect(result[0]!.chunk_id).toBe("only");
    // normalized_rank = 1.0 (only candidate), normalized_rerank = 1.0 (only candidate)
    // blended = 0.75 * 1.0 + 0.25 * 1.0 = 1.0
    expect(result[0]!.score).toBeCloseTo(1.0, 4);
  });

  it("all-equal rerank scores do not cause division by zero (rRange ~= 0)", () => {
    const candidates = makeCandidates(5);
    const rerankScores = [0.5, 0.5, 0.5, 0.5, 0.5]; // identical — rRange = 0
    expect(() => applyBlend(candidates, rerankScores, 5, TOP3, TAIL)).not.toThrow();
    const result = applyBlend(candidates, rerankScores, 5, TOP3, TAIL);
    expect(result.length).toBe(5);
  });
});
