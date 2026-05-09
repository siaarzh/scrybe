/**
 * Slice 3 of Plan 23 — `scrybe model` CLI.
 *
 * Covers:
 *   1. `model list` output contains all 4 catalog providers + at least one model each.
 *   2. `preset add` round-trip: writes config.json, `readScrybeConfig` returns the new preset.
 *   3. `preset add` rejects --base-url for catalog provider.
 *   4. `preset add` requires --base-url for custom provider.
 *   5. `preset rm` rejects when preset is assigned.
 *   6. `preset rm` rejects when another preset references via credentials_from.
 *   7. `assign --code` cross-profile rejection: text-profile model in code_preset slot throws.
 *   8. `assign --rerank none` clears the rerank slot.
 *   9. `switch` end-to-end on a synthetic source: sidecar stamped, model_mismatch clears.
 *   10. Restart-MCP advice present in `switch` post-completion output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal valid ScrybeConfig written to DATA_DIR/config.json. */
function writeConfig(
  dir: string,
  overrides: Partial<import("../src/config.js").ScrybeConfig> = {}
): void {
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
        credentials: "${SCRYBE_VOYAGE_API_KEY}",
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
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Read raw config.json from dir. */
function readConfig(dir: string): import("../src/config.js").ScrybeConfig {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as import("../src/config.js").ScrybeConfig;
}

// ─── 1. model list — catalog providers present ────────────────────────────────

describe("printCatalogList", () => {
  it("contains all 4 catalog providers", async () => {
    const { printCatalogList } = await import("../src/tools/model.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      printCatalogList();
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    expect(output).toMatch(/voyage/i);
    expect(output).toMatch(/openai/i);
    expect(output).toMatch(/local/i);
    expect(output).toMatch(/custom/i);
  });

  it("contains at least one model for voyage and openai", async () => {
    const { printCatalogList } = await import("../src/tools/model.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      printCatalogList();
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    expect(output).toMatch(/voyage-code-3/);
    expect(output).toMatch(/text-embedding-3-small/);
  });
});

// ─── 2. preset add — round-trip ───────────────────────────────────────────────

describe("preset add — round-trip", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("adds preset to new config.json and readScrybeConfig returns it", async () => {
    const { runPresetAdd } = await import("../src/tools/model.js");
    const { readScrybeConfig } = await import("../src/config.js");

    // No config.json yet
    expect(existsSync(join(dir, "config.json"))).toBe(false);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      runPresetAdd({
        name: "voyage-code",
        provider: "voyage",
        model: "voyage-code-3",
        credentials: "${SCRYBE_VOYAGE_API_KEY}",
      });
    } finally {
      console.log = origLog;
    }

    // Config should now exist
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    const cfg = readScrybeConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.embedding_presets["voyage-code"]).toMatchObject({
      provider: "voyage",
      model: "voyage-code-3",
      credentials: "${SCRYBE_VOYAGE_API_KEY}",
    });
    expect(logs.some((l) => l.includes("voyage-code"))).toBe(true);
  });

  it("adds custom preset with base_url and dim", async () => {
    const { runPresetAdd } = await import("../src/tools/model.js");
    const { readScrybeConfig } = await import("../src/config.js");

    const origLog = console.log;
    console.log = () => {};
    try {
      runPresetAdd({
        name: "together-bert",
        provider: "custom",
        model: "togethercomputer/m2-bert",
        credentials: "${SCRYBE_TOGETHER_API_KEY}",
        baseUrl: "https://api.together.xyz/v1",
        dim: 768,
      });
    } finally {
      console.log = origLog;
    }

    const cfg = readScrybeConfig();
    expect(cfg!.embedding_presets["together-bert"]).toMatchObject({
      provider: "custom",
      model: "togethercomputer/m2-bert",
      base_url: "https://api.together.xyz/v1",
      dim: 768,
    });
  });
});

// ─── 3. preset add — rejects --base-url for catalog provider ─────────────────

