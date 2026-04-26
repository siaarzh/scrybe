/**
 * Integration test for Fix 1 — remove → re-add → --full reindex no-op.
 *
 * Before Fix 1:
 *   1. removeProject dropped the LanceDB table but left branch_tags + hash files.
 *   2. On re-add + --full, BranchSessionImpl snapshotted stale knownChunkIds from
 *      the orphaned branch_tags rows.
 *   3. flushBatch saw all chunk_ids as "known" → toEmbed was empty → LanceDB
 *      was never written → search returned 0 results despite exit 0.
 *
 * After Fix 1:
 *   - wipeSource clears branch_tags + hash files on removeProject/removeSource.
 *   - Full-mode session always starts with empty knownChunkIds.
 *   - Result: search returns hits after remove → re-add → full reindex.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { sidecar } from "./helpers/sidecar.js";

describe("remove → re-add → full reindex (Fix 1 integration)", () => {
  let fixture: FixtureHandle | null = null;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = null;
  });

  it("search returns hits after project is removed and re-added with --full", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");

    const { addProject, addSource, removeProject } = await import("../src/registry.js");

    const projectId = "test-readd-fix1";
    const sourceId = "primary";

    // ── Step 1: register + index ──────────────────────────────────────────────
    addProject({ id: projectId, description: "Fix 1 test" });
    addSource(projectId, {
      source_id: sourceId,
      source_config: { type: "code", root_path: fixture.path, languages: ["ts"] },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: sidecar.dimensions,
        api_key_env: "EMBEDDING_API_KEY",
      },
    });
    const first = await runIndex(projectId, sourceId, "full");
    expect(first.chunks_indexed).toBeGreaterThan(0);

    const hitsBefore = await search(projectId, "alphaGreeting");
    expect(hitsBefore.length).toBeGreaterThan(0);

    // ── Step 2: remove project ────────────────────────────────────────────────
    await removeProject(projectId);

    // ── Step 3: re-add with same ID + source ─────────────────────────────────
    addProject({ id: projectId, description: "Fix 1 test (re-added)" });
    addSource(projectId, {
      source_id: sourceId,
      source_config: { type: "code", root_path: fixture.path, languages: ["ts"] },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: sidecar.dimensions,
        api_key_env: "EMBEDDING_API_KEY",
      },
    });

    // ── Step 4: full reindex must write chunks ────────────────────────────────
    const second = await runIndex(projectId, sourceId, "full");
    expect(second.chunks_indexed).toBeGreaterThan(0);
    expect(second.files_reindexed).toBeGreaterThan(0);

    // ── Step 5: search must return hits ──────────────────────────────────────
    const hitsAfter = await search(projectId, "alphaGreeting");
    expect(hitsAfter.length).toBeGreaterThan(0);

    // ── Cleanup ───────────────────────────────────────────────────────────────
    await removeProject(projectId);
  });

  it("branch_tags and hash files are empty after removeProject", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");

    const { addProject, addSource, removeProject } = await import("../src/registry.js");
    const { getAllChunkIdsForSource, wipeSource: _wipeSource } = await import("../src/branch-state.js");
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { config } = await import("../src/config.js");

    const projectId = "test-wipe-check";
    const sourceId = "primary";

    addProject({ id: projectId, description: "wipe check" });
    addSource(projectId, {
      source_id: sourceId,
      source_config: { type: "code", root_path: fixture.path, languages: ["ts"] },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: sidecar.dimensions,
        api_key_env: "EMBEDDING_API_KEY",
      },
    });

    await runIndex(projectId, sourceId, "full");

    // Verify tags exist before removal
    expect(getAllChunkIdsForSource(projectId, sourceId).size).toBeGreaterThan(0);

    await removeProject(projectId);

    // After removal: branch_tags must be empty for this source
    expect(getAllChunkIdsForSource(projectId, sourceId).size).toBe(0);

    // After removal: hash files must be gone
    const hashesDir = join(config.dataDir, "hashes");
    const prefix = `${projectId}__${sourceId}__`;
    const remaining = existsSync(hashesDir)
      ? readdirSync(hashesDir).filter((f) => f.startsWith(prefix))
      : [];
    expect(remaining).toHaveLength(0);
  });
});
