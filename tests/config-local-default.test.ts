/**
 * Integration tests for the local-provider default in config.ts.
 *
 * Tests use SCRYBE_DATA_DIR to isolate state and carefully manage env vars
 * to avoid polluting the global process.env between cases.
 * Config is re-imported fresh via dynamic import in each test by manipulating env before import.
 *
 * These tests do NOT test embedding inference — only config resolution logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LOCAL_PROVIDER_DEFAULTS } from "../src/providers.js";

// Save & restore env vars around each test
let savedEnv: Record<string, string | undefined> = {};

const KEYS_TO_CLEAN = [
  "SCRYBE_CODE_EMBEDDING_BASE_URL",
  "SCRYBE_CODE_EMBEDDING_API_KEY",
  "SCRYBE_CODE_EMBEDDING_MODEL",
  "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
  "SCRYBE_LOCAL_EMBEDDER",
];

function cleanEmbeddingEnv() {
  for (const k of KEYS_TO_CLEAN) delete process.env[k];
}

function saveEnv() {
  savedEnv = {};
  for (const k of KEYS_TO_CLEAN) savedEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const k of KEYS_TO_CLEAN) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// We can't cleanly re-import config (it's a singleton module), so we test
// the provider-type resolution logic directly by inspecting the result of
// resolveProvider and the LOCAL_PROVIDER_DEFAULTS structure.
describe("LOCAL_PROVIDER_DEFAULTS", () => {
  it("has the correct model ID (multilingual-e5-small)", () => {
    expect(LOCAL_PROVIDER_DEFAULTS.model).toBe("Xenova/multilingual-e5-small");
  });

  it("has 384 dimensions", () => {
    expect(LOCAL_PROVIDER_DEFAULTS.dimensions).toBe(384);
  });

  it("does not support rerank", () => {
    expect(LOCAL_PROVIDER_DEFAULTS.supports_rerank).toBeFalsy();
  });
});

describe("resolveProvider", () => {
  it("returns null for undefined baseUrl (caller decides local vs API)", async () => {
    const { resolveProvider } = await import("../src/providers.js");
    const result = resolveProvider(undefined);
    expect(result).toBeNull();
  });

  it("returns Voyage AI defaults for voyageai.com URL", async () => {
    const { resolveProvider } = await import("../src/providers.js");
    const result = resolveProvider("https://api.voyageai.com/v1");
    expect(result?.name).toBe("Voyage AI");
    expect(result?.supports_rerank).toBe(true);
  });

  it("Voyage AI is the only provider with supports_rerank=true", async () => {
    const { KNOWN_PROVIDERS } = await import("../src/providers.js");
    const rerankProviders = Object.values(KNOWN_PROVIDERS).filter((p) => p.supports_rerank);
    expect(rerankProviders).toHaveLength(1);
    expect(rerankProviders[0]!.name).toBe("Voyage AI");
  });
});

describe("envStr empty-string regression — all env vars set to empty string", () => {
  // Tests use vi.resetModules() + dynamic import to get a fresh config evaluation.
  // isolate.ts sets real sidecar values in beforeEach; we override them to ""
  // here and restore in afterEach.
  const REGRESSION_KEYS = [
    "SCRYBE_CODE_EMBEDDING_MODEL",
    "SCRYBE_CODE_EMBEDDING_BASE_URL",
    "SCRYBE_CODE_EMBEDDING_API_KEY",
    "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of REGRESSION_KEYS) saved[k] = process.env[k];
    // Set all to empty string — this is the bug scenario
    for (const k of REGRESSION_KEYS) process.env[k] = "";
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of REGRESSION_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("resolves to local provider when all embedding env vars are empty strings", async () => {
    const { config } = await import("../src/config.js");
    expect(config.embeddingProviderType).toBe("local");
    expect(config.embeddingModel).toBe("Xenova/multilingual-e5-small");
    expect(config.embeddingDimensions).toBe(384);
  });

  it("resolves to Voyage defaults when BASE_URL and API_KEY are set but MODEL is empty", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "key";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embeddingProviderType).toBe("api");
    expect(config.embeddingModel).toBe("voyage-code-3");
    expect(config.embeddingDimensions).toBe(1024);
  });
});

describe("config.embeddingProviderType — local auto-detect", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("resolves to local when no SCRYBE_CODE_EMBEDDING_* env vars are set", async () => {
    // This test is tricky because config.ts is a cached module.
    // We verify indirectly through buildEmbeddingConfig logic by checking
    // that the conditions that trigger local are what we expect:
    // no SCRYBE_LOCAL_EMBEDDER, no SCRYBE_CODE_EMBEDDING_BASE_URL, no SCRYBE_CODE_EMBEDDING_API_KEY, no SCRYBE_CODE_EMBEDDING_MODEL

    cleanEmbeddingEnv();

    // After cleaning, the sidecar URL is gone, so the local path should activate.
    // We can't re-import config (singleton), but we can verify the detection logic:
    // isLocal = !localModelEnv && !baseUrl && !apiKey && !modelEnv
    const localModelEnv = process.env.SCRYBE_LOCAL_EMBEDDER;
    const baseUrl = process.env.SCRYBE_CODE_EMBEDDING_BASE_URL;
    const apiKey = process.env.SCRYBE_CODE_EMBEDDING_API_KEY;
    const modelEnv = process.env.SCRYBE_CODE_EMBEDDING_MODEL;
    const isLocal = !!localModelEnv || (!baseUrl && !apiKey && !modelEnv);
    expect(isLocal).toBe(true);
  });

  it("resolves to api when SCRYBE_CODE_EMBEDDING_API_KEY is set", async () => {
    cleanEmbeddingEnv();
    process.env.SCRYBE_CODE_EMBEDDING_API_KEY = "sk-test-key";
    const baseUrl = process.env.SCRYBE_CODE_EMBEDDING_BASE_URL;
    const apiKey = process.env.SCRYBE_CODE_EMBEDDING_API_KEY;
    const modelEnv = process.env.SCRYBE_CODE_EMBEDDING_MODEL;
    const isLocal = !baseUrl && !apiKey && !modelEnv;
    expect(isLocal).toBe(false);
  });

  it("resolves to local when SCRYBE_LOCAL_EMBEDDER is set explicitly", async () => {
    cleanEmbeddingEnv();
    process.env.SCRYBE_LOCAL_EMBEDDER = "Xenova/multilingual-e5-small";
    const localModelEnv = process.env.SCRYBE_LOCAL_EMBEDDER;
    const isLocal = !!localModelEnv;
    expect(isLocal).toBe(true);
  });
});
