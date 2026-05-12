/**
 * Slice 2 of Plan 23 — Preset resolver + registry rewire.
 *
 * Covers:
 *   1. Resolver — catalog preset (voyage-code-3) → dim=1024, base_url from catalog
 *   2. Resolver — Custom preset → dim/base_url from preset itself
 *   3. Resolver — credentials_from reuses target preset's credentials
 *   4. Resolver — credentials_from chain > 1 → throws
 *   5. Resolver — cross-profile rejection (text-profile model in code slot) → throws
 *   6. flags — matched sidecar stamp → no model_mismatch
 *   7. flags — mismatched sidecar stamp → has model_mismatch
 *   8. flags — preset RENAMED, same (model, dim, provider) triple → no model_mismatch
 *   9. flags — pre-migration sidecar (no model fields) → no model_mismatch
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Minimal valid ScrybeConfig fixture. */
function makeConfig(overrides: Partial<import("../src/config.js").ScrybeConfig> = {}): import("../src/config.js").ScrybeConfig {
  return {
    schema_version: 1,
    embedding_presets: {
      "voyage-code": {
        provider: "voyage",
        model: "voyage-code-3",
        credentials: "${SCRYBE_VOYAGE_API_KEY}",
      },
      "voyage-text": {
        provider: "voyage",
        model: "voyage-3",
        credentials: "${SCRYBE_VOYAGE_API_KEY}",
      },
      "voyage-rerank": {
        provider: "voyage",
        model: "rerank-2.5",
        credentials_from: "voyage-code",
      },
    },
    reranker_presets: {
      "voyage-rerank": {
        provider: "voyage",
        model: "rerank-2.5",
        credentials_from: "voyage-code",
      },
    },
    assignments: {
      code_preset: "voyage-code",
      text_preset: "voyage-text",
    },
    ...overrides,
  };
}

// ─── 1. Resolver — catalog preset ────────────────────────────────────────────

describe("resolvePreset — catalog preset", () => {
  it("voyage-code-3 resolves to dim=1024 and voyage base_url", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-voyage-key";
    try {
      const { resolvePreset } = await import("../src/preset-resolver.js");
      const cfg = makeConfig();
      const result = resolvePreset("voyage-code", "code_preset", cfg);
      expect(result.provider).toBe("voyage");
      expect(result.model).toBe("voyage-code-3");
      expect(result.dim).toBe(1024);
      expect(result.base_url).toBe("https://api.voyageai.com/v1");
      expect(result.profile).toBe("code");
      expect(result.credentials).toBe("test-voyage-key");
    } finally {
      delete process.env["SCRYBE_VOYAGE_API_KEY"];
    }
  });

  it("voyage-3 text preset resolves correctly", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-voyage-key-2";
    try {
      const { resolvePreset } = await import("../src/preset-resolver.js");
      const cfg = makeConfig();
      const result = resolvePreset("voyage-text", "text_preset", cfg);
      expect(result.model).toBe("voyage-3");
      expect(result.dim).toBe(1024);
      expect(result.profile).toBe("text");
    } finally {
      delete process.env["SCRYBE_VOYAGE_API_KEY"];
    }
  });
});

// ─── 2. Resolver — Custom preset ─────────────────────────────────────────────

describe("resolvePreset — Custom preset", () => {
  it("custom preset uses dim and base_url from preset itself", async () => {
    process.env["SCRYBE_TOGETHER_API_KEY"] = "together-key";
    try {
      const { resolvePreset } = await import("../src/preset-resolver.js");
      const cfg = makeConfig({
        embedding_presets: {
          ...makeConfig().embedding_presets,
          "together-bert": {
            provider: "custom",
            model: "togethercomputer/m2-bert-80M-8k-retrieval",
            credentials: "${SCRYBE_TOGETHER_API_KEY}",
            base_url: "https://api.together.xyz/v1",
            dim: 768,
          },
        },
        assignments: {
          code_preset: "together-bert",
          text_preset: "voyage-text",
        },
      });
      const result = resolvePreset("together-bert", "code_preset", cfg);
      expect(result.provider).toBe("custom");
      expect(result.model).toBe("togethercomputer/m2-bert-80M-8k-retrieval");
      expect(result.dim).toBe(768);
      expect(result.base_url).toBe("https://api.together.xyz/v1");
      expect(result.credentials).toBe("together-key");
    } finally {
      delete process.env["SCRYBE_TOGETHER_API_KEY"];
    }
  });

  it("custom preset assigned to text slot gets text profile", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const cfg = makeConfig({
      embedding_presets: {
        ...makeConfig().embedding_presets,
        "custom-text": {
          provider: "custom",
          model: "some-model",
          base_url: "https://example.com/v1",
          dim: 512,
        },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "custom-text",
      },
    });
    const result = resolvePreset("custom-text", "text_preset", cfg);
    expect(result.profile).toBe("text");
  });

  it("custom preset missing dim throws", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const cfg = makeConfig({
      embedding_presets: {
        ...makeConfig().embedding_presets,
        "custom-nodim": {
          provider: "custom",
          model: "some-model",
          base_url: "https://example.com/v1",
          // dim intentionally absent
        },
      },
      assignments: {
        code_preset: "custom-nodim",
        text_preset: "voyage-text",
      },
    });
    expect(() => resolvePreset("custom-nodim", "code_preset", cfg)).toThrow(/missing required field "dim"/);
  });

  it("custom preset missing base_url throws", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const cfg = makeConfig({
      embedding_presets: {
        ...makeConfig().embedding_presets,
        "custom-nourl": {
          provider: "custom",
          model: "some-model",
          dim: 512,
          // base_url intentionally absent
        },
      },
      assignments: {
        code_preset: "custom-nourl",
        text_preset: "voyage-text",
      },
    });
    expect(() => resolvePreset("custom-nourl", "code_preset", cfg)).toThrow(/missing required field "base_url"/);
  });
});

