/**
 * Rename detection — renaming a file must not trigger re-embedding.
 * Content-addressed chunk IDs are identical for same-content files regardless of path.
 * The `preservedFromRemovals` fix in indexer.ts makes this work on a single branch.
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

  it("renaming a file does not trigger re-embedding on incremental reindex", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Full index — embeds all chunks
    await runIndex(project.projectId, project.sourceId, "full");

    // Snapshot the embed request counter
    const requestsBefore = await getTotalRequests();

    // Rename src/alpha.ts → src/renamed.ts (same content, different path)
    renameFile(fixture, "src/alpha.ts", "src/renamed.ts");

    // Incremental reindex — should detect rename via content-addressed IDs
    // and skip embedding (chunks already in LanceDB)
    await runIndex(project.projectId, project.sourceId, "incremental");

    const requestsAfter = await getTotalRequests();

    // Zero new embedding requests — all chunks reused from LanceDB
    expect(requestsAfter).toBe(requestsBefore);
  });
});
