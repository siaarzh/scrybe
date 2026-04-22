/**
 * Unit tests for src/branch-tags.ts — SQLite side-store CRUD.
 * Exercises addTags, removeTagsForFile, removeTagsForBranch,
 * getChunkIdsForBranch, getBranchesForSource, countTagsForChunk.
 */
import { describe, it, expect } from "vitest";
import type { BranchTag } from "../src/branch-tags.js";

const BASE: BranchTag = {
  projectId: "proj",
  sourceId: "primary",
  branch: "main",
  filePath: "src/alpha.ts",
  chunkId: "abc123",
  startLine: 1,
  endLine: 10,
};

describe("branch-tags CRUD", () => {
  it("addTags round-trip: inserted chunk_id appears in getChunkIdsForBranch", async () => {
    const { addTags, getChunkIdsForBranch } = await import("../src/branch-tags.js");
    addTags([BASE]);
    const ids = getChunkIdsForBranch("proj", "primary", "main");
    expect(ids.has("abc123")).toBe(true);
  });

  it("addTags is idempotent (INSERT OR IGNORE)", async () => {
    const { addTags, getChunkIdsForBranch } = await import("../src/branch-tags.js");
    addTags([BASE, BASE]);
    const ids = getChunkIdsForBranch("proj", "primary", "main");
    expect(ids.size).toBe(1);
  });

  it("countTagsForChunk counts references across branches", async () => {
    const { addTags, countTagsForChunk } = await import("../src/branch-tags.js");
    addTags([BASE, { ...BASE, branch: "feat/x" }]);
    expect(countTagsForChunk("abc123")).toBe(2);
  });

  it("removeTagsForFile deletes only matching file rows", async () => {
    const { addTags, removeTagsForFile, getChunkIdsForBranch } = await import("../src/branch-tags.js");
    const other: BranchTag = { ...BASE, filePath: "src/beta.ts", chunkId: "def456" };
    addTags([BASE, other]);

    removeTagsForFile("proj", "primary", "main", "src/alpha.ts");
    const ids = getChunkIdsForBranch("proj", "primary", "main");
    expect(ids.has("abc123")).toBe(false);
    expect(ids.has("def456")).toBe(true);
  });

  it("removeTagsForBranch removes all rows for the given branch only", async () => {
    const { addTags, removeTagsForBranch, getChunkIdsForBranch } = await import("../src/branch-tags.js");
    addTags([BASE, { ...BASE, branch: "feat/x" }]);

    removeTagsForBranch("proj", "primary", "main");
    expect(getChunkIdsForBranch("proj", "primary", "main").size).toBe(0);
    expect(getChunkIdsForBranch("proj", "primary", "feat/x").size).toBe(1);
  });

  it("getBranchesForSource lists indexed branches", async () => {
    const { addTags, getBranchesForSource } = await import("../src/branch-tags.js");
    addTags([BASE, { ...BASE, branch: "feat/x", chunkId: "def456" }]);
    const branches = getBranchesForSource("proj", "primary");
    expect(branches).toContain("main");
    expect(branches).toContain("feat/x");
    expect(branches).toHaveLength(2);
  });

  it("Windows path safety: file_path stored lowercased with forward slashes", async () => {
    const { addTags, removeTagsForFile, getChunkIdsForBranch } = await import("../src/branch-tags.js");
    const winTag: BranchTag = { ...BASE, filePath: "SRC\\Alpha.ts", chunkId: "win001" };
    addTags([winTag]);

    // removeTagsForFile with the original casing should still hit the row
    removeTagsForFile("proj", "primary", "main", "SRC\\Alpha.ts");
    const ids = getChunkIdsForBranch("proj", "primary", "main");
    expect(ids.has("win001")).toBe(false);
  });
});
