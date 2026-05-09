/**
 * Slice 1 of Plan 23 — Catalog + sidecar foundation.
 *
 * Covers:
 *   1. Provider catalog — getProvider / getModel happy path + unknowns
 *   2. ${VAR} resolver — literal pass-through / resolves env / throws on missing
 *   3. Sidecar round-trip — Plan-47 fields survive a Plan-23 field merge
 *   4. dropAndRecreateTable — callable against a temp Lance table
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── 1. Provider catalog ──────────────────────────────────────────────────────

describe("Provider catalog", () => {
  it("getProvider returns the spec for a known provider", async () => {
    const { getProvider } = await import("../src/providers.js");
    const spec = getProvider("voyage");
    expect(spec.name).toBe("Voyage AI");
    expect(spec.auth).toBe("bearer");
    expect(spec.embedding_models["voyage-code-3"]).toBeDefined();
    expect(spec.rerank_models).not.toBeNull();
  });

  it("getProvider returns the spec for openai", async () => {
    const { getProvider } = await import("../src/providers.js");
    const spec = getProvider("openai");
    expect(spec.name).toBe("OpenAI");
    expect(spec.rerank_models).toBeNull();
  });

  it("getProvider returns the spec for local", async () => {
    const { getProvider } = await import("../src/providers.js");
    const spec = getProvider("local");
    expect(spec.auth).toBe("none");
  });

  it("getProvider returns the spec for custom with accepts_raw_fields", async () => {
    const { getProvider } = await import("../src/providers.js");
    const spec = getProvider("custom");
    expect(spec.accepts_raw_fields).toBe(true);
  });

  it("getProvider throws for an unknown provider", async () => {
    const { getProvider } = await import("../src/providers.js");
    expect(() => getProvider("nonexistent")).toThrow(/unknown provider/);
  });

  it("getModel returns the model entry for voyage-code-3", async () => {
    const { getModel } = await import("../src/providers.js");
    const model = getModel("voyage", "voyage-code-3");
    expect(model.dim).toBe(1024);
    expect(model.profile).toBe("code");
  });

  it("getModel returns the model entry for openai text-embedding-3-small", async () => {
    const { getModel } = await import("../src/providers.js");
    const model = getModel("openai", "text-embedding-3-small");
    expect(model.dim).toBe(1536);
    expect(model.configurable_dim).toBe(true);
  });

  it("getModel throws for an unknown model", async () => {
    const { getModel } = await import("../src/providers.js");
    expect(() => getModel("voyage", "nonexistent-model")).toThrow(/not found in provider/);
  });

  it("getModel throws when the provider is unknown", async () => {
    const { getModel } = await import("../src/providers.js");
    expect(() => getModel("nonexistent", "some-model")).toThrow(/unknown provider/);
  });
});

// ─── 2. ${VAR} resolver ───────────────────────────────────────────────────────

describe("resolveEnvRef", () => {
  it("returns a literal string verbatim (no ${} tokens)", async () => {
    const { resolveEnvRef } = await import("../src/config.js");
    expect(resolveEnvRef("my-api-key-literal")).toBe("my-api-key-literal");
  });

  it("returns an empty string verbatim", async () => {
    const { resolveEnvRef } = await import("../src/config.js");
    expect(resolveEnvRef("")).toBe("");
  });

  it("resolves a ${VAR} token from process.env", async () => {
    process.env["SCRYBE_TEST_VAR_PLAN23"] = "resolved-value";
    try {
      const { resolveEnvRef } = await import("../src/config.js");
      expect(resolveEnvRef("${SCRYBE_TEST_VAR_PLAN23}")).toBe("resolved-value");
    } finally {
      delete process.env["SCRYBE_TEST_VAR_PLAN23"];
    }
  });

  it("resolves a ${VAR} token embedded in a larger string", async () => {
    process.env["SCRYBE_TEST_VAR_PLAN23"] = "bearer-token";
    try {
      const { resolveEnvRef } = await import("../src/config.js");
      expect(resolveEnvRef("Bearer ${SCRYBE_TEST_VAR_PLAN23}")).toBe("Bearer bearer-token");
    } finally {
      delete process.env["SCRYBE_TEST_VAR_PLAN23"];
    }
  });

  it("throws when the referenced env var is missing", async () => {
    delete process.env["SCRYBE_TEST_MISSING_VAR_PLAN23"];
    const { resolveEnvRef } = await import("../src/config.js");
    expect(() => resolveEnvRef("${SCRYBE_TEST_MISSING_VAR_PLAN23}")).toThrow(
      /env var SCRYBE_TEST_MISSING_VAR_PLAN23 not set/
    );
  });

  it("throws naming the first missing var when multiple are present", async () => {
    delete process.env["SCRYBE_TEST_MISSING_A"];
    delete process.env["SCRYBE_TEST_MISSING_B"];
    const { resolveEnvRef } = await import("../src/config.js");
    expect(() => resolveEnvRef("${SCRYBE_TEST_MISSING_A} ${SCRYBE_TEST_MISSING_B}")).toThrow(
      /env var SCRYBE_TEST_MISSING_A not set/
    );
  });
});

// ─── 3. Sidecar round-trip ────────────────────────────────────────────────────

describe("writeTableMeta read-modify-write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-meta-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    // Sidecar lives under <DATA_DIR>/lancedb/
    mkdirSync(join(dir, "lancedb"), { recursive: true });
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("preserves Plan-47 fields when Plan-23 fields are merged in", async () => {
    const { writeTableMeta, readTableMeta } = await import("../src/vector-store.js");

    // Simulate Plan-47 writing chunk-id-scheme fields
    writeTableMeta("test_table", {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
    });

    // Simulate Plan-23 writing model-provenance fields on top
    writeTableMeta("test_table", {
      model: "voyage-code-3",
      dim: 1024,
      provider: "voyage",
      preset_at_index_time: "voyage-code",
      indexed_at: "2026-05-09T00:00:00.000Z",
    });

    const meta = readTableMeta("test_table");
    expect(meta).not.toBeNull();

    // Plan-47 fields must survive
    expect(meta!["chunk_id_scheme"]).toBe(2);
    expect(meta!["chunk_id_scheme_introduced_in"]).toBe("0.31.0");

    // Plan-23 fields must be present
    expect(meta!["model"]).toBe("voyage-code-3");
    expect(meta!["dim"]).toBe(1024);
    expect(meta!["provider"]).toBe("voyage");
    expect(meta!["preset_at_index_time"]).toBe("voyage-code");
    expect(meta!["indexed_at"]).toBe("2026-05-09T00:00:00.000Z");
  });

  it("creates the sidecar if none exists", async () => {
    const { writeTableMeta, readTableMeta } = await import("../src/vector-store.js");

    writeTableMeta("fresh_table", { chunk_id_scheme: 2, chunk_id_scheme_introduced_in: "0.31.0" });
    const meta = readTableMeta("fresh_table");

    expect(meta).not.toBeNull();
    expect(meta!["chunk_id_scheme"]).toBe(2);
  });

  it("supplied fields win on key collision", async () => {
    const { writeTableMeta, readTableMeta } = await import("../src/vector-store.js");

    writeTableMeta("collision_table", { chunk_id_scheme: 1 });
    writeTableMeta("collision_table", { chunk_id_scheme: 2, chunk_id_scheme_introduced_in: "0.31.0" });

    const meta = readTableMeta("collision_table");
    expect(meta!["chunk_id_scheme"]).toBe(2);
    expect(meta!["chunk_id_scheme_introduced_in"]).toBe("0.31.0");
  });
});

// ─── 4. dropAndRecreateTable ──────────────────────────────────────────────────

describe("dropAndRecreateTable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-drop-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(async () => {
    delete process.env["SCRYBE_DATA_DIR"];
    // Allow LanceDB to release file handles before cleanup
    await new Promise((r) => setTimeout(r, 150));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("drops + recreates a Lance table and writes sidecar fields", async () => {
    const { dropAndRecreateTable, readTableMeta, makeSchema } = await import("../src/vector-store.js");

    const tableName = "drop_recreate_test";
    const schema = makeSchema(384);

    await dropAndRecreateTable(tableName, schema, {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      model: "Xenova/multilingual-e5-small",
      dim: 384,
      provider: "local",
    });

    // The table should exist (LanceDB dir created)
    const lanceDir = join(dir, "lancedb", `${tableName}.lance`);
    expect(existsSync(lanceDir)).toBe(true);

    // Sidecar must contain all supplied fields
    const meta = readTableMeta(tableName);
    expect(meta).not.toBeNull();
    expect(meta!["chunk_id_scheme"]).toBe(2);
    expect(meta!["model"]).toBe("Xenova/multilingual-e5-small");
    expect(meta!["provider"]).toBe("local");
  });

  it("can be called on a non-existent table (no prior table)", async () => {
    const { dropAndRecreateTable, readTableMeta, makeSchema } = await import("../src/vector-store.js");

    await dropAndRecreateTable("nonexistent_before", makeSchema(384), {
      chunk_id_scheme: 2,
    });

    const meta = readTableMeta("nonexistent_before");
    expect(meta!["chunk_id_scheme"]).toBe(2);
  });

  it("preserves pre-existing sidecar fields not in the supplied set", async () => {
    const { dropAndRecreateTable, writeTableMeta, readTableMeta, makeSchema } = await import(
      "../src/vector-store.js"
    );

    const lanceDbDir = join(dir, "lancedb");
    mkdirSync(lanceDbDir, { recursive: true });

    // Write an existing sidecar before drop-recreate
    writeTableMeta("preserve_test", {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      some_other_field: "keep-me",
    });

    await dropAndRecreateTable("preserve_test", makeSchema(384), {
      model: "voyage-code-3",
      dim: 1024,
      provider: "voyage",
    });

    const meta = readTableMeta("preserve_test");
    // Plan-47 fields survive because dropAndRecreateTable uses writeTableMeta (read-modify-write)
    expect(meta!["chunk_id_scheme"]).toBe(2);
    expect(meta!["some_other_field"]).toBe("keep-me");
    // New Plan-23 fields also present
    expect(meta!["model"]).toBe("voyage-code-3");
  });
});
