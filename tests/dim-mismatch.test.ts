/**
 * Dimension mismatch detection test.
 * Configures a project source with wrong dimensions (1024) while the sidecar
 * returns 384d. Expects the embedder to throw a typed dimension-mismatch error.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { runIndex } from "./helpers/index-wait.js";
import { sidecar } from "./helpers/sidecar.js";

describe("dimension mismatch detection", () => {
  let fixture: FixtureHandle | null = null;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = null;
  });

  it("throws a dimension mismatch error when source dims differ from model output", async () => {
    fixture = await cloneFixture("sample-repo");

    // Register project with WRONG dimensions (1024) but sidecar returns 384
    const { addProject, addSource } = await import("../src/registry.js");
    const projectId = "test-dim-mismatch";
    addProject({ id: projectId, description: "dim mismatch test" });
    addSource(projectId, {
      source_id: "primary",
      source_config: {
        type: "code",
        root_path: fixture.path,
        languages: ["ts"],
      },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: 1024, // wrong — sidecar returns 384
        api_key_env: "EMBEDDING_API_KEY",
      },
    });

    await expect(
      runIndex(projectId, "primary", "full")
    ).rejects.toThrow(/384|1024|dimension/i);
  });
});
