/**
 * Unit tests for input-length bounding in src/local-embedder.ts.
 *
 * Two mechanisms are covered:
 *
 * 1. `truncateForModel` — a character cap derived from the model's own token
 *    limit, so an unbounded text (knowledge/ticket sources bypass the code
 *    chunker's cap) can never hand the tokenizer an arbitrarily long string.
 *    The budget is spent on non-whitespace characters only, because runs of
 *    whitespace collapse to a single token and charging them would be the one
 *    way the cap could drop content the model would otherwise have seen.
 *
 * 2. `planMicroBatches` — the tokenizer pads every row in a forward pass up to
 *    the longest one, and attention cost is the padded rectangle, so one long
 *    text used to inflate the whole batch. Rows are grouped shortest-first into
 *    passes bounded by a token-slot budget.
 *
 * Kept separate from local-embedder-prefix.test.ts so the hoisted
 * vi.mock("@xenova/transformers") stays one-mock-per-file.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

/** Every batch of inputs handed to the mocked pipeline, in call order. */
const capturedInputs: string[][] = [];

vi.mock("@xenova/transformers", () => {
  const mockPipelineInstance = vi.fn().mockImplementation(async (inputs: string[]) => {
    capturedInputs.push([...inputs]);
    // toVec() only needs { data: Float32Array }; encode the input so tests can
    // assert results land back in the caller's original order.
    return inputs.map((t) => {
      const arr = new Float32Array(384);
      arr[0] = t.length;
      return { data: arr };
    });
  });
  const instance = Object.assign(mockPipelineInstance, { tokenizer: { model_max_length: 512 } });
  return {
    pipeline: vi.fn().mockResolvedValue(instance),
    env: { cacheDir: "" },
  };
});

import {
  embedLocalBatched,
  planMicroBatches,
  truncateForModel,
  resetLocalEmbedderCache,
} from "../src/local-embedder.js";

const OPTS = { modelId: "test-model", dimensions: 384 };

afterEach(() => {
  capturedInputs.length = 0;
  resetLocalEmbedderCache();
});

describe("truncateForModel", () => {
  it("returns short text untouched", () => {
    expect(truncateForModel("hello world", 100)).toBe("hello world");
  });

  it("returns text exactly at the cap untouched", () => {
    const text = "a".repeat(100);
    expect(truncateForModel(text, 100)).toBe(text);
  });

  it("cuts text past the non-whitespace budget", () => {
    const out = truncateForModel("a".repeat(500), 100);
    expect(out).toHaveLength(100);
  });

  it("does not charge whitespace against the budget", () => {
    // 20,000 spaces tokenize to a single token, so they must not consume budget
    // and must not cause the trailing content to be dropped.
    const text = "start" + " ".repeat(20_000) + "end";
    expect(truncateForModel(text, 100)).toBe(text);
  });

  it("counts tabs and newlines as whitespace too", () => {
    const text = "a\n\t\r".repeat(50); // 50 non-whitespace chars, 200 total
    expect(truncateForModel(text, 100)).toBe(text);
  });

  it("still bounds a pathological whitespace-only input", () => {
    // Nothing spends the budget, so the raw scan limit (8x) has to stop it.
    const out = truncateForModel(" ".repeat(100_000), 100);
    expect(out.length).toBeLessThanOrEqual(800);
  });

  it("cuts on a non-whitespace boundary, keeping the prefix intact", () => {
    const text = "abcdefghij".repeat(100);
    const out = truncateForModel(text, 25);
    expect(text.startsWith(out)).toBe(true);
    expect(out).toHaveLength(25);
  });
});

