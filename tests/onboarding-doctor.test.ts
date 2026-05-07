import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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

describe("runDoctor — fetch-poller pinned-branch sync (#11)", () => {
  it("#11 — reports OK for in-sync branch and BEHIND for out-of-date branch", async () => {
    const fixtureProject = {
      id: "test-fp-proj",
      description: "fetch-poller sync test",
      sources: [
        {
          source_id: "primary",
          source_config: { type: "code", root_path: tmp, languages: [] },
          last_indexed: new Date().toISOString(),
          pinned_branches: ["main", "feature/x"],
        },
      ],
    };
    writeFileSync(join(tmp, "projects.json"), JSON.stringify([fixtureProject]), "utf8");

    // branch-state mock: getLastIndexedSha returns per-branch SHAs
    vi.doMock("../src/branch-state.js", () => ({
      getLastIndexedSha: vi.fn((projectId: string, sourceId: string, branch: string) => {
        if (branch === "origin/main") return "abc123abc123abc123abc123abc123abc123abc1";
        if (branch === "origin/feature/x") return "old456old456old456old456old456old456old4";
        return null;
      }),
      listBranches: vi.fn(() => ["origin/main", "origin/feature/x"]),
    }));

    // git-exec mock: rev-parse returns per-branch remote SHAs
    vi.doMock("../src/util/git-exec.js", () => ({
      gitExec: vi.fn((args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "origin/main") {
          return "abc123abc123abc123abc123abc123abc123abc1";
        }
        if (args[0] === "rev-parse" && args[1] === "origin/feature/x") {
          return "new789new789new789new789new789new789new7";
        }
        return null;
      }),
    }));

    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
      validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
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
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => false,
    }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
    }));
    vi.doMock("../src/vector-store.js", () => ({
      countTableRows: async () => 0,
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    // main branch: in sync → OK
    const mainCheck = report.checks.find((c) => c.id === "daemon.fetch-poller.test-fp-proj.primary.main");
    expect(mainCheck).toBeDefined();
    expect(mainCheck!.status).toBe("ok");
    expect(mainCheck!.message).toContain("sync");

    // feature/x branch: behind → warn
    const featureCheck = report.checks.find((c) => c.id === "daemon.fetch-poller.test-fp-proj.primary.feature__x");
    expect(featureCheck).toBeDefined();
    expect(featureCheck!.status).toBe("warn");
    expect(featureCheck!.message).toContain("old456");
    expect(featureCheck!.message).toContain("new789");
  });

  it("#11b — MISSING_REMOTE warns when gitExec returns null", async () => {
    const fixtureProject = {
      id: "test-fp-del",
      description: "deleted remote branch",
      sources: [
        {
          source_id: "primary",
          source_config: { type: "code", root_path: tmp, languages: [] },
          last_indexed: new Date().toISOString(),
          pinned_branches: ["gone/branch"],
        },
      ],
    };
    writeFileSync(join(tmp, "projects.json"), JSON.stringify([fixtureProject]), "utf8");

    vi.doMock("../src/branch-state.js", () => ({
      getLastIndexedSha: vi.fn(() => "someshasomeshasomeshasomeshasomeshasomes"),
      listBranches: vi.fn(() => ["origin/gone/branch"]),
    }));
    vi.doMock("../src/util/git-exec.js", () => ({
      gitExec: vi.fn(() => null), // remote branch deleted
    }));
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
      validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
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
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => false,
    }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
    }));
    vi.doMock("../src/vector-store.js", () => ({
      countTableRows: async () => 0,
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "daemon.fetch-poller.test-fp-del.primary.gone__branch");
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.message).toContain("no longer has");
  });

  it("#11c — NO_SHA: indexed in branch_tags but no branch_state row → ok with backfill note", async () => {
    const fixtureProject = {
      id: "test-fp-nosha",
      description: "no sha in branch_state",
      sources: [
        {
          source_id: "primary",
          source_config: { type: "code", root_path: tmp, languages: [] },
          last_indexed: new Date().toISOString(),
          pinned_branches: ["legacy"],
        },
      ],
    };
    writeFileSync(join(tmp, "projects.json"), JSON.stringify([fixtureProject]), "utf8");

    vi.doMock("../src/branch-state.js", () => ({
      getLastIndexedSha: vi.fn(() => null),
      listBranches: vi.fn(() => ["origin/legacy"]), // in branch_tags
    }));
    vi.doMock("../src/util/git-exec.js", () => ({
      gitExec: vi.fn(() => "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    }));
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
      validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
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
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => false,
    }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
    }));
    vi.doMock("../src/vector-store.js", () => ({
      countTableRows: async () => 0,
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "daemon.fetch-poller.test-fp-nosha.primary.legacy");
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.message).toContain("backfill");
  });

  it("#11d — NEVER_INDEXED: no branch_state AND no branch_tags → ok with first-index note", async () => {
    const fixtureProject = {
      id: "test-fp-never",
      description: "never indexed",
      sources: [
        {
          source_id: "primary",
          source_config: { type: "code", root_path: tmp, languages: [] },
          last_indexed: null,
          pinned_branches: ["new-feature"],
        },
      ],
    };
    writeFileSync(join(tmp, "projects.json"), JSON.stringify([fixtureProject]), "utf8");

    vi.doMock("../src/branch-state.js", () => ({
      getLastIndexedSha: vi.fn(() => null),
      listBranches: vi.fn(() => []), // NOT in branch_tags
    }));
    vi.doMock("../src/util/git-exec.js", () => ({
      gitExec: vi.fn(() => "cafecafecafecafecafecafecafecafecafecafe"),
    }));
    vi.doMock("../src/onboarding/validate-provider.js", () => ({
      validateProvider: async () => ({ ok: true, dimensions: 1024, model: "voyage-code-3" }),
      validateLocal: async () => ({ ok: true, dimensions: 1024, model: "local", coldStartMs: 100 }),
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
    vi.doMock("../src/daemon/container-detect.js", () => ({
      isContainer: () => false,
    }));
    vi.doMock("../src/daemon/install/index.js", () => ({
      getInstallStatus: async () => ({ installed: false }),
    }));
    vi.doMock("../src/vector-store.js", () => ({
      countTableRows: async () => 0,
    }));

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "daemon.fetch-poller.test-fp-never.primary.new-feature");
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.message).toContain("first reindex");
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
