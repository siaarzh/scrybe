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
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "";
    const report = await runFresh();
    const key = report.checks.find((c) => c.id === "provider.key_present")!;
    expect(key.status).toBe("fail");
    const auth = report.checks.find((c) => c.id === "provider.auth")!;
    expect(auth.status).toBe("skip");
  });

  it("provider.auth fail when fetch returns 401", async () => {
    // Mock validate-provider to return auth failure
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: false, errorType: "auth", message: "Invalid API key" }),
      validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
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
      validateLocal: async () => ({ ok: true, dimensions: 512, model: "local", coldStartMs: 100 }),
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
    const { CURRENT_SCHEMA_VERSION } = await import("../src/schema-version.js");
    writeFileSync(join(tmp, "schema.json"), JSON.stringify({ version: CURRENT_SCHEMA_VERSION }));
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

describe("runDoctor — fresh install profile", () => {
  it("reclassifies 4 data checks as ok when projects.json exists but schema.json absent", async () => {
    // Simulate post-init state: one project with one source, no index yet
    const fixtureProject = {
      id: "test-proj",
      description: "",
      sources: [
        {
          source_id: "primary",
          source_config: { type: "code", root_path: tmp, languages: [] },
          last_indexed: null,
        },
      ],
    };
    writeFileSync(join(tmp, "projects.json"), JSON.stringify([fixtureProject]), "utf8");
    // schema.json intentionally absent

    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
      validateLocal: async () => ({ ok: true, dimensions: 384, model: "local", coldStartMs: 100 }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => null,
      isDaemonRunning: () => false,
    }));
    vi.doMock("../src/onboarding/mcp-config.js", () => ({
      detectMcpConfigs: () => [],
      readScrybeEntry: () => null,
      proposeScrybeEntry: () => ({}),
    }));

    const report = await runFresh();

    const schema = report.checks.find((c) => c.id === "data.schema_version")!;
    const lancedb = report.checks.find((c) => c.id === "data.lancedb")!;
    const branchTags = report.checks.find((c) => c.id === "data.branch_tags_db")!;
    const lastIndexed = report.checks.find((c) => c.id === "project.test-proj.primary.last_indexed")!;

    expect(schema.status).toBe("ok");
    expect(schema.message).toContain("expected");
    expect(lancedb.status).toBe("ok");
    expect(lancedb.message).toContain("expected");
    expect(branchTags.status).toBe("ok");
    expect(branchTags.message).toContain("expected");
    expect(lastIndexed.status).toBe("ok");
    expect(lastIndexed.message).toContain("expected");
  });

  it("still warns when projects.json absent (not fresh-install state)", async () => {
    // DATA_DIR exists but no projects.json → not a fresh install
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
      validateLocal: async () => ({ ok: true, dimensions: 384, model: "local", coldStartMs: 100 }),
    }));
    vi.doMock("../src/daemon/pidfile.js", () => ({
      readPidfile: () => null,
      isDaemonRunning: () => false,
    }));
    vi.doMock("../src/onboarding/mcp-config.js", () => ({
      detectMcpConfigs: () => [],
      readScrybeEntry: () => null,
      proposeScrybeEntry: () => ({}),
    }));

    const report = await runFresh();
    const schema = report.checks.find((c) => c.id === "data.schema_version")!;
    expect(schema.status).toBe("warn");
  });
});
