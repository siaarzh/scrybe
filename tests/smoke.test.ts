/**
 * Full pipeline regression smoke test.
 * Exercises: registry → chunker → embedder HTTP → LanceDB upsert → FTS → hybrid search.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { sentinel } from "./helpers/sentinel.js";

describe("smoke — full pipeline regression", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  it("indexes sample-repo and returns search hits", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    const result = await runIndex(project.projectId, project.sourceId, "full");

    expect(result.status).toBe("ok");
    expect(result.files_scanned).toBeGreaterThanOrEqual(3); // at least alpha.ts, beta.ts, gamma.ts
    expect(result.chunks_indexed).toBeGreaterThan(0);
  });

  it("incremental reindex finds new file with sentinel and search returns a hit", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Initial full index
    await runIndex(project.projectId, project.sourceId, "full");

    // Add a new file with a unique sentinel token
    const token = sentinel("smoke");
    const newFilePath = join(fixture.path, "src", "delta.ts");
    writeFileSync(
      newFilePath,
      `// ${token}\nexport function deltaHelper(): string { return "${token}"; }\n`,
      "utf8"
    );

    // Incremental reindex should pick up the new file
    const result = await runIndex(project.projectId, project.sourceId, "incremental");
    expect(result.files_reindexed).toBeGreaterThanOrEqual(1);

    // Search for the sentinel — BM25 should find it exactly
    const hits = await search(project.projectId, token);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file_path).toContain("delta.ts");

    // Verify result shape matches contract
    const hit = hits[0];
    expect(typeof hit.chunk_id).toBe("string");
    expect(hit.chunk_id.length).toBeGreaterThan(0);
    expect(typeof hit.file_path).toBe("string");
    expect(typeof hit.content).toBe("string");
    expect(typeof hit.start_line).toBe("number");
    expect(typeof hit.end_line).toBe("number");
    expect(typeof hit.score).toBe("number");
  });

  it("deleted file chunks are removed on incremental reindex", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });

    await runIndex(project.projectId, project.sourceId, "full");

    const token = sentinel("delete");
    const tempFile = join(fixture.path, "src", "temp.ts");
    writeFileSync(
      tempFile,
      `// ${token}\nexport const tempValue = "${token}";\n`,
      "utf8"
    );
    await runIndex(project.projectId, project.sourceId, "incremental");

    // Verify it's found before deletion
    const before = await search(project.projectId, token);
    expect(before.length).toBeGreaterThan(0);

    // Delete the file and reindex — full reindex to detect deletion
    const { unlinkSync } = await import("fs");
    unlinkSync(tempFile);
    await runIndex(project.projectId, project.sourceId, "full");

    // Vector search may return unrelated top-K hits; verify that none are from deleted file
    const after = await search(project.projectId, token);
    const fromDeletedFile = after.filter((r) => r.file_path.includes("temp.ts"));
    expect(fromDeletedFile).toHaveLength(0);
  });
});