// ─── 3. Resolver — credentials_from indirection ───────────────────────────────

describe("resolvePreset — credentials_from", () => {
  it("reuses target preset credentials (one level)", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "shared-voyage-cred";
    try {
      const { resolvePreset } = await import("../src/preset-resolver.js");
      const cfg: import("../src/config.js").ScrybeConfig = {
        schema_version: 1,
        embedding_presets: {
          "voyage-code": {
            provider: "voyage",
            model: "voyage-code-3",
            credentials: "${SCRYBE_VOYAGE_API_KEY}",
          },
          "voyage-text": {
            provider: "voyage",
            model: "voyage-3",
            credentials_from: "voyage-code",
          },
        },
        assignments: {
          code_preset: "voyage-code",
          text_preset: "voyage-text",
        },
      };
      const result = resolvePreset("voyage-text", "text_preset", cfg);
      // Should have resolved the credentials via voyage-code's credentials field
      expect(result.credentials).toBe("shared-voyage-cred");
    } finally {
      delete process.env["SCRYBE_VOYAGE_API_KEY"];
    }
  });

  it("credentials_from references a non-existent preset → throws", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const cfg: import("../src/config.js").ScrybeConfig = {
      schema_version: 1,
      embedding_presets: {
        "voyage-text": {
          provider: "voyage",
          model: "voyage-3",
          credentials_from: "nonexistent",
        },
      },
      assignments: {
        code_preset: "voyage-text",
        text_preset: "voyage-text",
      },
    };
    // Use text_preset slot so profile check passes (voyage-3 is "text"), then credentials_from throws
    expect(() => resolvePreset("voyage-text", "text_preset", cfg)).toThrow(/does not exist/);
  });
});

// ─── 4. Resolver — credentials_from chain > 1 → throws ───────────────────────

describe("resolvePreset — credentials_from chain depth", () => {
  it("chain of depth 2 throws", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const cfg: import("../src/config.js").ScrybeConfig = {
      schema_version: 1,
      embedding_presets: {
        "root": {
          provider: "voyage",
          model: "voyage-code-3",
          credentials: "${SCRYBE_VOYAGE_API_KEY}",
        },
        "mid": {
          provider: "voyage",
          model: "voyage-3",
          credentials_from: "root",
        },
        "leaf": {
          provider: "voyage",
          model: "voyage-3",
          // Tries to chain through mid → root
          credentials_from: "mid",
        },
      },
      assignments: {
        code_preset: "root",
        text_preset: "leaf",
      },
    };
    expect(() => resolvePreset("leaf", "text_preset", cfg)).toThrow(
      /credentials_from chains deeper than 1 level are not supported/,
    );
  });
});

// ─── 5. Resolver — cross-profile rejection ────────────────────────────────────

describe("resolvePreset — cross-profile rejection", () => {
  it("text-profile model assigned to code_preset slot throws", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    // voyage-3 is profile:"text" — assigning to code_preset must throw
    const cfg = makeConfig({
      assignments: {
        code_preset: "voyage-text", // voyage-text uses voyage-3, profile:"text"
        text_preset: "voyage-text",
      },
    });
    expect(() => resolvePreset("voyage-text", "code_preset", cfg)).toThrow(
      /profile "text".*slot "code_preset".*requires profile "code"/,
    );
  });

  it("code-profile model assigned to text_preset slot throws", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    // voyage-code-3 is profile:"code" — assigning to text_preset must throw
    const cfg = makeConfig({
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-code", // voyage-code uses voyage-code-3, profile:"code"
      },
    });
    expect(() => resolvePreset("voyage-code", "text_preset", cfg)).toThrow(
      /profile "code".*slot "text_preset".*requires profile "text"/,
    );
  });

  it("custom preset is profile-agnostic — no rejection regardless of slot", async () => {
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const cfg = makeConfig({
      embedding_presets: {
        ...makeConfig().embedding_presets,
        "custom-any": {
          provider: "custom",
          model: "any-model",
          base_url: "https://example.com/v1",
          dim: 512,
        },
      },
      assignments: {
        code_preset: "custom-any",
        text_preset: "voyage-text",
      },
    });
    // Should not throw for either slot
    expect(() => resolvePreset("custom-any", "code_preset", cfg)).not.toThrow();
    expect(() => resolvePreset("custom-any", "text_preset", cfg)).not.toThrow();
  });
});

