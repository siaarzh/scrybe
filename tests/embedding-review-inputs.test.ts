import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/onboarding/validate-provider.js", () => ({
  validateProvider: vi.fn(async () => ({ ok: true, dimensions: 1024, encodingFormat: "float" })),
  validateLocal: vi.fn(),
}));

describe("embedding configuration input validation", () => {
  it.each(["credentials", "credentials_from"])("keeps malformed %s as a config error", async (field) => {
    const { readScrybeConfig, config } = await import("../src/config.js");
    writeFileSync(join(config.dataDir, "config.json"), JSON.stringify({ schema_version: 1,
      embedding_presets: { local: { provider: "local", model: "Xenova/multilingual-e5-small", [field]: 42 } },
      assignments: { code_preset: "local", text_preset: "local" },
    }));
    expect(() => readScrybeConfig()).toThrow(`${field} must be a string`);
  });

  it("rejects an explicit base64 setting that cannot force SDK decoding", async () => {
    const { readScrybeConfig, config } = await import("../src/config.js");
    writeFileSync(join(config.dataDir, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        custom: { provider: "custom", model: "qwen", base_url: "http://localhost/v1", dim: 1024, encoding_format: "base64" },
      },
      assignments: { code_preset: "custom", text_preset: "custom" },
    }));
    expect(() => readScrybeConfig()).toThrow('encoding_format must be "float"');
  });

  it.each([
    { code_provider: "local", code_encoding_format: "float" as const },
    { code_provider: "local", text_provider: "local", text_encoding_format: "float" as const },
  ])("rejects encoding for a non-custom init provider %j", async (input) => {
    const { initTool } = await import("../src/tools/init-mcp.js");
    const result = await initTool.handler(input);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("only valid") });
  });

  it("infers dimensions and persists float encoding during custom init", async () => {
    const { initTool } = await import("../src/tools/init-mcp.js");
    const result = await initTool.handler({
      code_provider: "custom", code_model: "qwen", code_base_url: "http://localhost/v1", code_api_key: "not-needed",
      text_provider: "local",
    });
    expect(result).toMatchObject({ ok: true, status: "configured" });
    const { readScrybeConfig } = await import("../src/config.js");
    const cfg = readScrybeConfig()!;
    expect(cfg.embedding_presets[cfg.assignments.code_preset]).toMatchObject({ dim: 1024, encoding_format: "float" });
  });

  it("rejects a supplied dimension that disagrees with the init probe", async () => {
    const { initTool } = await import("../src/tools/init-mcp.js");
    const result = await initTool.handler({
      code_provider: "custom", code_model: "qwen", code_base_url: "http://localhost/v1", code_dim: 512, code_api_key: "not-needed",
      text_provider: "local",
    });
    expect(result).toMatchObject({ ok: false, status: "validation_failed" });
    const { readScrybeConfig } = await import("../src/config.js");
    expect(readScrybeConfig()).toBeNull();
  });
});
