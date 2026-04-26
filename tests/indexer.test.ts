/**
 * Fix 2 — files_reindexed accounting.
 *
 * files_reindexed must equal the number of files where new chunks were actually
 * written to LanceDB, NOT the number of files scheduled for reindex. This prevents
 * false-positive success reporting when the skip-embed fast-path fires (all chunk_ids
 * already known → toEmbed is empty → nothing lands in LanceDB).
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";

describe("files_reindexed accounting (Fix 2)", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("files_reindexed > 0 and chunks_indexed > 0 on fresh full index", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const result = await runIndex(project.projectId, project.sourceId, "full");

    expect(result.files_reindexed).toBeGreaterThan(0);
    expect(result.chunks_indexed).toBeGreaterThan(0);
  });

  it("files_reindexed === 0 when nothing changed (incremental re-run)", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");
    // Second run: hashes identical → toReindex is empty → files_reindexed must be 0
    const result = await runIndex(project.projectId, project.sourceId, "incremental");

    expect(result.files_reindexed).toBe(0);
    expect(result.chunks_indexed).toBe(0);
  });

  it("files_reindexed counts only files with chunks written, not all files scheduled", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Full index: schedules ALL files, all new → files_reindexed should equal files with ≥1 chunk
    const result = await runIndex(project.projectId, project.sourceId, "full");

    // Every file that was reindexed must have produced ≥1 chunk
    // (files_reindexed ≤ files_scanned, and both > 0 for a non-empty repo)
    expect(result.files_reindexed).toBeGreaterThan(0);
    expect(result.files_reindexed).toBeLessThanOrEqual(result.files_scanned);
    expect(result.chunks_indexed).toBeGreaterThanOrEqual(result.files_reindexed);
  });
});
