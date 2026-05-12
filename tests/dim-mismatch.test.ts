/**
 * Dimension handling tests for the preset-resolver-based embedding path.
 *
 * In the preset world, embedding dimensions come from the provider catalog
 * (or from the preset's own `dim` field for custom presets). The old
 * `source.embedding.dimensions` field is no longer read by the registry.
 *
 * The "mismatch" detection scenario (stale table indexed with a different model
 * than the current preset) is now surfaced via the `model_mismatch` flag on
 * `scrybe ps --json` — tested separately in plan23-slice2.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { runIndex } from "./helpers/index-wait.js";

describe("dimension handling via preset resolver", () => {
  let fixture: FixtureHandle | null = null;
  let dir: string;
  let savedDataDir: string | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = null;
    if (savedDataDir === undefined) delete process.env.SCRYBE_DATA_DIR;
    else process.env.SCRYBE_DATA_DIR = savedDataDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("indexing succeeds when the preset's dim matches the local embedder output", async () => {
    fixture = await cloneFixture("sample-repo");

    dir = mkdtempSync(join(tmpdir(), "scrybe-dimmatch-test-"));
    savedDataDir = process.env.SCRYBE_DATA_DIR;
    process.env.SCRYBE_DATA_DIR = dir;

    // Write a config.json that uses the local provider (dim=384, matches local embedder)
    const cfg = {
      schema_version: 1,
      embedding_presets: {
        "local-code": {
          provider: "local",
          model: "Xenova/multilingual-e5-small",
        },
        "local-text": {
          provider: "local",
          model: "Xenova/multilingual-e5-small",
        },
      },
      assignments: {
        code_preset: "local-code",
        text_preset: "local-text",
      },
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");

    const { addProject, addSource } = await import("../src/registry.js");
    const projectId = "test-dim-match";
    addProject({ id: projectId, description: "dim match test" });
    addSource(projectId, {
      source_id: "primary",
      source_config: {
        type: "code",
        root_path: fixture.path,
        languages: ["ts"],
      },
    });

    // Index should succeed — local embedder returns 384d and preset expects 384d
    const result = await runIndex(projectId, "primary", "full");
    expect(result.status).toBe("ok");
    expect(result.chunks_prepared).toBeGreaterThan(0);
  });
});
