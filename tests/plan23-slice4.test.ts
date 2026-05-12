/**
 * Plan 23 Slice 4 Tests: MCP tools for embedding preset management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addEmbeddingPresetTool,
  assignPresetTool,
  type AddEmbeddingPresetOutput,
  type AssignPresetOutput,
} from "../src/tools/model-mcp.js";
import type { ScrybeConfig } from "../src/config.js";

// ─── Test fixtures ────────────────────────────────────────────────────────

function tmpDir(): string {
  return join(tmpdir(), `scrybe-test-${Date.now()}-${Math.random()}`);
}

function setupTestEnv(tmpPath: string): void {
  process.env.SCRYBE_DATA_DIR = tmpPath;
  fs.mkdirSync(tmpPath, { recursive: true });
}

function teardownTestEnv(tmpPath: string): void {
  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }
  delete process.env.SCRYBE_DATA_DIR;
}

function writeTestConfig(tmpPath: string, cfg: ScrybeConfig): void {
  const path = join(tmpPath, "config.json");
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function readTestConfig(tmpPath: string): ScrybeConfig | null {
  const path = join(tmpPath, "config.json");
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8")) as ScrybeConfig;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Plan 23 Slice 4: MCP tools", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tmpDir();
    setupTestEnv(testDir);
  });

  afterEach(() => {
    teardownTestEnv(testDir);
  });

  describe("add_embedding_preset", () => {
    it("should round-trip a catalog preset to config.json", async () => {
      // Arrange: no config yet
      let cfg = readTestConfig(testDir);
      expect(cfg).toBeNull();

      // Act: add a Voyage preset
      const result = await addEmbeddingPresetTool.handler({
        name: "voyage-code",
        provider: "voyage",
        model: "voyage-code-3",
        credentials: "${SCRYBE_VOYAGE_API_KEY}",
      }) as AddEmbeddingPresetOutput;

      // Assert: tool returns success
      expect(result.ok).toBe(true);
      expect(result.preset_name).toBe("voyage-code");
      expect(result.error).toBeUndefined();

      // Assert: config.json was written
      cfg = readTestConfig(testDir);
      expect(cfg).not.toBeNull();
      expect(cfg!.embedding_presets["voyage-code"]).toBeDefined();
      expect(cfg!.embedding_presets["voyage-code"].provider).toBe("voyage");
      expect(cfg!.embedding_presets["voyage-code"].model).toBe("voyage-code-3");
      expect(cfg!.embedding_presets["voyage-code"].credentials).toBe(
        "${SCRYBE_VOYAGE_API_KEY}"
      );
    });

    it("should reject unknown provider", async () => {
      const result = await addEmbeddingPresetTool.handler({
        name: "bad-preset",
        provider: "unknown-provider",
        model: "some-model",
      }) as AddEmbeddingPresetOutput;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown provider");
    });

    it("should reject model not in catalog", async () => {
      const result = await addEmbeddingPresetTool.handler({
        name: "bad-model",
        provider: "voyage",
        model: "nonexistent-model",
      }) as AddEmbeddingPresetOutput;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should accept custom provider with base_url and dim", async () => {
      const result = await addEmbeddingPresetTool.handler({
        name: "custom-bert",
        provider: "custom",
        model: "togethercomputer/m2-bert-80M-8k-retrieval",
        base_url: "https://api.together.xyz/v1",
        dim: 768,
        credentials: "${SCRYBE_TOGETHER_API_KEY}",
      }) as AddEmbeddingPresetOutput;

      expect(result.ok).toBe(true);
      expect(result.preset_name).toBe("custom-bert");

      const cfg = readTestConfig(testDir);
      const preset = cfg!.embedding_presets["custom-bert"];
      expect(preset.provider).toBe("custom");
      expect(preset.base_url).toBe("https://api.together.xyz/v1");
      expect(preset.dim).toBe(768);
    });

    it("should reject custom provider without base_url", async () => {
      const result = await addEmbeddingPresetTool.handler({
        name: "custom-bad",
        provider: "custom",
        model: "some-model",
        dim: 768,
      }) as AddEmbeddingPresetOutput;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("--base-url");
    });

    it("should reject custom provider without dim", async () => {
      const result = await addEmbeddingPresetTool.handler({
        name: "custom-bad",
        provider: "custom",
        model: "some-model",
        base_url: "https://api.together.xyz/v1",
      }) as AddEmbeddingPresetOutput;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("--dim");
    });
  });

  describe("assign_preset", () => {
    it("should round-trip a code preset assignment", async () => {
      // Arrange: create a config with a local code preset (no env var needed)
      const cfg: ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {
          "local-code": {
            provider: "local",
            model: "Xenova/multilingual-e5-small",
          },
        },
        assignments: {
          code_preset: "",
          text_preset: "",
        },
      };
      writeTestConfig(testDir, cfg);

      // Act: assign the preset to code slot
      const result = await assignPresetTool.handler({
        slot: "code",
        preset_name: "local-code",
      }) as AssignPresetOutput;

      // Assert: assignment returns success
      if (!result.ok) {
        console.error("Assignment failed:", result.error);
      }
      expect(result.ok).toBe(true);
      expect(result.requires_reindex).toBe(false); // No previous assignment

      // Assert: config.json was updated
      const updated = readTestConfig(testDir);
      expect(updated!.assignments.code_preset).toBe("local-code");
    });

    it("should detect requires_reindex when current triple differs from new triple", async () => {
      // Arrange: config with two local presets with different models
      const cfg: ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {
          "local-code-v1": {
            provider: "local",
            model: "Xenova/multilingual-e5-small",
          },
          "local-code-v2": {
            provider: "local",
            model: "Xenova/all-MiniLM-L6-v2",
          },
        },
        assignments: {
          code_preset: "local-code-v1",
          text_preset: "",
        },
      };
      writeTestConfig(testDir, cfg);

      // Act: assign a different local model
      const result = await assignPresetTool.handler({
        slot: "code",
        preset_name: "local-code-v2",
      }) as AssignPresetOutput;

      // Assert: should succeed and require reindex (different triples due to different models)
      expect(result.ok).toBe(true);
      expect(result.requires_reindex).toBe(true);
    });

    it("should reject cross-profile assignment (text model to code slot)", async () => {
      // Arrange: config with a text-only model
      const cfg: ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {
          "openai-text": {
            provider: "openai",
            model: "text-embedding-3-small",
            credentials: "${SCRYBE_OPENAI_API_KEY}",
          },
        },
        assignments: {
          code_preset: "",
          text_preset: "",
        },
      };
      writeTestConfig(testDir, cfg);

      // Act: try to assign text model to code slot
      const result = await assignPresetTool.handler({
        slot: "code",
        preset_name: "openai-text",
      }) as AssignPresetOutput;

      // Assert: rejection due to profile mismatch
      expect(result.ok).toBe(false);
      expect(result.error).toContain("profile");
    });

    it("should allow preset rename with identical triple (no reindex)", async () => {
      // Arrange: two presets with identical (model, dim, provider) triples (local provider)
      const cfg: ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {
          "local-code-alias1": {
            provider: "local",
            model: "Xenova/multilingual-e5-small",
          },
          "local-code-alias2": {
            provider: "local",
            model: "Xenova/multilingual-e5-small",
          },
        },
        assignments: {
          code_preset: "local-code-alias1",
          text_preset: "",
        },
      };
      writeTestConfig(testDir, cfg);

      // Act: switch to alias2 (same triple)
      const result = await assignPresetTool.handler({
        slot: "code",
        preset_name: "local-code-alias2",
      }) as AssignPresetOutput;

      // Assert: success with requires_reindex = false (same triple)
      expect(result.ok).toBe(true);
      expect(result.requires_reindex).toBe(false);

      const updated = readTestConfig(testDir);
      expect(updated!.assignments.code_preset).toBe("local-code-alias2");
    });

    it("should reject nonexistent preset", async () => {
      const cfg: ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {},
        assignments: {
          code_preset: "",
          text_preset: "",
        },
      };
      writeTestConfig(testDir, cfg);

      const result = await assignPresetTool.handler({
        slot: "code",
        preset_name: "nonexistent",
      }) as AssignPresetOutput;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should allow rerank slot to be cleared with 'none'", async () => {
      const cfg: ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {},
        reranker_presets: {
          "voyage-rerank": {
            provider: "voyage",
            model: "rerank-2.5",
            credentials_from: "voyage-code",
          },
        },
        assignments: {
          code_preset: "",
          text_preset: "",
          rerank_preset: "voyage-rerank",
        },
      };
      writeTestConfig(testDir, cfg);

      const result = await assignPresetTool.handler({
        slot: "rerank",
        preset_name: "none",
      }) as AssignPresetOutput;

      expect(result.ok).toBe(true);

      const updated = readTestConfig(testDir);
      expect(updated!.assignments.rerank_preset).toBeUndefined();
    });
  });

  describe("tool annotations", () => {
    it("add_embedding_preset should have idempotent: false and openWorld: false", () => {
      const annotations = addEmbeddingPresetTool.spec.annotations;
      expect(annotations?.idempotentHint).toBe(false);
      expect(annotations?.openWorldHint).toBe(false);
    });

    it("assign_preset should have idempotent: false and openWorld: false", () => {
      const annotations = assignPresetTool.spec.annotations;
      expect(annotations?.idempotentHint).toBe(false);
      expect(annotations?.openWorldHint).toBe(false);
    });
  });

  describe("tool registration", () => {
    it("add_embedding_preset should be listed by name", () => {
      expect(addEmbeddingPresetTool.spec.name).toBe("add_embedding_preset");
    });

    it("assign_preset should be listed by name", () => {
      expect(assignPresetTool.spec.name).toBe("assign_preset");
    });

    it("both tools should have proper input schemas", () => {
      const addSchema = addEmbeddingPresetTool.spec.inputSchema;
      expect(addSchema.type).toBe("object");
      expect(addSchema.properties).toBeDefined();
      expect(addSchema.required).toContain("name");
      expect(addSchema.required).toContain("provider");
      expect(addSchema.required).toContain("model");

      const assignSchema = assignPresetTool.spec.inputSchema;
      expect(assignSchema.type).toBe("object");
      expect(assignSchema.properties).toBeDefined();
      expect(assignSchema.required).toContain("slot");
      expect(assignSchema.required).toContain("preset_name");
    });
  });
});
