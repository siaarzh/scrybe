import { describe, it, expect } from "vitest";
import { formatProgressLine, updateThroughput, type ProgressState } from "../src/onboarding/progress-renderer.js";

function state(overrides: Partial<ProgressState> = {}): ProgressState {
  return {
    projectIdx: 1,
    projectTotal: 1,
    projectId: "myrepo",
    filesEmbedded: 0,
    filesTotal: null,
    bytesEmbedded: 0,
    bytesTotal: null,
    chunksIndexed: 0,
    throughputBps: null,
    ...overrides,
  };
}

describe("formatProgressLine", () => {
  it("shows chunk count when filesTotal is null", () => {
    const line = formatProgressLine(state({ chunksIndexed: 42 }));
    expect(line).toContain("42 chunks");
    expect(line).toContain("estimating...");
  });

  it("shows percentage based on file count", () => {
    const line = formatProgressLine(
      state({ filesTotal: 10, filesEmbedded: 5, bytesTotal: 1000, bytesEmbedded: 500, throughputBps: 100 })
    );
    expect(line).toContain("50%");
  });

  it("clamps percentage at 100 — no overshoot from chunk overlap", () => {
    const line = formatProgressLine(
      state({ filesTotal: 10, filesEmbedded: 12, bytesTotal: 1000, bytesEmbedded: 1200, throughputBps: 100 })
    );
    expect(line).toContain("100%");
    expect(line).not.toContain("110%");
    expect(line).not.toContain("120%");
  });

  it("shows estimating when throughputBps is null even with bytesTotal", () => {
    const line = formatProgressLine(state({ filesTotal: 10, filesEmbedded: 2, bytesTotal: 1000, bytesEmbedded: 200 }));
    expect(line).toContain("estimating...");
  });

  it("shows seconds ETA for short remaining time", () => {
    const line = formatProgressLine(
      state({ filesTotal: 10, filesEmbedded: 9, bytesTotal: 1000, bytesEmbedded: 900, throughputBps: 100 })
    );
    // remaining = 100 bytes / 100 bps = 1s
    expect(line).toContain("~1s remaining");
  });

  it("shows minutes ETA for longer remaining time", () => {
    const line = formatProgressLine(
      state({ filesTotal: 10, filesEmbedded: 0, bytesTotal: 100_000, bytesEmbedded: 0, throughputBps: 1000 })
    );
    // remaining = 100000 / 1000 = 100s → 1m 40s
    expect(line).toContain("~1m");
  });

  it("includes project counter", () => {
    const line = formatProgressLine(state({ projectIdx: 2, projectTotal: 3, projectId: "repo" }));
    expect(line).toContain("[2/3]");
    expect(line).toContain("repo");
  });

  it("truncates long lines at 80 chars", () => {
    const line = formatProgressLine(
      state({ projectId: "a-very-long-project-id-that-will-exceed-the-limit-easily" })
    );
    expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe("updateThroughput", () => {
  it("returns sample directly on first call (prev=null)", () => {
    expect(updateThroughput(null, 1000, 500)).toBe(2000);
  });

  it("applies EMA on subsequent calls", () => {
    const first = updateThroughput(null, 1000, 500); // 2000 bps
    const second = updateThroughput(first, 1000, 1000); // sample=1000, ema = 0.3*1000 + 0.7*2000 = 1700
    expect(second).toBeCloseTo(1700);
  });

  it("returns 0 for zero batchMs", () => {
    expect(updateThroughput(null, 1000, 0)).toBe(0);
  });
});
