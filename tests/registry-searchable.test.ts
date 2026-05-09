/**
 * Unit tests for `isSearchable` (src/registry.ts).
 *
 * Regression coverage: `isSearchable` must return ok=true for local-provider
 * sources without requiring an API key, and must surface the correct env var
 * name for api-provider sources when the key is absent.
 *
 * Each test sets SCRYBE_DATA_DIR to a temp dir with the appropriate config.json,
 * so the preset resolver uses the test's intent rather than the user's real config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isSearchable } from "../src/registry.js";
import type { Source } from "../src/types.js";

function codeSource(overrides: Partial<Source> = {}): Source {
  return {
    source_id: "primary",
    source_config: { type: "code", root_path: "/tmp/x", languages: ["ts"] },
    table_name: "code_abc123",
    ...overrides,
  };
}

/** Write a config.json with the given preset/assignments to DATA_DIR. */
function writeConfig(dir: string, config: import("../src/config.js").ScrybeConfig) {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

const localConfig = (): import("../src/config.js").ScrybeConfig => ({
  schema_version: 1,
  embedding_presets: {
    "local-code": {
      provider: "local",
      model: "Xenova/multilingual-e5-small",
    },
    "local-text": {
      provider: "local",
      model: "Xenova/multilingual-e5-small",
    },
  },
  assignments: {
    code_preset: "local-code",
    text_preset: "local-text",
  },
});

const apiConfig = (keyEnvVar: string): import("../src/config.js").ScrybeConfig => ({
  schema_version: 1,
  embedding_presets: {
    "voyage-code": {
      provider: "voyage",
      model: "voyage-code-3",
      credentials: `\${${keyEnvVar}}`,
    },
    "local-text": {
      provider: "local",
      model: "Xenova/multilingual-e5-small",
    },
  },
  assignments: {
    code_preset: "voyage-code",
    text_preset: "local-text",
  },
});

describe("isSearchable", () => {
  let dir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-searchable-test-"));
    savedDataDir = process.env.SCRYBE_DATA_DIR;
    process.env.SCRYBE_DATA_DIR = dir;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.SCRYBE_DATA_DIR;
    else process.env.SCRYBE_DATA_DIR = savedDataDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("local-provider source is searchable without any API key in the environment", () => {
    writeConfig(dir, localConfig());
    const src = codeSource();
    const result = isSearchable(src);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("api-provider source without a key is NOT searchable and surfaces the env var name", () => {
    const envVarName = "SCRYBE_VOYAGE_KEY_SEARCHABLE_TEST";
    delete process.env[envVarName];
    writeConfig(dir, apiConfig(envVarName));
    const src = codeSource();
    const result = isSearchable(src);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(envVarName);
  });

  it("api-provider source with API key set is searchable", () => {
    const envVarName = "SCRYBE_VOYAGE_KEY_SEARCHABLE_TEST2";
    process.env[envVarName] = "test-voyage-key";
    try {
      writeConfig(dir, apiConfig(envVarName));
      const src = codeSource();
      const result = isSearchable(src);
      expect(result.ok).toBe(true);
    } finally {
      delete process.env[envVarName];
    }
  });

  it("never-indexed source is not searchable regardless of provider", () => {
    writeConfig(dir, localConfig());
    const src = codeSource({ table_name: undefined });
    const result = isSearchable(src);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Never indexed");
  });
});