// ─── 6–9. flags — model_mismatch ─────────────────────────────────────────────

describe("model_mismatch flag detection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s2-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    mkdirSync(join(dir, "lancedb"), { recursive: true });
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_VOYAGE_API_KEY"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Write a config.json to DATA_DIR. */
  function writeConfig(cfg: import("../src/config.js").ScrybeConfig) {
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  /** Write a sidecar directly to lancedb/<tableName>-meta.json. */
  function writeSidecar(tableName: string, fields: Record<string, unknown>) {
    writeFileSync(
      join(dir, "lancedb", `${tableName}-meta.json`),
      JSON.stringify(fields, null, 2) + "\n",
      "utf8",
    );
  }

  /**
   * Directly call the comparison logic mirroring what cli.ts ps does.
   * Returns true if model_mismatch would be flagged.
   */
  async function checkMismatch(
    tableName: string,
    presetName: string,
    slot: "code_preset" | "text_preset",
  ): Promise<boolean> {
    const { readTableMeta } = await import("../src/vector-store.js");
    const { readScrybeConfig } = await import("../src/config.js");
    const { resolvePreset } = await import("../src/preset-resolver.js");

    const scrybeConfig = readScrybeConfig();
    if (!scrybeConfig) return false;

    const sidecar = readTableMeta(tableName);
    if (!sidecar) return false;
    if (typeof sidecar["model"] !== "string" || typeof sidecar["dim"] !== "number" || typeof sidecar["provider"] !== "string") {
      return false; // pre-migration sidecar — no flag
    }

    const resolved = resolvePreset(presetName, slot, scrybeConfig);
    return !(sidecar["model"] === resolved.model && sidecar["dim"] === resolved.dim && sidecar["provider"] === resolved.provider);
  }

  it("6: matched stamp → no model_mismatch", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    writeConfig(makeConfig());
    writeSidecar("test_table", {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      model: "voyage-code-3",
      dim: 1024,
      provider: "voyage",
      preset_at_index_time: "voyage-code",
      indexed_at: "2026-05-09T00:00:00.000Z",
    });

    const mismatch = await checkMismatch("test_table", "voyage-code", "code_preset");
    expect(mismatch).toBe(false);
  });

  it("7: mismatched stamp → has model_mismatch", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    writeConfig(makeConfig());
    writeSidecar("test_table_mm", {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      // Was indexed with openai, but current preset is voyage
      model: "text-embedding-3-small",
      dim: 1536,
      provider: "openai",
      preset_at_index_time: "old-openai",
      indexed_at: "2026-05-01T00:00:00.000Z",
    });

    const mismatch = await checkMismatch("test_table_mm", "voyage-code", "code_preset");
    expect(mismatch).toBe(true);
  });

  it("8: preset RENAMED with same (model, dim, provider) → no model_mismatch", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    // New preset name "voyage-code-v2" points to the same underlying model
    const cfg = makeConfig({
      embedding_presets: {
        "voyage-code": {
          provider: "voyage",
          model: "voyage-code-3",
          credentials: "${SCRYBE_VOYAGE_API_KEY}",
        },
        "voyage-code-v2": {
          provider: "voyage",
          model: "voyage-code-3", // same model!
          credentials: "${SCRYBE_VOYAGE_API_KEY}",
        },
        "voyage-text": makeConfig().embedding_presets["voyage-text"],
      },
      assignments: {
        code_preset: "voyage-code-v2", // renamed preset
        text_preset: "voyage-text",
      },
    });
    writeConfig(cfg);
    writeSidecar("test_table_rename", {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      model: "voyage-code-3",
      dim: 1024,
      provider: "voyage",
      preset_at_index_time: "voyage-code", // old preset name
      indexed_at: "2026-05-09T00:00:00.000Z",
    });

    // Comparison is by triple, not by preset name — must NOT flag
    const mismatch = await checkMismatch("test_table_rename", "voyage-code-v2", "code_preset");
    expect(mismatch).toBe(false);
  });

  it("9: pre-migration sidecar (no model fields) → no model_mismatch", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    writeConfig(makeConfig());
    writeSidecar("test_table_premig", {
      // Plan-47 fields only — no model/dim/provider
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
    });

    const mismatch = await checkMismatch("test_table_premig", "voyage-code", "code_preset");
    expect(mismatch).toBe(false);
  });

  it("9b: sidecar with only partial model fields (missing dim) → no model_mismatch", async () => {
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    writeConfig(makeConfig());
    writeSidecar("test_table_partial", {
      chunk_id_scheme: 2,
      model: "voyage-code-3",
      // dim intentionally absent
      provider: "voyage",
    });

    const mismatch = await checkMismatch("test_table_partial", "voyage-code", "code_preset");
    expect(mismatch).toBe(false);
  });
});
