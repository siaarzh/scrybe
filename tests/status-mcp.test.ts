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
  delete process.env["SCRYBE_STATUS_MISSING_KEY"];
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

  it("retains assigned models when their credential env ref is unset", async () => {
    delete process.env["SCRYBE_STATUS_MISSING_KEY"];
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        code: {
          provider: "custom", model: "configured-code", dim: 1024,
          base_url: "http://127.0.0.1:11480/v1", credentials: "${SCRYBE_STATUS_MISSING_KEY}",
        },
        text: {
          provider: "custom", model: "configured-text", dim: 512,
          base_url: "http://127.0.0.1:11481/v1", credentials_from: "code",
        },
      },
      assignments: { code_preset: "code", text_preset: "text" },
    }));

    const { statusTool } = await import("../src/tools/status-mcp.js");
    const result = await statusTool.handler({});

    expect(result).toMatchObject({
      config_present: true,
      code_provider_type: "api", code_model: "configured-code",
      text_provider_type: "api", text_model: "configured-text",
      api_key_present: false,
      config_error: false, config_error_message: null,
      credential_error_message: expect.stringContaining("SCRYBE_STATUS_MISSING_KEY"),
    });
  });

  it("reports an unset text credential separately from the code credential", async () => {
    delete process.env["SCRYBE_STATUS_MISSING_KEY"];
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        code: {
          provider: "custom", model: "configured-code", dim: 1024,
          base_url: "http://127.0.0.1:11480/v1", credentials: "not-needed",
        },
        text: {
          provider: "custom", model: "configured-text", dim: 512,
          base_url: "http://127.0.0.1:11481/v1", credentials: "${SCRYBE_STATUS_MISSING_KEY}",
        },
      },
      assignments: { code_preset: "code", text_preset: "text" },
    }));

    const { statusTool } = await import("../src/tools/status-mcp.js");
    const result = await statusTool.handler({});

    expect(result).toMatchObject({
      code_model: "configured-code", text_model: "configured-text",
      api_key_present: true, config_error: false, config_error_message: null,
      credential_error_message: expect.stringContaining("SCRYBE_STATUS_MISSING_KEY"),
    });
  });

  it("distinguishes malformed config.json from an absent config file", async () => {
    const { statusTool } = await import("../src/tools/status-mcp.js");
    const absent = await statusTool.handler({});
    expect(absent).toMatchObject({ config_present: false, config_error: false });

    writeFileSync(join(dataDir, "config.json"), "{ bad json");
    const malformed = await statusTool.handler({});
    expect(malformed).toMatchObject({
      config_present: true, config_error: true,
      config_error_message: expect.stringContaining("not valid JSON"),
      credential_error_message: null,
    });
  });

  it("keeps missing preset references as configuration errors", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      schema_version: 1, embedding_presets: {},
      assignments: { code_preset: "missing", text_preset: "missing" },
    }));

    const { statusTool } = await import("../src/tools/status-mcp.js");
    const result = await statusTool.handler({});

    expect(result).toMatchObject({
      config_present: true, config_error: true,
      config_error_message: 'embedding preset "missing" not found in config',
      credential_error_message: null,
    });
  });
});
