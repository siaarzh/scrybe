/**
 * Plan 93 Slice 2 — D2: Incremental reindex of a pinned branch removes chunks
 * for files deleted upstream.
 *
 * Setup:
 *   - remote repo: two files committed on feat/example
 *   - local clone: origin/feat/example tracks remote
 *   - initial full index with branch="feat/example", contentRef="origin/feat/example"
 *   - one file is deleted on remote and committed
 *   - local clone fetches, origin/feat/example now reflects the deletion
 *   - incremental reindex (same branch/contentRef)
 *
 * Assertions (D2):
 *   1. The full index tags both files under the logical branch label "feat/example"
 *      (not "origin/feat/example" — no qualified duplicates created).
 *   2. files_removed >= 1 after the incremental reindex (deletion detected).
 *   3. branch_tags for "feat/example" no longer contains chunks for the deleted file.
 *   4. searchCode with branch="feat/example" does not return the deleted file's content.
 *   5. The surviving file is unaffected (no collateral damage).
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cloneLocal, type FixtureHandle } from "./helpers/fixtures.js";
import { sidecar } from "./helpers/sidecar.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRemoteRepo(): FixtureHandle {
  const repoPath = mkdtempSync(join(tmpdir(), "scrybe-plan93-remote-"));
  try {
    execSync("git init", { cwd: repoPath, stdio: "ignore" });
    execSync("git config core.autocrlf false", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.email test@scrybe.local", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.name scrybe-test", { cwd: repoPath, stdio: "ignore" });

    mkdirSync(join(repoPath, "src"), { recursive: true });

    // base file — will survive the deletion
    writeFileSync(
      join(repoPath, "src", "keeper.ts"),
      // Non-trivial content so the embedder produces at least one chunk
      [
        `/** keeperFn is a permanent utility that should never be removed. */`,
        `export function keeperFn(x: number): string {`,
        `  return \`keeper result: \${x}\`;`,
        `}`,
        ``,
        `export const KEEPER_VERSION = "1.0.0";`,
      ].join("\n") + "\n",
      "utf8"
    );
    // ephemeral file — will be deleted upstream to test the removal path
    writeFileSync(
      join(repoPath, "src", "ephemeral.ts"),
      [
        `/** ephemeralFn is a temporary function that will be removed in a later commit. */`,
        `export function ephemeralFn(label: string): string {`,
        `  return \`ephemeral output: \${label}\`;`,
        `}`,
        ``,
        `export const EPHEMERAL_SENTINEL = "PLAN93_DELETION_PROBE";`,
      ].join("\n") + "\n",
      "utf8"
    );

    execSync("git add .", { cwd: repoPath, stdio: "ignore" });
    execSync('git commit -m "initial: keeper + ephemeral"', { cwd: repoPath, stdio: "ignore" });

    // Create feat/example branch (the one we will pin) and switch back to default
    execSync("git checkout -b feat/example", { cwd: repoPath, stdio: "ignore" });
    execSync("git checkout -", { cwd: repoPath, stdio: "ignore" });
  } catch (err) {
    rmSync(repoPath, { recursive: true, force: true });
    throw err;
  }

  return {
    path: repoPath,
    async cleanup() {
      await new Promise((r) => setTimeout(r, 100));
      try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Delete a file on the remote repo's feat/example branch and commit. */
function deleteFileOnRemote(remote: FixtureHandle, relPath: string): void {
  execSync(`git -C "${remote.path}" checkout feat/example`, { stdio: "ignore" });
  const abs = join(remote.path, relPath);
  if (existsSync(abs)) unlinkSync(abs);
  execSync(`git -C "${remote.path}" add -A`, { stdio: "ignore" });
  execSync(`git -C "${remote.path}" commit -m "delete ${relPath}"`, { stdio: "ignore" });
  execSync(`git -C "${remote.path}" checkout -`, { stdio: "ignore" });
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe("Plan 93 D2 — pinned branch deletion propagation", () => {
  let remote: FixtureHandle | null = null;
  let local: FixtureHandle | null = null;
  const projectId = "p93-del-proj";
  const sourceId = "primary";
  const logicalBranch = "feat/example";
  const contentRef = "origin/feat/example";

  afterEach(async () => {
    try {
      const { removeProject } = await import("../src/registry.js");
      await removeProject(projectId);
    } catch { /* ignore */ }
    await local?.cleanup();
    await remote?.cleanup();
    local = null;
    remote = null;
  });

  it("deleted-upstream file's chunks are removed from the logical branch label after incremental reindex", async () => {
    // ── 1. Set up remote + local clone ───────────────────────────────────────
    remote = makeRemoteRepo();
    local = cloneLocal(remote.path);

    // Ensure origin/feat/example is fetched in the local clone
    execSync(`git -C "${local.path}" fetch origin`, { stdio: "ignore" });

    // ── 2. Register project + source ─────────────────────────────────────────
    const { addProject, addSource } = await import("../src/registry.js");
    addProject({ id: projectId, description: "Plan 93 deletion test" });
    addSource(projectId, {
      source_id: sourceId,
      source_config: {
        type: "code",
        root_path: local.path,
        languages: ["ts"],
      },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: sidecar.dimensions,
        api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
      },
    });

    // ── 3. Full index: label=feat/example, content from origin/feat/example ──
    const { indexSource } = await import("../src/indexer.js");
    const fullResult = await indexSource(projectId, sourceId, "full", {
      branch: logicalBranch,
      contentRef,
    });
    expect(fullResult.status).toBe("ok");
    expect(fullResult.files_scanned).toBeGreaterThanOrEqual(2);

    // D2 assertion 1: chunks are stored under the logical branch label, not origin/-prefixed
    const { getChunkIdsForBranch, listBranches, getDB } = await import("../src/branch-state.js");
    const storedBranches = listBranches(projectId, sourceId);
    expect(storedBranches).toContain(logicalBranch);
    expect(storedBranches).not.toContain(contentRef); // no "origin/feat/example" label

    const chunksBefore = getChunkIdsForBranch(projectId, sourceId, logicalBranch);
    expect(chunksBefore.size).toBeGreaterThan(0);

    // Directly verify ephemeral.ts has branch_tags rows before deletion
    const branchDb = getDB();
    const rowsBefore = branchDb.prepare(
      "SELECT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
    ).all(projectId, sourceId, logicalBranch, "src/ephemeral.ts") as { chunk_id: string }[];
    expect(rowsBefore.length).toBeGreaterThan(0);

    // ── 4. Delete the file upstream and advance the branch SHA ───────────────
    deleteFileOnRemote(remote, "src/ephemeral.ts");
    // Fetch the deletion into the local clone so origin/feat/example is at the new SHA
    execSync(`git -C "${local.path}" fetch origin`, { stdio: "ignore" });

    // ── 5. Incremental reindex (same branch/contentRef) ──────────────────────
    const incrResult = await indexSource(projectId, sourceId, "incremental", {
      branch: logicalBranch,
      contentRef,
    });
    expect(incrResult.status).toBe("ok");

    // D2 assertion 2: the indexer detected and processed at least one removed file
    expect(incrResult.files_removed).toBeGreaterThanOrEqual(1);

    // D2 assertion 3: branch_tags has NO rows for the deleted file under the logical label
    const rowsAfter = branchDb.prepare(
      "SELECT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
    ).all(projectId, sourceId, logicalBranch, "src/ephemeral.ts") as { chunk_id: string }[];
    expect(rowsAfter).toHaveLength(0);

    // D2 assertion 4: search with the logical branch returns nothing for the deleted file.
    // After removal, getChunkIdsForBranch drives the inline filter — the deleted file's
    // chunks are no longer in the set, so they cannot be returned regardless of LanceDB state.
    const { searchCode } = await import("../src/search.js");
    const afterSearch = await searchCode("PLAN93_DELETION_PROBE", projectId, {
      limit: 10,
      branch: logicalBranch,
    });
    const afterPaths = afterSearch.map((r) => r.file_path ?? "");
    expect(afterPaths.some((p) => p.includes("ephemeral.ts"))).toBe(false);

    // D2 assertion 5: keeper.ts chunks are still present — no collateral damage
    const keeperRows = branchDb.prepare(
      "SELECT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
    ).all(projectId, sourceId, logicalBranch, "src/keeper.ts") as { chunk_id: string }[];
    expect(keeperRows.length).toBeGreaterThan(0);
  });
});
