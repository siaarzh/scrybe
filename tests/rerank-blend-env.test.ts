/**
 * Unit tests for SCRYBE_RERANK_BLEND_TOP3 / SCRYBE_RERANK_BLEND_TAIL env-var parsing.
 * Plan 77 Slice 5 — position-aware rerank blend configuration.
 *
 * Tests parseBlendWeights() directly (exported from src/config.ts).
 */

import { describe, it, expect } from "vitest";
import { parseBlendWeights } from "../src/config.js";

describe("parseBlendWeights — env-var parsing (Plan 77 Slice 5)", () => {
  it("parses a valid top-3 blend string", () => {
    const [wR, wX] = parseBlendWeights("0.75,0.25", "SCRYBE_RERANK_BLEND_TOP3");
    expect(wR).toBeCloseTo(0.75, 6);
    expect(wX).toBeCloseTo(0.25, 6);
  });

  it("parses a valid tail blend string", () => {
    const [wR, wX] = parseBlendWeights("0.40,0.60", "SCRYBE_RERANK_BLEND_TAIL");
    expect(wR).toBeCloseTo(0.40, 6);
    expect(wX).toBeCloseTo(0.60, 6);
  });

  it("parses equal weights (0.50,0.50)", () => {
    const [wR, wX] = parseBlendWeights("0.50,0.50", "SCRYBE_RERANK_BLEND_TOP3");
    expect(wR).toBeCloseTo(0.50, 6);
    expect(wX).toBeCloseTo(0.50, 6);
  });

  it("accepts sum within ±0.01 tolerance (0.751,0.250 → sum=1.001)", () => {
    // 1.001 is within the ±0.01 tolerance band
    expect(() => parseBlendWeights("0.751,0.250", "SCRYBE_RERANK_BLEND_TOP3")).not.toThrow();
  });

  it("rejects string with only one value", () => {
    expect(() => parseBlendWeights("0.75", "SCRYBE_RERANK_BLEND_TOP3")).toThrow(
      /exactly 2 comma-separated floats/
    );
  });

  it("rejects string with three values", () => {
    expect(() => parseBlendWeights("0.33,0.33,0.34", "SCRYBE_RERANK_BLEND_TOP3")).toThrow(
      /exactly 2 comma-separated floats/
    );
  });

  it("rejects non-numeric values", () => {
    expect(() => parseBlendWeights("foo,bar", "SCRYBE_RERANK_BLEND_TOP3")).toThrow(
      /finite numbers/
    );
  });

  it("rejects weights that don't sum to 1.0 (outside ±0.01 tolerance)", () => {
    // 0.5 + 0.3 = 0.8, well outside tolerance
    expect(() => parseBlendWeights("0.50,0.30", "SCRYBE_RERANK_BLEND_TAIL")).toThrow(
      /sum to 1\.0/
    );
  });

  it("rejects empty string", () => {
    expect(() => parseBlendWeights("", "SCRYBE_RERANK_BLEND_TOP3")).toThrow();
  });

  it("includes env var name in error messages for easy diagnosis", () => {
    expect(() => parseBlendWeights("bad", "SCRYBE_RERANK_BLEND_TOP3")).toThrow(
      /SCRYBE_RERANK_BLEND_TOP3/
    );
  });

  it("the default top-3 blend values '0.75,0.25' parse correctly", () => {
    const [wR, wX] = parseBlendWeights("0.75,0.25", "SCRYBE_RERANK_BLEND_TOP3");
    expect(wR + wX).toBeCloseTo(1.0, 4);
    expect(wR).toBeGreaterThan(wX); // retrieval weight heavier for top candidates
  });

  it("the default tail blend values '0.40,0.60' parse correctly", () => {
    const [wR, wX] = parseBlendWeights("0.40,0.60", "SCRYBE_RERANK_BLEND_TAIL");
    expect(wR + wX).toBeCloseTo(1.0, 4);
    expect(wX).toBeGreaterThan(wR); // rerank weight heavier for tail candidates
  });
});
