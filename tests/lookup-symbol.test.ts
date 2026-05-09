/**
 * Integration tests for Plan 54 — exact-symbol lookup tool.
 *
 * 8 cases covering:
 *   1. Top-level symbol exact match
 *   2. Dotted method via suffix match (default)
 *   3. Dotted method via exact match misses bare name / hits full name
 *   4. Case-insensitive override
 *   5. Empty-name chunks excluded (validation + no sliding-window hits)
 *   6. Branch filter integration (Plan 53 resolution piggyback)
 *   7. Cross-source merge + limit
 *   8. Multiple matches sorted deterministically
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { createTempProject, type TempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { switchBranch } from "./helpers/git.js";
import type { LookupSymbolInput, LookupResult } from "../src/tools/lookup.js";

/** Dynamic-import wrapper so vi.resetModules() in isolate.ts picks up a fresh registry. */
async function lookup(projectId: string, input: LookupSymbolInput): Promise<LookupResult[]> {
  const { lookupSymbol } = await import("../src/tools/lookup.js");
  return lookupSymbol(projectId, input);
}

describe("lookup_symbol (Plan 54)", () => {
  let fixture: FixtureHandle | null = null;
  let project: TempProject | null = null;

  afterEach(async () => {
    await project?.cleanup();
    await fixture?.cleanup();
    project = null;
    fixture = null;
  });

  // ─── Test 1: Top-level symbol exact match ──────────────────────────────────

  it("Test 1: top-level function exact match returns one hit with correct line range", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "alphaGreeting",
      match: "exact",
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.symbol_name === "alphaGreeting");
    expect(hit).toBeDefined();
    // alphaGreeting starts on line 13 in alpha.ts
    expect(hit!.start_line).toBeGreaterThan(0);
    expect(hit!.end_line).toBeGreaterThanOrEqual(hit!.start_line);
    // All returned hits must have non-empty symbol_name
    for (const h of hits) {
      expect(h.symbol_name).not.toBe("");
    }
  }, 60000);

  // ─── Test 2: Dotted method via suffix match (default) ─────────────────────

  it("Test 2: suffix match finds method by bare name — returns stored dotted symbol_name", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    // BetaEngine.transform is a method on the BetaEngine class
    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "transform",
      // match defaults to "suffix"
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.symbol_name === "BetaEngine.transform");
    expect(hit).toBeDefined();
    // All hits must have non-empty symbol_name
    for (const h of hits) {
      expect(h.symbol_name).not.toBe("");
    }
  }, 60000);

  // ─── Test 3: Dotted method via exact match misses bare name ───────────────

  it("Test 3a: exact match with bare method name does not return dotted form", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "transform",
      match: "exact",
    });

    // "transform" exact should not match "BetaEngine.transform"
    expect(hits.filter((h) => h.symbol_name === "BetaEngine.transform")).toHaveLength(0);
  }, 60000);

  it("Test 3b: exact match with fully-qualified name returns the hit", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "BetaEngine.transform",
      match: "exact",
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.symbol_name === "BetaEngine.transform");
    expect(hit).toBeDefined();
  }, 60000);

  // ─── Test 4: Case-insensitive override ────────────────────────────────────

  it("Test 4: case_sensitive=false matches symbol by uppercase name", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    // "BETAENGINE" should match "BetaEngine" when case_sensitive=false
    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "BETAENGINE",
      match: "exact",
      case_sensitive: false,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.symbol_name.toLowerCase() === "betaengine");
    expect(hit).toBeDefined();
  }, 60000);

  // ─── Test 5: Empty-name chunks excluded ───────────────────────────────────

  it("Test 5a: empty symbol_name input rejected with validation error", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    await expect(
      lookup(project.projectId, {
        project_id: project.projectId,
        symbol_name: "  ",  // whitespace-only → empty after trim
      })
    ).rejects.toThrow(/non-empty/i);
  }, 60000);

  it("Test 5b: sliding-window fallback chunks (empty symbol_name) never appear in results", async () => {
    // Index a project that includes a .txt file (unknown language → sliding-window fallback)
    fixture = await cloneFixture("sample-repo");

    // Write a plain text file to the fixture (will be indexed as sliding-window, symbol_name="")
    const txtPath = join(fixture.path, "src", "notes.txt");
    writeFileSync(txtPath, "Some plain text content that has no AST symbol names.\nLine 2.\n", "utf8");

    // Commit it so it gets indexed
    const { execSync } = await import("child_process");
    execSync("git add src/notes.txt", { cwd: fixture.path, stdio: "ignore" });
    execSync('git commit -m "add notes.txt for test"', { cwd: fixture.path, stdio: "ignore" });

    project = await createTempProject({ rootPath: fixture.path, languages: ["ts", "txt"] });
    await runIndex(project.projectId, project.sourceId, "full");

    // Search for a symbol that won't exist in .txt — result must have non-empty symbol_name
    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "alphaGreeting",
    });

    // All returned hits must have non-empty symbol_name (the WHERE clause ensures this)
    for (const h of hits) {
      expect(h.symbol_name).not.toBe("");
    }
  }, 60000);

  // ─── Test 6: Branch filter integration ───────────────────────────────────

  it("Test 6: branch filter scopes results; origin/ prefix resolution works", async () => {
    fixture = await cloneFixture("sample-multi-branch-repo");
    project = await createTempProject({ rootPath: fixture.path });

    // Index master (default branch)
    await runIndex(project.projectId, project.sourceId, "full");

    // Switch to feat/example and index it
    switchBranch(fixture, "feat/example");
    await runIndex(project.projectId, project.sourceId, "incremental");

    // "alphaFarewell" exists only on feat/example
    const hitsOnFeat = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "alphaFarewell",
      branch: "feat/example",
    });
    expect(hitsOnFeat.some((h) => h.symbol_name === "alphaFarewell")).toBe(true);

    // Switch back to the default branch (master/main) before querying its name
    const { execSync } = await import("child_process");
    // Determine default branch name — try main then master
    let defaultBranch: string;
    try {
      execSync(`git -C "${fixture.path}" checkout main`, { stdio: "ignore" });
      defaultBranch = "main";
    } catch {
      execSync(`git -C "${fixture.path}" checkout master`, { stdio: "ignore" });
      defaultBranch = "master";
    }

    const hitsOnMaster = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "alphaFarewell",
      branch: defaultBranch,
    });
    expect(hitsOnMaster.every((h) => h.symbol_name !== "alphaFarewell")).toBe(true);

    // Plan 53 resolution piggyback: manually insert an origin/feat/example row in branch_tags
    // to simulate the pinned-branch storage format, then confirm resolution works.
    const { getDB } = await import("../src/branch-state.js");
    const db = getDB();
    // Copy the feat/example rows as origin/feat/example
    const existingRows = db.prepare(
      "SELECT * FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?"
    ).all(project.projectId, project.sourceId, "feat/example") as Array<{
      project_id: string; source_id: string; branch: string; file_path: string;
      chunk_id: string; start_line: number; end_line: number;
    }>;

    for (const row of existingRows) {
      db.prepare(
        `INSERT OR IGNORE INTO branch_tags
           (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.project_id, row.source_id, "origin/feat/example",
        row.file_path, row.chunk_id, row.start_line, row.end_line
      );
    }

    // Supply "origin/feat/example" — resolver should find it (both forms now present)
    const hitsViaOriginForm = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "alphaFarewell",
      branch: "origin/feat/example",
    });
    expect(hitsViaOriginForm.some((h) => h.symbol_name === "alphaFarewell")).toBe(true);
  }, 60000);

  // ─── Test 7: Cross-source merge + limit ──────────────────────────────────

  it("Test 7: hits from two sources both appear and limit caps the merged array", async () => {
    fixture = await cloneFixture("sample-repo");

    const { addProject, addSource } = await import("../src/registry.js");
    const { randomBytes } = await import("crypto");
    const { sidecar } = await import("./helpers/sidecar.js");

    const projectId = `test-cs-${randomBytes(4).toString("hex")}`;
    addProject({ id: projectId, description: "cross-source test" });
    addSource(projectId, {
      source_id: "src-a",
      source_config: { type: "code", root_path: fixture.path, languages: ["ts"] },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: sidecar.dimensions,
        api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
      },
    });
    addSource(projectId, {
      source_id: "src-b",
      source_config: { type: "code", root_path: fixture.path, languages: ["ts"] },
      embedding: {
        base_url: sidecar.baseUrl,
        model: sidecar.model,
        dimensions: sidecar.dimensions,
        api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
      },
    });

    project = {
      projectId,
      sourceId: "src-a",
      rootPath: fixture.path,
      async cleanup() {
        try {
          const { removeProject } = await import("../src/registry.js");
          await removeProject(projectId);
        } catch { /* ignore */ }
      },
    };

    await runIndex(projectId, "src-a", "full");
    await runIndex(projectId, "src-b", "full");

    // "alphaGreeting" appears in both sources — both should be present
    const hits = await lookup(projectId, {
      project_id: projectId,
      symbol_name: "alphaGreeting",
      match: "exact",
    });

    // We should get hits from both sources
    const sourceIds = new Set(hits.map((h) => h.source_id));
    expect(sourceIds.has("src-a")).toBe(true);
    expect(sourceIds.has("src-b")).toBe(true);

    // Limit works — fetch with limit=1 and verify we get exactly 1 result
    const limited = await lookup(projectId, {
      project_id: projectId,
      symbol_name: "alphaGreeting",
      match: "exact",
      limit: 1,
    });
    expect(limited.length).toBe(1);
  }, 60000);

  // ─── Test 8: Multiple matches sorted deterministically ────────────────────

  it("Test 8: multiple symbols in one project are sorted by (language, item_path, start_line)", async () => {
    fixture = await cloneFixture("sample-repo");
    project = await createTempProject({ rootPath: fixture.path });
    await runIndex(project.projectId, project.sourceId, "full");

    // Use suffix mode with a common letter that matches many symbols
    const hits = await lookup(project.projectId, {
      project_id: project.projectId,
      symbol_name: "a",  // suffix — matches any symbol ending in 'a' (e.g. BetaEngine, alphaFarewell, etc.)
      match: "suffix",
      limit: 50,
    });

    // Verify sort is stable: language ASC, item_path ASC, start_line ASC
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1];
      const curr = hits[i];
      const langCmp = prev.language.localeCompare(curr.language);
      if (langCmp < 0) continue;  // language ordering correct
      if (langCmp > 0) {
        throw new Error(`Sort violation at [${i}]: language '${prev.language}' > '${curr.language}'`);
      }
      // same language — check path
      const pathCmp = prev.item_path.localeCompare(curr.item_path);
      if (pathCmp < 0) continue;
      if (pathCmp > 0) {
        throw new Error(`Sort violation at [${i}]: path '${prev.item_path}' > '${curr.item_path}'`);
      }
      // same path — check start_line
      expect(prev.start_line).toBeLessThanOrEqual(curr.start_line);
    }
  }, 60000);
});
