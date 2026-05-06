/**
 * Rename detection — renaming a file triggers re-embedding because chunk IDs
 * include item_path (the file path) in the hash. Same-content, different-path
 * files get different chunk IDs (this is the Plan 43 collision fix).
 */
import { describe, it, expect, afterEach } from "vitest";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { renameFile } from "./helpers/git.js";
import { sidecar } from "./helpers/sidecar.js";

async function getTotalRequests(): Promise<number> {
  const healthUrl = sidecar.baseUrl.replace(/\/v1$/, "") + "/health";
  const resp = await fetch(healthUrl);
  const data = (await resp.json()) as { total_requests: number };
  return data.total_requests;
}

describe("rename detection", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("renaming a file triggers re-embedding (item_path is part of chunk_id)", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Full index — embeds all chunks
    await runIndex(project.projectId, project.sourceId, "full");

    // Snapshot the embed request counter
    const requestsBefore = await getTotalRequests();

    // Rename src/alpha.ts → src/renamed.ts (same content, different path)
    renameFile(fixture, "src/alpha.ts", "src/renamed.ts");

    // Incremental reindex — renamed file gets new chunk IDs (item_path changed)
    // so its chunks are not found in LanceDB → re-embedding is expected.
    await runIndex(project.projectId, project.sourceId, "incremental");

    const requestsAfter = await getTotalRequests();

    // At least one embedding request was made for the renamed file's chunks
    expect(requestsAfter).toBeGreaterThan(requestsBefore);
  });
});
