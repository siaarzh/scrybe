import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We set SCRYBE_DATA_DIR before importing runDoctor so config.ts picks it up.
// Using vi.resetModules() between tests so fresh config is loaded.

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-doctor-test-"));
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = tmp;
  process.env["EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
  process.env["EMBEDDING_MODEL"] = "voyage-code-3";
  process.env["EMBEDDING_DIMENSIONS"] = "1024";
  process.env["EMBEDDING_API_KEY"] = "test-key";
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

describe("runDoctor — env checks", () => {
  it("env.data_dir fails when DATA_DIR missing", async () => {
    rmSync(tmp, { recursive: true, force: true });
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "env.data_dir")!;
    expect(check.status).toBe("fail");
  });

  it("env.data_dir ok when directory writable", async () => {
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "env.data_dir")!;
    expect(check.status).toBe("ok");
  });

  it("env.node_version ok for current Node", async () => {
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "env.node_version")!;
    expect(check.status).toBe("ok");
  });

  it("env.scrybe_version ok", async () => {
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "env.scrybe_version")!;
    expect(check.status).toBe("ok");
  });
});

describe("runDoctor — provider checks", () => {
  it("skips auth checks when API key absent", async () => {
    // Set to "" so config.ts's .env loader won't refill from disk (it only sets absent keys)
    process.env["EMBEDDING_API_KEY"] = "";
    const savedOai = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "";
    const report = await runFresh();
    const key = report.checks.find((c) => c.id === "provider.key_present")!;
    expect(key.status).toBe("fail");
    const auth = report.checks.find((c) => c.id === "provider.auth")!;
    expect(auth.status).toBe("skip");
    if (savedOai !== undefined) process.env["OPENAI_API_KEY"] = savedOai;
    else delete process.env["OPENAI_API_KEY"];
  });

  it("provider.auth fail when fetch returns 401", async () => {
    // Mock validate-provider to return auth failure
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: false, errorType: "auth", message: "Invalid API key" }),
    }));
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();
    const check = report.checks.find((c) => c.id === "provider.auth")!;
    expect(check.status).toBe("fail");
    expect(check.message).toContain("Invalid API key");
  });

  it("provider.dimensions_match fail when dims mismatch", async () => {
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 512, model: "voyage-code-3" }),
    }));
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();
    const check = report.checks.find((c) => c.id === "provider.dimensions_match")!;
    expect(check.status).toBe("fail");
    expect(check.message).toContain("512");
  });
});

describe("runDoctor — data integrity", () => {
  it("warns on missing schema.json", async () => {
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "data.schema_version")!;
    expect(check.status).toBe("warn");
  });

  it("ok on current schema version", async () => {
    writeFileSync(join(tmp, "schema.json"), JSON.stringify({ version: 2 }));
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "data.schema_version")!;
    expect(check.status).toBe("ok");
  });

  it("warns on outdated schema version", async () => {
    writeFileSync(join(tmp, "schema.json"), JSON.stringify({ version: 1 }));
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "data.schema_version")!;
    expect(check.status).toBe("warn");
  });

  it("warns on missing projects.json", async () => {
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "data.projects_json")!;
    expect(check.status).toBe("warn");
  });

  it("fails on corrupt projects.json", async () => {
    writeFileSync(join(tmp, "projects.json"), "{ bad json");
    const report = await runFresh();
    const check = report.checks.find((c) => c.id === "data.projects_json")!;
    expect(check.status).toBe("fail");
  });
});

describe("runDoctor — report structure", () => {
  it("report has schemaVersion=1", async () => {
    const report = await runFresh();
    expect(report.schemaVersion).toBe(1);
  });

  it("summary counts match check statuses", async () => {
    const report = await runFresh();
    const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of report.checks) counts[c.status]++;
    expect(report.summary).toEqual(counts);
  });

  it("all check ids are unique", async () => {
    const report = await runFresh();
    const ids = report.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("JSON round-trips cleanly", async () => {
    const report = await runFresh();
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});
