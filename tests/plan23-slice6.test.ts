/**
 * Slice 6 of Plan 23 — Migration (schema v3 → v4).
 *
 * Covers:
 *   1. Synth from SCRYBE_CODE_EMBEDDING_* vars → migrated-code preset.
 *   2. Synth from no env → local-default-* presets.
 *   3. Synth rerank when SCRYBE_RERANK=true + provider supports rerank → migrated-rerank.
 *   4. Source walk: source.embedding block dropped + warn logged.
 *   5. Sidecar backfill: Plan-47 fields preserved, Plan-23 fields added.
 *   6. Schema bump: schema.json goes to v4 (or stays at v4 if already there).
 *   7. Idempotency: migration when config.json already exists doesn't clobber it.
 *   8. End-to-end: branch-filtered searchCode over migrated source returns ≥1 hit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { sidecar } from "./isolate.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "scrybe-slice6-"));
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeDotEnv(dir: string, vars: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(join(dir, ".env"), lines, "utf8");
}

function writeProjectsJson(dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "projects.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeSchemaJson(dir: string, version: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "schema.json"),
    JSON.stringify({ version, migrations_applied: [], last_written_by: "test" }, null, 2),
    "utf8",
  );
}

function writeTableMeta(dir: string, tableName: string, meta: object): void {
  const lancedbDir = join(dir, "lancedb");
  mkdirSync(lancedbDir, { recursive: true });
  writeFileSync(
    join(lancedbDir, `${tableName}-meta.json`),
    JSON.stringify(meta, null, 2) + "\n",
    "utf8",
  );
}

function readTableMeta(dir: string, tableName: string): Record<string, unknown> | null {
  const p = join(dir, "lancedb", `${tableName}-meta.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; }
  catch { return null; }
}

// ─── Test 1 — synthesizeMigrationConfig: SCRYBE_CODE_EMBEDDING_* vars ─────────

describe("synthesizeMigrationConfig — code env vars set → migrated-code preset", () => {
  it("produces migrated-code preset with credentials referencing the existing var verbatim", async () => {
    const { synthesizeMigrationConfig } = await import("../src/migrations.js");

    const envVars = new Map([
      ["SCRYBE_CODE_EMBEDDING_API_KEY", "voyage-test-key"],
      ["SCRYBE_CODE_EMBEDDING_BASE_URL", "https://api.voyageai.com/v1"],
      ["SCRYBE_CODE_EMBEDDING_MODEL", "voyage-code-3"],
    ]);

    const cfg = synthesizeMigrationConfig(envVars, false);

    expect(cfg.assignments.code_preset).toBe("migrated-code");
    const preset = cfg.embedding_presets["migrated-code"];
    expect(preset).toBeDefined();
    expect(preset?.provider).toBe("voyage");
    expect(preset?.model).toBe("voyage-code-3");
    // Credentials reference the EXISTING var verbatim — not a renamed key
    expect(preset?.credentials).toBe("${SCRYBE_CODE_EMBEDDING_API_KEY}");
  });

  it("produces migrated-code + migrated-text when both env var groups are set", async () => {
    const { synthesizeMigrationConfig } = await import("../src/migrations.js");

    const envVars = new Map([
      ["SCRYBE_CODE_EMBEDDING_API_KEY", "code-key"],
      ["SCRYBE_CODE_EMBEDDING_BASE_URL", "https://api.voyageai.com/v1"],
      ["SCRYBE_CODE_EMBEDDING_MODEL", "voyage-code-3"],
      ["SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY", "text-key"],
      ["SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL", "https://api.openai.com/v1"],
      ["SCRYBE_KNOWLEDGE_EMBEDDING_MODEL", "text-embedding-3-small"],
    ]);

    const cfg = synthesizeMigrationConfig(envVars, false);

    expect(cfg.assignments.code_preset).toBe("migrated-code");
    expect(cfg.assignments.text_preset).toBe("migrated-text");

    const textPreset = cfg.embedding_presets["migrated-text"];
    expect(textPreset).toBeDefined();
    expect(textPreset?.credentials).toBe("${SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY}");
    expect(textPreset?.provider).toBe("openai");
  });

  it("falls back to local-default-text when only code env vars are set (regression: v0.32.1 cross-profile bug)", async () => {
    const { synthesizeMigrationConfig } = await import("../src/migrations.js");

    const envVars = new Map([
      ["SCRYBE_CODE_EMBEDDING_API_KEY", "code-key"],
      ["SCRYBE_CODE_EMBEDDING_BASE_URL", "https://api.voyageai.com/v1"],
      ["SCRYBE_CODE_EMBEDDING_MODEL", "voyage-code-3"],
      // No SCRYBE_KNOWLEDGE_EMBEDDING_* vars
    ]);

    const cfg = synthesizeMigrationConfig(envVars, false);

    expect(cfg.assignments.code_preset).toBe("migrated-code");
    // Must NOT reuse migrated-code (profile=code) for text_preset slot
    expect(cfg.assignments.text_preset).toBe("local-default-text");

    const textPreset = cfg.embedding_presets["local-default-text"];
    expect(textPreset).toBeDefined();
    expect(textPreset?.provider).toBe("local");
    expect(textPreset?.credentials).toBeUndefined();
  });
});

// ─── Test 2 — synthesizeMigrationConfig: no env vars → local-default-* ────────

describe("synthesizeMigrationConfig — no env vars → local-default-* presets", () => {
  it("creates local-default-code and local-default-text", async () => {
    const { synthesizeMigrationConfig } = await import("../src/migrations.js");

    const cfg = synthesizeMigrationConfig(new Map(), false);

    expect(cfg.assignments.code_preset).toBe("local-default-code");
    expect(cfg.assignments.text_preset).toBe("local-default-text");

    const codePreset = cfg.embedding_presets["local-default-code"];
    expect(codePreset?.provider).toBe("local");
    expect(codePreset?.model).toBeTruthy();

    const textPreset = cfg.embedding_presets["local-default-text"];
    expect(textPreset?.provider).toBe("local");
  });
});

// ─── Test 3 — synthesizeMigrationConfig: rerank synth ────────────────────────

describe("synthesizeMigrationConfig — SCRYBE_RERANK=true + voyage → migrated-rerank", () => {
  it("creates migrated-rerank preset with credentials_from pointing to embedding preset", async () => {
    const { synthesizeMigrationConfig } = await import("../src/migrations.js");
    const { PROVIDERS } = await import("../src/providers.js");

    const envVars = new Map([
      ["SCRYBE_CODE_EMBEDDING_API_KEY", "voyage-key"],
      ["SCRYBE_CODE_EMBEDDING_BASE_URL", "https://api.voyageai.com/v1"],
      ["SCRYBE_CODE_EMBEDDING_MODEL", "voyage-code-3"],
    ]);

    const cfg = synthesizeMigrationConfig(envVars, true, PROVIDERS);

    expect(cfg.assignments.rerank_preset).toBe("migrated-rerank");
    expect(cfg.reranker_presets).toBeDefined();

    const rerankPreset = cfg.reranker_presets?.["migrated-rerank"];
    expect(rerankPreset).toBeDefined();
    // provider is omitted now (defaults to "http"); the vendor name was unused at
    // runtime — Voyage rerank is auto-detected from the embedding provider.
    expect(rerankPreset?.provider).toBeUndefined();
    expect(rerankPreset?.credentials_from).toBe("migrated-code");
    // No separate credentials field — reuses the embedding preset's
    expect(rerankPreset?.credentials).toBeUndefined();
  });

  it("does NOT create rerank preset when provider has no rerank capability", async () => {
    const { synthesizeMigrationConfig } = await import("../src/migrations.js");
    const { PROVIDERS } = await import("../src/providers.js");

    // OpenAI has no rerank_models
    const envVars = new Map([
      ["SCRYBE_CODE_EMBEDDING_API_KEY", "openai-key"],
      ["SCRYBE_CODE_EMBEDDING_BASE_URL", "https://api.openai.com/v1"],
      ["SCRYBE_CODE_EMBEDDING_MODEL", "text-embedding-3-small"],
    ]);

    const cfg = synthesizeMigrationConfig(envVars, true, PROVIDERS);

    expect(cfg.assignments.rerank_preset).toBeUndefined();
    expect(cfg.reranker_presets).toBeUndefined();
  });
});

// ─── Test 4 — source walk: source.embedding block dropped ────────────────────

describe("runPendingMigrations — source.embedding block dropped + warn logged", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("drops source.embedding override and logs a warning", async () => {
    writeSchemaJson(dir, 4);

    // Seed a source WITH a per-source embedding override
    writeProjectsJson(dir, [
      {
        id: "myproject",
        description: "",
        sources: [
          {
            source_id: "primary",
            source_config: { type: "code", root_path: "/tmp/myproject", languages: [] },
            embedding: {
              base_url: "https://api.voyageai.com/v1",
              model: "voyage-code-3",
              dimensions: 1024,
              api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
            },
          },
        ],
      },
    ]);

    const stderrLines: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      stderrLines.push(s);
      return origStderr(s);
    };

    try {
      const { runPendingMigrations } = await import("../src/migrations.js");
      await runPendingMigrations([
        "compact-tables-v0.23.2",
        "rename-env-vars-v0.29.0",
        "add-rerank-key-v0.29.1",
        "cleanup-zombie-jobs-v0.29.3",
      ]);
    } finally {
      (process.stderr as any).write = origStderr;
    }

    const projects = readJsonFile(join(dir, "projects.json")) as Array<{
      sources: Array<{ embedding?: unknown }>;
    }>;
    expect(projects[0]?.sources[0]?.["embedding"]).toBeUndefined();

    const warnLine = stderrLines.join("").toLowerCase();
    expect(warnLine).toContain("myproject/primary");
    expect(warnLine).toContain("per-source embedding override");
  });
});

// ─── Test 5 — sidecar backfill ────────────────────────────────────────────────

describe("runPendingMigrations — sidecar backfill: Plan-47 fields preserved, Plan-23 fields added", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
    // Use sidecar embedder env vars so the preset resolver can resolve the config
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = sidecar.baseUrl;
    process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = sidecar.model;
    process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = String(sidecar.dimensions);
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test";
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"];
    delete process.env["SCRYBE_CODE_EMBEDDING_MODEL"];
    delete process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"];
    delete process.env["SCRYBE_CODE_EMBEDDING_API_KEY"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("preserves chunk_id_scheme and adds model/dim/provider/preset_at_index_time/indexed_at", async () => {
    writeSchemaJson(dir, 4);

    const TABLE_NAME = "myproject_primary";

    // Sidecar has custom provider; write a config.json pre-populated with a local preset
    // so the resolver has something to work with
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: {
        "local-code": { provider: "local", model: "Xenova/multilingual-e5-small" },
      },
      assignments: {
        code_preset: "local-code",
        text_preset: "local-code",
      },
    }, null, 2) + "\n", "utf8");

    // Plan-47 style sidecar — only chunk_id_scheme fields, no model fields
    writeTableMeta(dir, TABLE_NAME, {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
    });

    writeProjectsJson(dir, [
      {
        id: "myproject",
        description: "",
        sources: [
          {
            source_id: "primary",
            source_config: { type: "code", root_path: "/tmp/myproject", languages: [] },
            table_name: TABLE_NAME,
          },
        ],
      },
    ]);

    const { runPendingMigrations } = await import("../src/migrations.js");
    await runPendingMigrations([
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
      "cleanup-zombie-jobs-v0.29.3",
    ]);

    const meta = readTableMeta(dir, TABLE_NAME);
    expect(meta).not.toBeNull();

    // Plan-47 fields MUST survive
    expect(meta?.["chunk_id_scheme"]).toBe(2);
    expect(meta?.["chunk_id_scheme_introduced_in"]).toBe("0.31.0");

    // Plan-23 fields added
    expect(meta?.["model"]).toBeTruthy();
    expect(meta?.["dim"]).toBeGreaterThan(0);
    expect(meta?.["provider"]).toBeTruthy();
    expect(meta?.["preset_at_index_time"]).toBeTruthy();
    expect(meta?.["indexed_at"]).toBeTruthy();
  });
});

// ─── Test 6 — schema.json at v4 ──────────────────────────────────────────────

describe("runPendingMigrations — schema.json is at version 4 after migration", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("schema.json version is 4 after checkAndMigrate runs on a v3 install", async () => {
    // Simulate a v3 install (pre-v0.32.0): schema.json at version 3
    writeSchemaJson(dir, 3);
    writeFileSync(join(dir, "projects.json"), JSON.stringify([]), "utf8");

    // The DB must exist for the v3→v4 ALTER TABLE job to not throw
    // (checkAndMigrate uses getDB which creates the DB on access)
    const { checkAndMigrate } = await import("../src/schema-version.js");
    const result = await checkAndMigrate();

    expect(result.version).toBe(4);

    const schema = readJsonFile(join(dir, "schema.json")) as { version: number };
    expect(schema.version).toBe(4);
  });
});

// ─── Test 7 — idempotency ─────────────────────────────────────────────────────

describe("runPendingMigrations — idempotency: existing config.json not clobbered", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("does not overwrite config.json when it already exists", async () => {
    writeSchemaJson(dir, 4);
    writeFileSync(join(dir, "projects.json"), JSON.stringify([]), "utf8");

    // Write a specific config.json (e.g. from a previous wizard run)
    const existingCfg = {
      schema_version: 1,
      embedding_presets: {
        "my-custom-preset": { provider: "voyage", model: "voyage-code-3", credentials: "${MY_CUSTOM_KEY}" },
      },
      assignments: {
        code_preset: "my-custom-preset",
        text_preset: "my-custom-preset",
      },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(existingCfg, null, 2) + "\n", "utf8");

    const { runPendingMigrations } = await import("../src/migrations.js");
    // Run twice to be sure
    await runPendingMigrations([
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
      "cleanup-zombie-jobs-v0.29.3",
    ]);
    await runPendingMigrations([
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
      "cleanup-zombie-jobs-v0.29.3",
      "init-config-v0.32.0",
    ]);

    const cfg = readJsonFile(join(dir, "config.json")) as {
      assignments: { code_preset: string };
    };
    // Original config preserved — not replaced with migrated-* or local-default-*
    expect(cfg.assignments.code_preset).toBe("my-custom-preset");
  });
});

// ─── Test 8 — end-to-end: branch-filtered searchCode post-migration ───────────

describe("end-to-end — branch-filtered searchCode over migrated source returns ≥1 hit", () => {
  let dir: string;
  const FAKE_DIMS = sidecar.dimensions; // use real sidecar dims (384)
  const PROJECT_ID = "e2e-migration-test";
  const SOURCE_ID = "primary";
  const TABLE_NAME = `${PROJECT_ID}_${SOURCE_ID}`;
  const BRANCH = "master";

  beforeEach(() => {
    dir = makeTempDir();
    process.env["SCRYBE_DATA_DIR"] = dir;
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = sidecar.baseUrl;
    process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = sidecar.model;
    process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = String(sidecar.dimensions);
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test";
    // Disable rerank and hybrid for test isolation
    process.env["SCRYBE_RERANK"] = "false";
    process.env["SCRYBE_HYBRID"] = "false";
  });

  afterEach(async () => {
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"];
    delete process.env["SCRYBE_CODE_EMBEDDING_MODEL"];
    delete process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"];
    delete process.env["SCRYBE_CODE_EMBEDDING_API_KEY"];
    delete process.env["SCRYBE_RERANK"];
    delete process.env["SCRYBE_HYBRID"];
    // Brief pause for LanceDB to release file handles
    await new Promise((r) => setTimeout(r, 100));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("searchCode returns ≥1 hit against a source that had a source.embedding override before migration", async () => {
    // --- Seed a pre-migration v0.31.6 style install ---

    // 1. Write .env with profile-keyed SCRYBE_CODE_EMBEDDING_* vars pointing at sidecar
    writeDotEnv(dir, {
      SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
      SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
      SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
      SCRYBE_CODE_EMBEDDING_API_KEY: "test",
    });

    // 2. Write projects.json with one source that has a source.embedding override
    writeProjectsJson(dir, [
      {
        id: PROJECT_ID,
        description: "E2E migration test project",
        sources: [
          {
            source_id: SOURCE_ID,
            source_config: { type: "code", root_path: "/tmp/e2e-migration", languages: ["ts"] },
            table_name: TABLE_NAME,
            // Old-style per-source embedding override (to be dropped by migration)
            embedding: {
              base_url: sidecar.baseUrl,
              model: sidecar.model,
              dimensions: sidecar.dimensions,
              api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
            },
          },
        ],
      },
    ]);

    // 3. Write Plan-47 style sidecar (no model fields)
    writeTableMeta(dir, TABLE_NAME, {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
    });

    // 4. Create LanceDB table with 2 real rows and real branch_tags entries
    const lancedbDir = join(dir, "lancedb");
    mkdirSync(lancedbDir, { recursive: true });

    // Build the code chunk schema (matching vector-store.ts makeSchema)
    const schema = new Schema([
      new Field("chunk_id", new Utf8(), false),
      new Field("project_id", new Utf8(), false),
      new Field("item_path", new Utf8(), false),
      new Field("content", new Utf8(), false),
      new Field("start_line", new Int32(), false),
      new Field("end_line", new Int32(), false),
      new Field("language", new Utf8(), false),
      new Field("symbol_name", new Utf8(), false),
      new Field(
        "vector",
        new FixedSizeList(FAKE_DIMS, new Field("item", new Float32(), false)),
        false,
      ),
    ]);

    const CHUNK_ID_1 = "e2e-chunk-001";
    const CHUNK_ID_2 = "e2e-chunk-002";

    const rows = [
      {
        chunk_id: CHUNK_ID_1,
        project_id: PROJECT_ID,
        item_path: "src/hello.ts",
        content: "export function greetUser(name: string): string { return `Hello, ${name}!`; }",
        start_line: 1,
        end_line: 3,
        language: "typescript",
        symbol_name: "greetUser",
        vector: new Float32Array(FAKE_DIMS).fill(0.5),
      },
      {
        chunk_id: CHUNK_ID_2,
        project_id: PROJECT_ID,
        item_path: "src/util.ts",
        content: "export function add(a: number, b: number): number { return a + b; }",
        start_line: 1,
        end_line: 2,
        language: "typescript",
        symbol_name: "add",
        vector: new Float32Array(FAKE_DIMS).fill(0.3),
      },
    ];

    const db = await lancedb.connect(lancedbDir);
    await db.createTable(TABLE_NAME, rows as any, { schema });

    // 5. Seed branch_tags in SQLite so the branch filter works.
    // Use getDB() to ensure the correct schema is created, then insert with all required fields.
    const { getDB, closeDB } = await import("../src/branch-state.js");
    const branchDb = getDB();
    const insertTag = branchDb.prepare(`
      INSERT OR IGNORE INTO branch_tags
        (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertTag.run(PROJECT_ID, SOURCE_ID, BRANCH, "src/hello.ts", CHUNK_ID_1, 1, 3);
    insertTag.run(PROJECT_ID, SOURCE_ID, BRANCH, "src/util.ts", CHUNK_ID_2, 1, 2);

    // 6. Write schema.json at v3 to simulate pre-migration
    writeSchemaJson(dir, 3);

    // 7. Run migration — this creates config.json, drops source.embedding, backfills sidecar
    const { runPendingMigrations } = await import("../src/migrations.js");
    await runPendingMigrations([
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
      "cleanup-zombie-jobs-v0.29.3",
    ]);

    // Verify migration outcomes
    const cfgPath = join(dir, "config.json");
    expect(existsSync(cfgPath)).toBe(true);

    const projects = readJsonFile(join(dir, "projects.json")) as Array<{
      sources: Array<{ embedding?: unknown; table_name: string }>;
    }>;
    expect(projects[0]?.sources[0]?.["embedding"]).toBeUndefined();

    const meta = readTableMeta(dir, TABLE_NAME);
    expect(meta?.["chunk_id_scheme"]).toBe(2);
    expect(meta?.["model"]).toBeTruthy();

    // 8. End-to-end search: the resolver must pick up the new config.json preset,
    //    inject credentials, and return hits from the seeded table.
    //    The sidecar embedder returns real vectors; we just need ≥1 hit.
    const { searchCode } = await import("../src/search.js");
    const hits = await searchCode("greet user function", PROJECT_ID, {
      limit: 5,
      branch: BRANCH,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    closeDB();
  }, 30000);
});