describe("planMicroBatches", () => {
  it("keeps every index exactly once", () => {
    const texts = Array.from({ length: 40 }, (_, i) => "x".repeat((i * 37) % 900));
    const flat = planMicroBatches(texts, 512, 4096).flat().sort((a, b) => a - b);
    expect(flat).toEqual(texts.map((_, i) => i));
  });

  it("holds each pass within the token budget", () => {
    const texts = Array.from({ length: 60 }, (_, i) => "x".repeat((i * 53) % 2000));
    const budget = 4096;
    for (const group of planMicroBatches(texts, 512, budget)) {
      const padded = Math.max(...group.map((k) => Math.min(512, texts[k]!.length + 2)));
      // A single row is always admitted even if it alone exceeds the budget.
      if (group.length > 1) expect(padded * group.length).toBeLessThanOrEqual(budget);
    }
  });

  it("puts one long text in its own pass instead of inflating the batch", () => {
    const texts = Array.from({ length: 64 }, () => "short");
    texts[7] = "x".repeat(120_000);
    const groups = planMicroBatches(texts, 512, 4096);
    const longGroup = groups.find((g) => g.includes(7))!;
    expect(longGroup).toEqual([7]);
  });

  it("packs uniformly short texts into a single pass", () => {
    const texts = Array.from({ length: 8 }, () => "short text");
    expect(planMicroBatches(texts, 512, 4096)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
  });

  it("preserves input order for equal-length texts (stable sort)", () => {
    const texts = ["aaa", "bbb", "ccc"];
    expect(planMicroBatches(texts, 512, 4096)).toEqual([[0, 1, 2]]);
  });

  it("admits a single over-budget row rather than looping forever", () => {
    const groups = planMicroBatches(["x".repeat(999_999)], 512, 8);
    expect(groups).toEqual([[0]]);
  });
});

describe("embedLocalBatched batching", () => {
  it("returns results in the caller's original order despite length-sorting", async () => {
    // Descending lengths — the planner reorders them, results must not follow.
    const texts = ["cccc", "bbb", "aa", "d"];
    const out = await embedLocalBatched(texts, OPTS, 64);
    expect(out.map((v) => v[0])).toEqual([4, 3, 2, 1]);
  });

  it("splits a batch containing one oversized text into several passes", async () => {
    const texts = Array.from({ length: 64 }, () => "short");
    texts[7] = "x".repeat(120_000);
    await embedLocalBatched(texts, OPTS, 64);
    expect(capturedInputs.length).toBeGreaterThan(1);
    // The oversized row must be alone, and capped well under its original length.
    const solo = capturedInputs.find((b) => b.length === 1)!;
    expect(solo[0]!.length).toBeLessThanOrEqual(512 * 64);
  });

  it("sends a uniform short batch as a single pass", async () => {
    const texts = Array.from({ length: 32 }, (_, i) => `text ${i}`);
    await embedLocalBatched(texts, OPTS, 64);
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toHaveLength(32);
  });

  it("honours an explicit opts.maxChars stricter than the model-derived cap", async () => {
    const texts = ["y".repeat(5000)];
    await embedLocalBatched(texts, { ...OPTS, maxChars: 100 }, 64);
    expect(capturedInputs[0]![0]).toHaveLength(100);
  });

  it("cuts an explicit opts.maxChars raw, exactly as before the token-budget change", async () => {
    // The configured cap (max_input_tokens * 4) keeps raw-slice semantics, so
    // whitespace is NOT exempt from it — texts already capped by config must
    // embed identically to how they did before.
    const text = "start" + " ".repeat(500) + "end";
    await embedLocalBatched([text], { ...OPTS, maxChars: 50 }, 64);
    expect(capturedInputs[0]![0]).toBe(text.slice(0, 50));
  });

  it("applies the model-derived backstop when no opts.maxChars is configured", async () => {
    // 512 * 64 = 32768 non-whitespace chars.
    await embedLocalBatched(["q".repeat(200_000)], OPTS, 64);
    expect(capturedInputs[0]![0]).toHaveLength(32_768);
  });

  it("applies the char cap before the passage prefix", async () => {
    const opts = { ...OPTS, maxChars: 10, prompt_template: { query: "q: ", passage: "p: " } };
    await embedLocalBatched(["z".repeat(500)], opts, 64);
    expect(capturedInputs[0]![0]).toBe("p: " + "z".repeat(10));
  });

  it("respects the caller's batchSize as an outer bound", async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
    await embedLocalBatched(texts, OPTS, 4);
    expect(capturedInputs.map((b) => b.length)).toEqual([4, 4, 2]);
  });

  it("returns an empty array for no input without loading a pipeline", async () => {
    expect(await embedLocalBatched([], OPTS)).toEqual([]);
    expect(capturedInputs).toHaveLength(0);
  });
});
