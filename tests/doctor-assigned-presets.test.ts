import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-doctor-test-"));
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = tmp;
  process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
  process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = "voyage-code-3";
  process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = "1024";
  process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test-key";
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env["SCRYBE_DATA_DIR"];
});

async function runFresh() {
  const { runDoctor } = await import("../src/onboarding/doctor.js");
  return runDoctor();
}

describe("runDoctor — assigned embedding preset", () => {
  function writeCustomPreset(credentials: string, encodingFormat?: "float") {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        configured: {
          provider: "custom", model: "assigned-qwen", dim: 2,
          base_url: "http://127.0.0.1:11480/v1", credentials,
          encoding_format: encodingFormat,
        },
      },
      assignments: { code_preset: "configured", text_preset: "configured" },
    }));
  }

  beforeEach(() => {
    vi.doUnmock("../src/onboarding/validate-provider.js");
    delete process.env["SCRYBE_DOCTOR_MISSING_KEY"];
  });

  afterEach(() => {
    delete process.env["SCRYBE_DOCTOR_MISSING_KEY"];
  });

  it("probes the assigned URL, model, credential and float encoding", async () => {
    writeCustomPreset("assigned-key", "float");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "assigned-qwen", data: [{ embedding: [0.25, 0.5] }],
    }), { status: 200 }));

    const report = await runFresh();

    expect(report.checks.find((c) => c.id === "provider.config")).toMatchObject({
      status: "ok", data: { baseUrl: "http://127.0.0.1:11480/v1", model: "assigned-qwen", dimensions: 2 },
    });
    expect(report.checks.find((c) => c.id === "provider.auth")).toMatchObject({ status: "ok", message: "OK (assigned-qwen)" });
    expect(report.checks.find((c) => c.id === "provider.dimensions_match")).toMatchObject({ status: "ok", message: "2d — matches config" });
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/embeddings"))!;
    expect(String(call[0])).toBe("http://127.0.0.1:11480/v1/embeddings");
    expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer assigned-key" });
    expect(JSON.parse(String(call[1]?.body))).toEqual({ model: "assigned-qwen", input: ["ping"], encoding_format: "float" });
  });

  it("validates the default SDK base64 encoding for an assigned preset", async () => {
    writeCustomPreset("assigned-key");
    const vector = Buffer.from(new Float32Array([0.25, 0.5]).buffer).toString("base64");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "assigned-qwen", data: [{ embedding: vector }],
    }), { status: 200 }));

    const report = await runFresh();

    expect(report.checks.find((c) => c.id === "provider.auth")).toMatchObject({ status: "ok", message: "OK (assigned-qwen)" });
    expect(report.checks.find((c) => c.id === "provider.dimensions_match")).toMatchObject({ status: "ok", message: "2d — matches config" });
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/embeddings"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ model: "assigned-qwen", input: ["ping"], encoding_format: "base64" });
  });

  it("preserves assigned metadata and skips auth when its env ref is unset", async () => {
    writeCustomPreset("${SCRYBE_DOCTOR_MISSING_KEY}", "float");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "legacy-voyage", data: [{ embedding: [0.25, 0.5] }],
    }), { status: 200 }));

    const report = await runFresh();

    expect(report.checks.find((c) => c.id === "provider.config")).toMatchObject({
      status: "ok", data: { model: "assigned-qwen", dimensions: 2 },
    });
    expect(report.checks.find((c) => c.id === "provider.key_present")).toMatchObject({
      status: "fail", message: expect.stringContaining("SCRYBE_DOCTOR_MISSING_KEY"),
    });
    expect(report.checks.find((c) => c.id === "provider.auth")).toMatchObject({ status: "skip", message: "Skipped: no API key" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/embeddings"))).toEqual([]);
  });

  it("fails malformed config instead of probing the legacy provider", async () => {
    writeFileSync(join(tmp, "config.json"), "{ bad json");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "legacy-voyage", data: [{ embedding: [0.25, 0.5] }],
    }), { status: 200 }));

    const report = await runFresh();

    expect(report.checks.find((c) => c.id === "provider.config")).toMatchObject({
      status: "fail", message: expect.stringContaining("not valid JSON"),
    });
    expect(report.checks.find((c) => c.id === "provider.auth")).toMatchObject({ status: "skip", message: "Skipped: provider config error" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/embeddings"))).toEqual([]);
  });
});
