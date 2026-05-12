/**
 * Slice 5 of Plan 23 — Wizard rewrite + doctor checks.
 *
 * Covers:
 *   Wizard:
 *     1. Scenario 1: fresh install, local defaults → config.json valid, doctor green.
 *     2. Scenario 2: Voyage code + OpenAI text → SCRYBE_VOYAGE_API_KEY + SCRYBE_OPENAI_API_KEY.
 *     3. Scenario 3: Voyage everywhere + rerank → ONE SCRYBE_VOYAGE_API_KEY, credentials_from.
 *     4. Scenario 4a: Custom provider + mock 401 probe → retry path triggered (status flagged).
 *     4b. Scenario 4b: Custom provider + mock 200 probe → models returned.
 *     5. Scenario 5: Two custom presets same host → _2 suffix on second key name.
 *   Doctor:
 *     6. Malformed config.json → config.well_formed fails.
 *     7. Missing ${VAR} → config.refs_resolve fails with var name in remedy.
 *     8. Missing assignment → config.assignments_complete fails.
 *     9. Synthetic mismatched sidecar → tables.consistent warns.
 *     10. Pre-migration sidecar (no model fields) → tables.consistent does NOT flag.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── test helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "scrybe-slice5-"));
}

function writeConfig(dir: string, cfg: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function readEnvFile(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return result;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

// ─── Wizard scenarios ─────────────────────────────────────────────────────────

describe("synthesizeWizardConfig — Scenario 1: fresh install, local defaults", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("produces config.json with local presets for both code and text", async () => {
    const { synthesizeWizardConfig, writeEnvFile } = await import("../src/onboarding/wizard.js");
    const { writeScrybeConfig, readScrybeConfig } = await import("../src/config.js");

    const output = synthesizeWizardConfig({
      code: { provider: "local", apiKey: "", model: "Xenova/multilingual-e5-small" },
      text: { provider: "local", apiKey: "", model: "Xenova/multilingual-e5-small" },
      dataDir: dir,
    });

    writeScrybeConfig(output.config);
    if (Object.keys(output.envVars).length > 0) {
      writeEnvFile(dir, output.envVars);
    }

    const cfg = readScrybeConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.schema_version).toBe(1);
    expect(cfg!.assignments.code_preset).toBeTruthy();
    expect(cfg!.assignments.text_preset).toBeTruthy();

    // Local provider — no API key in env vars
    expect(Object.keys(output.envVars)).toHaveLength(0);

    // Both presets use local provider
    const codePreset = cfg!.embedding_presets[cfg!.assignments.code_preset];
    expect(codePreset?.provider).toBe("local");
    const textPreset = cfg!.embedding_presets[cfg!.assignments.text_preset];
    expect(textPreset?.provider).toBe("local");
  });
});

describe("synthesizeWizardConfig — Scenario 2: Voyage code + OpenAI text", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes SCRYBE_VOYAGE_API_KEY and SCRYBE_OPENAI_API_KEY as separate entries", async () => {
    const { synthesizeWizardConfig, writeEnvFile } = await import("../src/onboarding/wizard.js");
    const { writeScrybeConfig, readScrybeConfig } = await import("../src/config.js");

    const output = synthesizeWizardConfig({
      code: { provider: "voyage", apiKey: "voyage-secret", model: "voyage-code-3" },
      text: { provider: "openai", apiKey: "openai-secret", model: "text-embedding-3-small" },
      dataDir: dir,
    });

    writeScrybeConfig(output.config);
    writeEnvFile(dir, output.envVars);

    const envVars = readEnvFile(dir);
    expect(envVars["SCRYBE_VOYAGE_API_KEY"]).toBe("voyage-secret");
    expect(envVars["SCRYBE_OPENAI_API_KEY"]).toBe("openai-secret");

    const cfg = readScrybeConfig();
    expect(cfg!.assignments.code_preset).toBeTruthy();
    expect(cfg!.assignments.text_preset).toBeTruthy();

    // Presets reference env vars
    const codePreset = cfg!.embedding_presets[cfg!.assignments.code_preset];
    expect(codePreset?.credentials).toBe("${SCRYBE_VOYAGE_API_KEY}");
    expect(codePreset?.provider).toBe("voyage");

    const textPreset = cfg!.embedding_presets[cfg!.assignments.text_preset];
    expect(textPreset?.credentials).toBe("${SCRYBE_OPENAI_API_KEY}");
    expect(textPreset?.provider).toBe("openai");
  });
});

describe("synthesizeWizardConfig — Scenario 3: Voyage everywhere + rerank", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes ONE SCRYBE_VOYAGE_API_KEY and rerank preset uses credentials_from", async () => {
    const { synthesizeWizardConfig, writeEnvFile } = await import("../src/onboarding/wizard.js");
    const { writeScrybeConfig, readScrybeConfig } = await import("../src/config.js");

    const output = synthesizeWizardConfig({
      code: { provider: "voyage", apiKey: "voyage-secret", model: "voyage-code-3" },
      text: { provider: "voyage", apiKey: "voyage-secret", model: "voyage-3" },
      rerank: { provider: "voyage", model: "rerank-2.5" },
      dataDir: dir,
    });

    writeScrybeConfig(output.config);
    writeEnvFile(dir, output.envVars);

    const envVars = readEnvFile(dir);
    // Only ONE voyage key in .env
    const voyageKeys = Object.keys(envVars).filter((k) => k.includes("VOYAGE"));
    expect(voyageKeys).toHaveLength(1);
    expect(voyageKeys[0]).toBe("SCRYBE_VOYAGE_API_KEY");

    const cfg = readScrybeConfig();
    expect(cfg!.reranker_presets).toBeTruthy();
    const rerankPreset = Object.values(cfg!.reranker_presets!)[0];
    expect(rerankPreset?.credentials_from).toBeTruthy();
    // No duplicate credentials field on the reranker preset (credentials_from is enough)
    expect(rerankPreset?.credentials).toBeUndefined();
  });
});

describe("probeModelsEndpoint — Scenario 4a: Custom provider mock 401", () => {
  it("returns status=401 when server responds with 401", async () => {
    const { probeModelsEndpoint } = await import("../src/onboarding/wizard.js");

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    try {
      const result = await probeModelsEndpoint("https://api.example.com/v1", "bad-key");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("probeModelsEndpoint — Scenario 4b: Custom provider mock 200", () => {
  it("returns model list when server responds with 200", async () => {
    const { probeModelsEndpoint } = await import("../src/onboarding/wizard.js");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "model-a" },
          { id: "model-b" },
        ],
      }),
    } as Response);

    try {
      const result = await probeModelsEndpoint("https://api.together.xyz/v1", "good-key");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(200);
      expect(result!.models).toContain("model-a");
      expect(result!.models).toContain("model-b");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("customKeyName — Scenario 5: slug collision", () => {
  it("appends _2 suffix when first key already exists", async () => {
    const { customKeyName } = await import("../src/onboarding/wizard.js");

    const existingKeys = new Set(["SCRYBE_CUSTOM_TOGETHER_API_KEY"]);
    const name = customKeyName("https://api.together.xyz/v1", existingKeys);
    expect(name).toBe("SCRYBE_CUSTOM_TOGETHER_2_API_KEY");
  });

  it("appends _3 suffix when both _1 and _2 already exist", async () => {
    const { customKeyName } = await import("../src/onboarding/wizard.js");

    const existingKeys = new Set([
      "SCRYBE_CUSTOM_TOGETHER_API_KEY",
      "SCRYBE_CUSTOM_TOGETHER_2_API_KEY",
    ]);
    const name = customKeyName("https://api.together.xyz/v1", existingKeys);
    expect(name).toBe("SCRYBE_CUSTOM_TOGETHER_3_API_KEY");
  });

  it("two custom presets same host get distinct env var names", async () => {
    const { synthesizeWizardConfig } = await import("../src/onboarding/wizard.js");

    // First custom preset
    const out1 = synthesizeWizardConfig({
      code: { provider: "custom", apiKey: "key1", model: "model-a", baseUrl: "https://api.together.xyz/v1", dim: 768 },
      text: { provider: "custom", apiKey: "key2", model: "model-b", baseUrl: "https://api.another-together.xyz/v1", dim: 512 },
      dataDir: "/tmp/fake",
    });

    // Second run that would collide if priorEnvKeys not passed
    // Simulate by passing the keys emitted by out1 as priorEnvKeys
    const priorKeys = new Set(Object.keys(out1.envVars));
    const out2 = synthesizeWizardConfig({
      code: { provider: "custom", apiKey: "key3", model: "model-c", baseUrl: "https://api.together.xyz/v1", dim: 768 },
      text: { provider: "local", apiKey: "", model: "Xenova/multilingual-e5-small" },
      dataDir: "/tmp/fake",
    }, priorKeys);

    // The second 'together' custom preset should get a _2 suffix
    const key2Names = Object.keys(out2.envVars).filter((k) => k.includes("TOGETHER"));
    expect(key2Names.length).toBe(1);
    expect(key2Names[0]).toMatch(/_2_API_KEY$/);
  });
});

// ─── Doctor checks ────────────────────────────────────────────────────────────

describe("doctor — config.well_formed: malformed config.json", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("emits config.well_formed fail for invalid JSON", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not valid json", "utf8");

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.well_formed");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("fail");
    expect(check!.message.toLowerCase()).toMatch(/parse error|not valid json/i);
  });

  it("emits config.well_formed fail for unresolved preset reference", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
      },
      assignments: {
        code_preset: "nonexistent-preset",
        text_preset: "voyage-code",
      },
    });

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.well_formed");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("fail");
    expect(check!.message).toMatch(/nonexistent-preset/);
  });

  it("passes config.well_formed when rerank_preset resolves via reranker_presets (regression: v0.32.1 doctor false-positive)", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
      },
      reranker_presets: {
        "voyage-rerank": { provider: "voyage", model: "rerank-2.5", credentials_from: "voyage-code" },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-code",
        rerank_preset: "voyage-rerank",
      },
    });

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.well_formed");
    expect(check).toBeTruthy();
    // Must NOT fail — rerank_preset lives in reranker_presets, not embedding_presets
    expect(check!.status).toBe("ok");
  });
});

describe("doctor — config.refs_resolve: missing env var", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
    delete process.env["SCRYBE_VOYAGE_API_KEY"];
    delete process.env["SCRYBE_OPENAI_API_KEY"];
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_VOYAGE_API_KEY"];
    delete process.env["SCRYBE_OPENAI_API_KEY"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("emits config.refs_resolve fail with missing var name in remedy", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": {
          provider: "voyage",
          model: "voyage-code-3",
          credentials: "${SCRYBE_VOYAGE_API_KEY}",
        },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-code",
      },
    });

    // SCRYBE_VOYAGE_API_KEY is NOT set (deleted in beforeEach)
    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.refs_resolve");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("fail");
    expect(check!.message).toMatch(/SCRYBE_VOYAGE_API_KEY/);
  });

  it("emits config.refs_resolve ok when all vars are set", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": {
          provider: "voyage",
          model: "voyage-code-3",
          credentials: "${SCRYBE_VOYAGE_API_KEY}",
        },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-code",
      },
    });

    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key-123";

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.refs_resolve");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("ok");
  });
});

describe("doctor — config.assignments_complete: missing assignment", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("emits config.assignments_complete fail when text_preset is empty string", async () => {
    // Empty string passes JSON schema validation (it's a string) but fails truthiness check
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "",  // empty string — schema-valid but assignment is incomplete
      },
    }, null, 2) + "\n", "utf8");

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.assignments_complete");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("fail");
    expect(check!.message).toMatch(/text_preset/);
  });

  it("emits config.assignments_complete ok when both are assigned", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "local-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: {
        code_preset: "local-code",
        text_preset: "local-code",
      },
    });

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "config.assignments_complete");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("ok");
  });
});

describe("doctor — tables.consistent", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeProjectsJson(projectsData: object[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify(projectsData, null, 2) + "\n", "utf8");
  }

  function writeTableMeta(tableName: string, meta: object): void {
    const lancedbDir = join(dir, "lancedb");
    mkdirSync(lancedbDir, { recursive: true });
    writeFileSync(join(lancedbDir, `${tableName}-meta.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
  }

  it("warns when sidecar model differs from resolved preset", async () => {
    // Write config with voyage-code-3 preset
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
        "voyage-text": { provider: "voyage", model: "voyage-3" },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-text",
      },
    });

    // Write a sidecar that claims a different model
    writeTableMeta("myproject_primary", {
      chunk_id_scheme: 2,
      model: "old-model-not-voyage-code-3",
      dim: 1024,
      provider: "voyage",
    });

    // Write projects.json referencing this table
    writeProjectsJson([{
      id: "myproject",
      description: "",
      sources: [{
        source_id: "primary",
        source_config: { type: "code", root_path: "/tmp/myproject", languages: [] },
        table_name: "myproject_primary",
        last_indexed: new Date().toISOString(),
      }],
    }]);

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "tables.consistent");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("warn");
    expect(check!.message).toMatch(/myproject\/primary/);
  });

  it("does NOT flag pre-migration sidecar (no model fields)", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
        "voyage-text": { provider: "voyage", model: "voyage-3" },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-text",
      },
    });

    // Sidecar without model fields (Plan 47 style — pre-migration)
    writeTableMeta("myproject_primary", {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      // No model, dim, provider fields
    });

    writeProjectsJson([{
      id: "myproject",
      description: "",
      sources: [{
        source_id: "primary",
        source_config: { type: "code", root_path: "/tmp/myproject", languages: [] },
        table_name: "myproject_primary",
        last_indexed: new Date().toISOString(),
      }],
    }]);

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "tables.consistent");
    expect(check).toBeTruthy();
    // Should be ok (no tables with model fields to compare)
    expect(check!.status).toBe("ok");
  });

  it("ok when sidecar matches resolved preset", async () => {
    writeConfig(dir, {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": { provider: "voyage", model: "voyage-code-3" },
        "voyage-text": { provider: "voyage", model: "voyage-3" },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-text",
      },
    });

    // Sidecar matches voyage-code-3
    writeTableMeta("myproject_primary", {
      chunk_id_scheme: 2,
      model: "voyage-code-3",
      dim: 1024,
      provider: "voyage",
    });

    writeProjectsJson([{
      id: "myproject",
      description: "",
      sources: [{
        source_id: "primary",
        source_config: { type: "code", root_path: "/tmp/myproject", languages: [] },
        table_name: "myproject_primary",
        last_indexed: new Date().toISOString(),
      }],
    }]);

    const { runDoctor } = await import("../src/onboarding/doctor.js");
    const report = await runDoctor();

    const check = report.checks.find((c) => c.id === "tables.consistent");
    expect(check).toBeTruthy();
    expect(check!.status).toBe("ok");
  });
});
