/**
 * Unit tests for `isSearchable` (src/registry.ts).
 *
 * Regression coverage for the v0.25.2 [Unreleased] bug:
 *   `scrybe projects` falsely flagged local-embedder sources as
 *   "Not searchable — missing config: Requires env var EMBEDDING_API_KEY"
 * because `isSearchable` always demanded an API key, ignoring `provider_type === "local"`.
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
      api_key_env: "EMBEDDING_API_KEY",
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
      api_key_env: "EMBEDDING_API_KEY",
      provider_type: "api",
    },
    ...overrides,
  };
}

describe("isSearchable", () => {
  let savedKeys: { embedding?: string | undefined; openai?: string | undefined };

  beforeEach(() => {
    // Snapshot then clear env so each test starts from a known baseline.
    savedKeys = {
      embedding: process.env.EMBEDDING_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  // Restore after each test
  function restoreEnv(): void {
    if (savedKeys.embedding === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = savedKeys.embedding;
    if (savedKeys.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKeys.openai;
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
    expect(result.reason).toContain("EMBEDDING_API_KEY");
  });

  it("api-provider source with EMBEDDING_API_KEY set is searchable", () => {
    process.env.EMBEDDING_API_KEY = "test-key";
    const src = apiCodeSource();
    const result = isSearchable(src);
    restoreEnv();
    expect(result.ok).toBe(true);
  });

  it("api-provider source with only OPENAI_API_KEY set is searchable (legacy fallback)", () => {
    process.env.OPENAI_API_KEY = "test-key";
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
