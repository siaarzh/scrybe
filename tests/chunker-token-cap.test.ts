/**
 * Unit tests for the chunker token-cap enforcement.
 *
 * Plan 77 Slice 4 introduced a per-preset char cap (512 tokens ≈ 2048 chars for
 * the local e5-small preset). Slice 7 (2026-05-24) corrected *how* the cap is
 * enforced: over-budget windows are TRUNCATED at a line boundary to a single
 * chunk (keeping the head/signature), NOT sub-split into many overlapping
 * fragments. The old sub-split exploded the chunk count ~5x on long-line files
 * (see plan `## Smoke-test findings 2026-05-24`).
 *
 * These tests assert: (a) no emitted chunk exceeds the cap, (b) capping does
 * NOT multiply the chunk count vs. the uncapped baseline.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chunkLines } from "../src/chunker.js";
import { chunkFileContent } from "../src/plugins/code.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split a source string into a lines array the same way chunker.ts does.
 * Uses /^/m to preserve line endings in each element.
 */
function toLines(source: string): string[] {
  return source.split(/^/m);
}

const MAX_CHARS = 2048; // 512 tokens × 4 chars/token (e5-small budget)

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("chunkLines — maxChars enforcement", () => {
  it("passes through small chunks unchanged when maxChars is undefined", () => {
    const lines = ["line 1\n", "line 2\n", "line 3\n"];
    const chunks = chunkLines(lines, 0, undefined);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(typeof c.content).toBe("string");
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it("leaves chunks alone when they are already under the cap", () => {
    const lines = ["short line\n", "another short line\n"];
    const chunks = chunkLines(lines, 0, MAX_CHARS);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  it("truncates an oversized single window to ONE chunk within the cap", () => {
    // 30 lines × ~99 chars = ~2970 chars — fits in one 60-line window, over cap.
    const longLine = "x".repeat(98) + "\n"; // 99 chars
    const lines = Array.from({ length: 30 }, () => longLine);

    const chunks = chunkLines(lines, 0, MAX_CHARS);

    // Truncation floor: one window → exactly one chunk (no sub-split explosion).
    expect(chunks.length).toBe(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(MAX_CHARS);
    // Head is retained (starts at line 1).
    expect(chunks[0].start).toBe(1);
  });

  it("hard-caps a single line that exceeds maxChars (backstop, no infinite loop)", () => {
    const hugeLine = "y".repeat(3000) + "\n";
    const chunks = chunkLines([hugeLine], 0, MAX_CHARS);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it("emits one chunk per sliding window, each within the cap, for a 200-line file", () => {
    const header = "export function bigFunc() {\n";
    const body = Array.from(
      { length: 196 },
      (_, i) => `  const variable${i} = computeSomeValue(${i}, "argument-string-${i}");\n`
    );
    const footer = "}\n";
    const source = [header, ...body, footer].join("");
    const lines = toLines(source);

    const capped = chunkLines(lines, 0, MAX_CHARS);
    const uncapped = chunkLines(lines, 0, undefined);

    expect(capped.length).toBeGreaterThan(0);
    for (const c of capped) {
      expect(c.content.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    // The cap must NOT multiply the chunk count — one chunk per window either way.
    expect(capped.length).toBe(uncapped.length);
  });

  it("does NOT explode the chunk count: capped count == uncapped count for the giant fixture", () => {
    const fixturePath = join(
      __dirname,
      "scenarios/fixtures/local-embedder-recall/src/giant-function.ts"
    );
    const lines = toLines(readFileSync(fixturePath, "utf8"));

    const capped = chunkLines(lines, 0, MAX_CHARS);
    const uncapped = chunkLines(lines, 0, undefined);

    // No chunk over the cap.
    for (const c of capped) {
      expect(c.content.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    // Truncation keeps a 1:1 window→chunk mapping — the regression that Slice 7
    // fixes was a ~5x multiplication here.
    expect(capped.length).toBe(uncapped.length);
  });

  it("preserves monotonic, 1-based start/end line numbers under the cap", () => {
    const longLine = "z".repeat(90) + "\n"; // 91 chars
    const lines = Array.from({ length: 200 }, () => longLine);

    const chunks = chunkLines(lines, 0, MAX_CHARS);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].start).toBeGreaterThanOrEqual(1);
      expect(chunks[i].end).toBeGreaterThanOrEqual(chunks[i].start);
      if (i > 0) expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start);
    }
  });
});

describe("chunkFileContent — over-budget declaration stays one signature-anchored chunk", () => {
  it("a dense (≤60-line, >cap) function yields exactly one chunk whose head carries the signature", () => {
    // ~40 lines but well over 2048 chars via long literal lines.
    const sig = "export function processInventoryReconciliation(ctx, items, opts) {";
    const body = Array.from(
      { length: 38 },
      (_, i) =>
        `  const longDescriptiveResult${i} = reconcile(items[${i}], opts, "a-fairly-long-argument-literal-${i}-padding-padding");`
    );
    const source = [sig, ...body, "}", ""].join("\n");
    expect(source.length).toBeGreaterThan(MAX_CHARS); // precondition: over the cap

    const chunks = chunkFileContent("p", "s", "inventory.js", source, "javascript", MAX_CHARS);

    // One declaration → one chunk (no sub-split explosion), within the cap.
    expect(chunks.length).toBe(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(MAX_CHARS);
    // Head retained: signature present and symbol_name stamped.
    expect(chunks[0].content).toContain("processInventoryReconciliation");
    expect(chunks[0].symbol_name).toBe("processInventoryReconciliation");
  });
});

describe("chunkLines — behaviour without maxChars (regression guard)", () => {
  it("still produces correct start/end line numbers without maxChars", () => {
    const lines = ["line1\n", "line2\n", "line3\n", "line4\n", "line5\n"];
    const chunks = chunkLines(lines, 0);
    for (const c of chunks) {
      expect(c.start).toBeGreaterThanOrEqual(1);
      expect(c.end).toBeGreaterThanOrEqual(c.start);
    }
  });
});
