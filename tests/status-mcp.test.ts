import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-status-mcp-test-"));
  process.env["SCRYBE_DATA_DIR"] = dataDir;
  process.env["SCRYBE_VLLM_API_KEY"] = "not-needed";
  vi.resetModules();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env["SCRYBE_DATA_DIR"];
  delete process.env["SCRYBE_VLLM_API_KEY"];
  vi.restoreAllMocks();
});

describe("MCP status", () => {
  it("reports the config.json assignments instead of legacy e5 defaults", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        "local-qwen": {
          provider: "custom",
          model: "/models/qwen3-embedding-0.6b-8bit",
          base_url: "http://127.0.0.1:11480/v1",
          dim: 1024,
          credentials: "${SCRYBE_VLLM_API_KEY}",
          encoding_format: "float",
        },
      },
      assignments: {
        code_preset: "local-qwen",
        text_preset: "local-qwen",
      },
    }));

    const { statusTool } = await import("../src/tools/status-mcp.js");
    const result = await statusTool.handler({});

    expect(result).toMatchObject({
      config_present: true,
      code_provider_type: "api",
      code_model: "/models/qwen3-embedding-0.6b-8bit",
      text_provider_type: "api",
      text_model: "/models/qwen3-embedding-0.6b-8bit",
      api_key_present: true,
      config_error: false,
      config_error_message: null,
    });
  });
});