describe("preset add — catalog provider rejects --base-url", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("throws when --base-url is supplied for voyage (catalog provider)", async () => {
    const { runPresetAdd } = await import("../src/tools/model.js");
    expect(() =>
      runPresetAdd({
        name: "voyage-bad",
        provider: "voyage",
        model: "voyage-code-3",
        baseUrl: "https://custom-voyage.example.com/v1",
      })
    ).toThrow(/only valid for custom providers/);
  });

  it("throws when --dim is supplied for openai (catalog provider)", async () => {
    const { runPresetAdd } = await import("../src/tools/model.js");
    expect(() =>
      runPresetAdd({
        name: "openai-bad",
        provider: "openai",
        model: "text-embedding-3-small",
        dim: 512,
      })
    ).toThrow(/only valid for custom providers/);
  });
});

// ─── 4. preset add — requires --base-url for custom ──────────────────────────

describe("preset add — custom provider requires --base-url", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("throws when --base-url is missing for custom provider", async () => {
    const { runPresetAdd } = await import("../src/tools/model.js");
    expect(() =>
      runPresetAdd({
        name: "custom-no-url",
        provider: "custom",
        model: "some-model",
        dim: 768,
        // baseUrl intentionally absent
      })
    ).toThrow(/--base-url is required/);
  });

  it("throws when --dim is missing for custom provider", async () => {
    const { runPresetAdd } = await import("../src/tools/model.js");
    expect(() =>
      runPresetAdd({
        name: "custom-no-dim",
        provider: "custom",
        model: "some-model",
        baseUrl: "https://api.example.com/v1",
        // dim intentionally absent
      })
    ).toThrow(/--dim is required/);
  });
});

// ─── 5. preset rm — rejects when assigned ────────────────────────────────────

describe("preset rm — assigned preset rejection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    // Write config with voyage-code assigned to code_preset
    writeConfig(dir);
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("throws when preset is assigned to code_preset", async () => {
    const { runPresetRm } = await import("../src/tools/model.js");
    expect(() => runPresetRm("voyage-code")).toThrow(/currently assigned/);
  });

  it("throws when preset is assigned to text_preset", async () => {
    const { runPresetRm } = await import("../src/tools/model.js");
    expect(() => runPresetRm("voyage-text")).toThrow(/currently assigned/);
  });

  it("succeeds when preset is not assigned and not referenced", async () => {
    // Add an unassigned preset
    const { runPresetAdd, runPresetRm } = await import("../src/tools/model.js");

    const origLog = console.log;
    console.log = () => {};
    try {
      runPresetAdd({
        name: "unused-preset",
        provider: "voyage",
        model: "voyage-3-large",
      });
    } finally {
      console.log = origLog;
    }

    // Should succeed
    const logs: string[] = [];
    const origLog2 = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      runPresetRm("unused-preset");
    } finally {
      console.log = origLog2;
    }

    const cfg = readConfig(dir);
    expect("unused-preset" in cfg.embedding_presets).toBe(false);
    expect(logs.some((l) => l.includes("removed"))).toBe(true);
  });
});

// ─── 6. preset rm — rejects when referenced by credentials_from ──────────────

