/**
 * Unit tests for src/util/transformers-loader.ts (Plan 66 Slice A).
 *
 * Verifies that getTransformers() sets env.cacheDir to the resolved model-cache
 * dir on the returned module, and that resolveModelCacheDir() honors the
 * SCRYBE_MODEL_CACHE_DIR override. Uses vi.mock to avoid loading the real WASM model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";

// Mock @xenova/transformers so we can inspect env.cacheDir without loading WASM
const mockEnv = { cacheDir: "" };
vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn(),
  env: mockEnv,
}));

// Mock config so we control dataDir
vi.mock("../src/config.js", () => ({
  config: {
    dataDir: "/fake/data/dir",
  },
}));

// Import after mocks are registered
import { getTransformers, resolveModelCacheDir } from "../src/util/transformers-loader.js";

beforeEach(() => {
  // Reset cacheDir + override before each test
  mockEnv.cacheDir = "";
  delete process.env.SCRYBE_MODEL_CACHE_DIR;
});

afterEach(() => {
  delete process.env.SCRYBE_MODEL_CACHE_DIR;
});

describe("getTransformers() — transformers-loader (Plan 66 Slice A)", () => {
  it("sets env.cacheDir to <dataDir>/models on the returned module", async () => {
    const mod = await getTransformers();
    const expected = join("/fake/data/dir", "models");
    expect(mod.env.cacheDir).toBe(expected);
  });

  it("returns the module (has pipeline export)", async () => {
    const mod = await getTransformers();
    expect(typeof mod.pipeline).toBe("function");
  });

  it("is idempotent — calling twice does not throw and cacheDir stays correct", async () => {
    await getTransformers();
    const mod = await getTransformers();
    const expected = join("/fake/data/dir", "models");
    expect(mod.env.cacheDir).toBe(expected);
  });

  it("honors SCRYBE_MODEL_CACHE_DIR override when set", async () => {
    process.env.SCRYBE_MODEL_CACHE_DIR = "/explicit/cache";
    const mod = await getTransformers();
    expect(mod.env.cacheDir).toBe("/explicit/cache");
  });
});

describe("resolveModelCacheDir()", () => {
  it("falls back to <dataDir>/models when override unset", () => {
    expect(resolveModelCacheDir()).toBe(join("/fake/data/dir", "models"));
  });

  it("returns the override when SCRYBE_MODEL_CACHE_DIR is set", () => {
    process.env.SCRYBE_MODEL_CACHE_DIR = "/somewhere/models";
    expect(resolveModelCacheDir()).toBe("/somewhere/models");
  });

  it("ignores a blank/whitespace override", () => {
    process.env.SCRYBE_MODEL_CACHE_DIR = "   ";
    expect(resolveModelCacheDir()).toBe(join("/fake/data/dir", "models"));
  });
});
