/**
 * Unit tests for prompt_template prefix wrapping in src/local-embedder.ts (Plan 77 / Plan 70).
 *
 * These tests verify that embedLocalQuery prepends prompt_template.query and
 * embedLocalBatched prepends prompt_template.passage before passing inputs to
 * the @xenova/transformers pipeline. Kept in a separate file so the
 * vi.mock("@xenova/transformers") call is hoisted before the module is imported.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

// Captured inputs from the mocked pipeline. Filled per test.
const capturedInputs: string[][] = [];

// Vitest hoists this mock — it runs before any import of @xenova/transformers.
vi.mock("@xenova/transformers", () => {
  const mockPipelineInstance = vi.fn().mockImplementation(async (inputs: string[]) => {
    capturedInputs.push([...inputs]);
    // Return minimal output shape expected by toVec(): array of { data: Float32Array }
    return inputs.map(() => ({ data: new Float32Array(384).fill(0) }));
  });
  return {
    pipeline: vi.fn().mockResolvedValue(mockPipelineInstance),
    // env.cacheDir is set by getTransformers() (Plan 66); include the env stub
    // so the loader doesn't throw "No 'env' export is defined on the mock".
    env: { cacheDir: "" },
  };
});

// Import AFTER mock registration
import {
  embedLocalQuery,
  embedLocalBatched,
  resetLocalEmbedderCache,
} from "../src/local-embedder.js";

const OPTS = { modelId: "test-model", dimensions: 384 };

afterEach(() => {
  capturedInputs.length = 0;
  resetLocalEmbedderCache();
});

describe("prompt_template prefix wrapping (Plan 77 / Plan 70)", () => {
  it("embedLocalQuery prepends prompt_template.query before passing to pipeline", async () => {
    const opts = { ...OPTS, prompt_template: { query: "query: ", passage: "passage: " } };
    await embedLocalQuery("test", opts);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual(["query: test"]);
  });

  it("embedLocalBatched prepends prompt_template.passage to each text", async () => {
    const opts = { ...OPTS, prompt_template: { query: "query: ", passage: "passage: " } };
    await embedLocalBatched(["hello", "world"], opts);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual(["passage: hello", "passage: world"]);
  });

  it("embedLocalQuery passes text unchanged when no prompt_template is set", async () => {
    await embedLocalQuery("test", OPTS);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual(["test"]);
  });

  it("embedLocalBatched passes texts unchanged when no prompt_template is set", async () => {
    await embedLocalBatched(["foo", "bar"], OPTS);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual(["foo", "bar"]);
  });

  it("empty passage prefix string does not modify texts", async () => {
    const opts = { ...OPTS, prompt_template: { query: "", passage: "" } };
    await embedLocalBatched(["hello"], opts);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual(["hello"]);
  });

  it("empty query prefix string does not modify query text", async () => {
    const opts = { ...OPTS, prompt_template: { query: "", passage: "passage: " } };
    await embedLocalQuery("test", opts);

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]).toEqual(["test"]);
  });
});