describe("preset rm — credentials_from reference rejection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    // Write config where voyage-code is referenced by voyage-text via credentials_from
    const cfg: import("../src/config.js").ScrybeConfig = {
      schema_version: 1,
      embedding_presets: {
        "voyage-code": {
          provider: "voyage",
          model: "voyage-code-3",
          credentials: "${SCRYBE_VOYAGE_API_KEY}",
        },
        "voyage-text-via-from": {
          provider: "voyage",
          model: "voyage-3",
          credentials_from: "voyage-code",
        },
      },
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-text-via-from",
      },
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("trying to rm the source preset throws (it's also assigned, so double guard)", async () => {
    const { runPresetRm } = await import("../src/tools/model.js");
    // voyage-code is assigned AND referenced — should throw
    expect(() => runPresetRm("voyage-code")).toThrow();
  });

  it("an unassigned preset referenced by credentials_from cannot be removed", async () => {
    const { runPresetAdd, runPresetRm } = await import("../src/tools/model.js");

    // Add a third preset that references voyage-code via credentials_from but is NOT assigned
    const origLog = console.log;
    console.log = () => {};
    try {
      runPresetAdd({
        name: "voyage-code-2",
        provider: "voyage",
        model: "voyage-code-3",
        credentials: "${SCRYBE_VOYAGE_API_KEY}",
      });
    } finally {
      console.log = origLog;
    }

    // Update config so voyage-text-via-from2 references voyage-code-2
    const cfg = readConfig(dir);
    cfg.embedding_presets["voyage-text-via-from2"] = {
      provider: "voyage",
      model: "voyage-3",
      credentials_from: "voyage-code-2",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");

    // voyage-code-2 is not assigned, but is referenced by credentials_from → should throw
    expect(() => runPresetRm("voyage-code-2")).toThrow(/referenced via credentials_from/);
  });
});

// ─── 7. assign — cross-profile rejection ─────────────────────────────────────

describe("assign — cross-profile rejection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    writeConfig(dir);
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_VOYAGE_API_KEY"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("assigning voyage-3 (text profile) to code_preset slot throws cross-profile error", async () => {
    const { runAssign } = await import("../src/tools/model.js");
    // voyage-text uses voyage-3 which has profile "text"
    expect(() => runAssign({ code: "voyage-text" })).toThrow(/profile.*text.*code/i);
  });

  it("assigning voyage-code-3 (code profile) to code_preset slot succeeds", async () => {
    const { runAssign } = await import("../src/tools/model.js");
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(() => runAssign({ code: "voyage-code" })).not.toThrow();
    } finally {
      console.log = origLog;
    }
  });
});

// ─── 8. assign --rerank none — clears the slot ───────────────────────────────

describe("assign --rerank none", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    // Write config with a rerank preset assigned
    writeConfig(dir, {
      assignments: {
        code_preset: "voyage-code",
        text_preset: "voyage-text",
        rerank_preset: "voyage-rerank",
      },
    });
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_VOYAGE_API_KEY"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("clears rerank_preset from assignments", async () => {
    const { runAssign } = await import("../src/tools/model.js");
    const origLog = console.log;
    console.log = () => {};
    try {
      runAssign({ rerank: "none" });
    } finally {
      console.log = origLog;
    }

    const { readScrybeConfig } = await import("../src/config.js");
    const cfg = readScrybeConfig();
    expect(cfg!.assignments.rerank_preset).toBeUndefined();
  });
});

// ─── 9 + 10. switch end-to-end + restart-MCP advice ─────────────────────────

