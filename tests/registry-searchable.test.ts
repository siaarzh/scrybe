/**
 * Unit tests for `isSearchable` (src/registry.ts).
 *
 * Regression coverage: `isSearchable` must return ok=true for local-provider
 * sources without requiring an API key, and must surface the correct env var
 * name for api-provider sources when the key is absent.
 *
 * Construct sources in-memory and exercise `isSearchable` directly. No filesystem,
 * no embedder load, no Lance.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { isSearchable } from "../src/registry.js";
import type { Source } from "../src/types.js";

function localCodeSource(overrides: Partial<Source> = {}): Source {
  return {
    source_id: "primary",
    source_config: { type: "code", root_path: "/tmp/x", languages: ["ts"] },
    table_name: "code_abc123",
    embedding: {
      base_url: "",
      model: "Xenova/multilingual-e5-small",
      dimensions: 384,
      api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
      provider_type: "local",
    },
    ...overrides,
  };
}

function apiCodeSource(overrides: Partial<Source> = {}): Source {
  return {
    source_id: "primary",
    source_config: { type: "code", root_path: "/tmp/x", languages: ["ts"] },
    table_name: "code_def456",
    embedding: {
      base_url: "https://api.voyageai.com/v1",
      model: "voyage-code-3",
      dimensions: 1024,
      api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
      provider_type: "api",
    },
    ...overrides,
  };
}

describe("isSearchable", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    // Snapshot then clear env so each test starts from a known baseline.
    savedKey = process.env.SCRYBE_CODE_EMBEDDING_API_KEY;
    delete process.env.SCRYBE_CODE_EMBEDDING_API_KEY;
  });

  function restoreEnv(): void {
    if (savedKey === undefined) delete process.env.SCRYBE_CODE_EMBEDDING_API_KEY;
    else process.env.SCRYBE_CODE_EMBEDDING_API_KEY = savedKey;
  }

  it("local-provider source is searchable without any API key in the environment", () => {
    const src = localCodeSource();
    const result = isSearchable(src);
    restoreEnv();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("api-provider source without a key is NOT searchable and surfaces the env var name", () => {
    const src = apiCodeSource();
    const result = isSearchable(src);
    restoreEnv();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("SCRYBE_CODE_EMBEDDING_API_KEY");
  });

  it("api-provider source with SCRYBE_CODE_EMBEDDING_API_KEY set is searchable", () => {
    process.env.SCRYBE_CODE_EMBEDDING_API_KEY = "test-key";
    const src = apiCodeSource();
    const result = isSearchable(src);
    restoreEnv();
    expect(result.ok).toBe(true);
  });

  it("never-indexed source is not searchable regardless of provider", () => {
    const src = localCodeSource({ table_name: undefined });
    const result = isSearchable(src);
    restoreEnv();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Never indexed");
  });
});