describe("model switch — end-to-end on synthetic source", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-plan23-s3-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
    process.env["SCRYBE_VOYAGE_API_KEY"] = "test-key";
    mkdirSync(join(dir, "lancedb"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["SCRYBE_DATA_DIR"];
    delete process.env["SCRYBE_VOYAGE_API_KEY"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Writes a minimal projects.json so listProjects() returns one code source.
   */
  function writeProjectsJson(tableName: string) {
    const projects = [
      {
        id: "test-project",
        description: "Test project",
        sources: [
          {
            source_id: "primary",
            source_config: {
              type: "code",
              root_path: dir,
              languages: ["ts"],
            },
            table_name: tableName,
            last_indexed: null,
          },
        ],
      },
    ];
    writeFileSync(join(dir, "projects.json"), JSON.stringify(projects, null, 2) + "\n", "utf8");
  }

  it("stamps sidecar with resolved preset fields and clears model_mismatch", async () => {
    const tableName = "test-project_primary";
    writeProjectsJson(tableName);

    // Write an OLD sidecar (mismatched model — openai instead of voyage)
    const oldSidecar = {
      chunk_id_scheme: 2,
      chunk_id_scheme_introduced_in: "0.31.0",
      model: "text-embedding-3-small",
      dim: 1536,
      provider: "openai",
      preset_at_index_time: "old-openai",
      indexed_at: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      join(dir, "lancedb", `${tableName}-meta.json`),
      JSON.stringify(oldSidecar, null, 2) + "\n",
      "utf8"
    );

    // Write config.json with voyage-code assigned
    writeConfig(dir);

    // Mock indexSource to avoid actually running the indexer
    const indexerModule = await import("../src/indexer.js");
    vi.spyOn(indexerModule, "indexSource").mockResolvedValue({
      chunks_prepared: 10,
      files_reindexed: 3,
      files_removed: 0,
    } as any);

    const { runSwitch } = await import("../src/tools/model.js");

    const logs: string[] = [];
    const origLog = console.log;
    const origWrite = process.stdout.write.bind(process.stdout);
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.stdout.write = (chunk: any, ...rest: any[]) => { logs.push(String(chunk)); return origWrite(chunk, ...rest); };

    try {
      await runSwitch("code", { yes: true });
    } finally {
      console.log = origLog;
      process.stdout.write = origWrite;
    }

    // Verify indexSource was called
    expect(indexerModule.indexSource).toHaveBeenCalledWith("test-project", "primary", "full", expect.any(Object));

    // Verify sidecar was updated with voyage model fields
    const { readTableMeta } = await import("../src/vector-store.js");
    const sidecar = readTableMeta(tableName);
    expect(sidecar).not.toBeNull();
    expect(sidecar!["model"]).toBe("voyage-code-3");
    expect(sidecar!["dim"]).toBe(1024);
    expect(sidecar!["provider"]).toBe("voyage");
    expect(sidecar!["preset_at_index_time"]).toBe("voyage-code");
    expect(sidecar!["indexed_at"]).toBeTruthy();

    // Verify chunk_id_scheme fields are preserved (read-modify-write)
    expect(sidecar!["chunk_id_scheme"]).toBe(2);
    expect(sidecar!["chunk_id_scheme_introduced_in"]).toBe("0.31.0");

    // Verify model_mismatch would now be clear (sidecar matches resolved preset)
    const { resolvePreset } = await import("../src/preset-resolver.js");
    const { readScrybeConfig } = await import("../src/config.js");
    const cfg = readScrybeConfig()!;
    const resolved = resolvePreset("voyage-code", "code_preset", cfg);
    expect(sidecar!["model"]).toBe(resolved.model);
    expect(sidecar!["dim"]).toBe(resolved.dim);
    expect(sidecar!["provider"]).toBe(resolved.provider);

    // Verify restart-MCP advice present in output
    const outputJoined = logs.join("\n");
    expect(outputJoined).toMatch(/MCP client|restart.*MCP|restart it/i);
  });

  it("10: restart-MCP advice in post-completion output", async () => {
    const tableName = "test-project2_primary";
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify([
        {
          id: "test-project2",
          description: "",
          sources: [
            {
              source_id: "primary",
              source_config: { type: "code", root_path: dir, languages: [] },
              table_name: tableName,
            },
          ],
        },
      ]) + "\n",
      "utf8"
    );
    writeConfig(dir);

    // Ensure a sidecar exists so writeTableMeta works
    writeFileSync(
      join(dir, "lancedb", `${tableName}-meta.json`),
      JSON.stringify({ chunk_id_scheme: 2, chunk_id_scheme_introduced_in: "0.31.0" }) + "\n",
      "utf8"
    );

    const indexerModule = await import("../src/indexer.js");
    vi.spyOn(indexerModule, "indexSource").mockResolvedValue({
      chunks_prepared: 5,
      files_reindexed: 1,
      files_removed: 0,
    } as any);

    const { runSwitch } = await import("../src/tools/model.js");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await runSwitch("code", { yes: true });
    } finally {
      console.log = origLog;
    }

    const outputJoined = logs.join("\n");
    expect(outputJoined).toMatch(/MCP client|restart.*MCP|restart it/i);
    expect(outputJoined).toMatch(/Claude Code|Cline/i);
  });
});
