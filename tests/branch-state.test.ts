/**
 * Unit tests for src/branch-state.ts — branch session API and standalone reads.
 * Covers withBranchSession + applyFile, wipeBranch, snapshotChunkIdsForFile,
 * and standalone reads: getChunkIdsForBranch, listBranches, countTagsForChunk.
 */
import { describe, it, expect } from "vitest";
import type { BranchTag } from "../src/branch-state.js";

const P = "proj";
const S = "primary";
const B = "main";

function makeTag(overrides: Partial<BranchTag> = {}): BranchTag {
  return {
    filePath: "src/alpha.ts",
    chunkId: "abc123",
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}


describe("branch-state session CRUD", () => {
  it("embedded outcome: chunk_id appears in getChunkIdsForBranch", async () => {
    const { withBranchSession, getChunkIdsForBranch } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
      }
    );
    const ids = getChunkIdsForBranch(P, S, B);
    expect(ids.has("abc123")).toBe(true);
  });

  it("embedded outcome is idempotent (INSERT OR IGNORE)", async () => {
    const { withBranchSession, getChunkIdsForBranch } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag(), makeTag()] });
      }
    );
    const ids = getChunkIdsForBranch(P, S, B);
    expect(ids.size).toBe(1);
  });

  it("countTagsForChunk counts references across branches", async () => {
    const { withBranchSession, countTagsForChunk } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/x", mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
      }
    );
    expect(countTagsForChunk("abc123")).toBe(2);
  });

  it("removed outcome deletes tags and hash for that file only", async () => {
    const { withBranchSession, getChunkIdsForBranch } = await import("../src/branch-state.js");
    const other = makeTag({ filePath: "src/beta.ts", chunkId: "def456" });

    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
        session.applyFile("src/beta.ts", { kind: "embedded", hash: "h2", tags: [other] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "removed" });
      }
    );

    const ids = getChunkIdsForBranch(P, S, B);
    expect(ids.has("abc123")).toBe(false);
    expect(ids.has("def456")).toBe(true);
  });

  it("wipeBranch removes all tags for branch only, other branches intact", async () => {
    const { withBranchSession, getChunkIdsForBranch } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/x", mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => { session.wipeBranch(); }
    );

    expect(getChunkIdsForBranch(P, S, "main").size).toBe(0);
    expect(getChunkIdsForBranch(P, S, "feat/x").size).toBe(1);
  });

  it("listBranches returns all indexed branches", async () => {
    const { withBranchSession, listBranches } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag()] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/x", mode: "incremental" },
      async (session) => {
        session.applyFile("src/beta.ts", { kind: "embedded", hash: "h2", tags: [makeTag({ chunkId: "def456" })] });
      }
    );

    const branches = listBranches(P, S);
    expect(branches).toContain("main");
    expect(branches).toContain("feat/x");
    expect(branches).toHaveLength(2);
  });

  it("stale-tags-only removes tags but keeps hash for subsequent embedded", async () => {
    const { withBranchSession, getChunkIdsForBranch } = await import("../src/branch-state.js");
    // First: embed a file
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "old-hash", tags: [makeTag()] });
      }
    );
    // Then: mark stale (remove tags only)
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "stale-tags-only" });
      }
    );
    // Tags removed
    expect(getChunkIdsForBranch(P, S, B).has("abc123")).toBe(false);

    // Finally: re-embed with new tags
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "new-hash", tags: [makeTag({ chunkId: "new001" })] });
      }
    );
    expect(getChunkIdsForBranch(P, S, B).has("new001")).toBe(true);
  });

  it("knownChunkIds pre-fetched includes IDs from other branches", async () => {
    const { withBranchSession } = await import("../src/branch-state.js");
    // Tag a chunk on "main"
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "shared001" })] });
      }
    );
    // Open a session on "feat/x" — knownChunkIds should contain "shared001"
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/x", mode: "incremental" },
      async (session) => {
        expect(session.knownChunkIds.has("shared001")).toBe(true);
      }
    );
  });

  it("snapshotChunkIdsForFile returns current tags for a file", async () => {
    const { withBranchSession } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "snap001" })] });
        const ids = session.snapshotChunkIdsForFile("src/alpha.ts");
        expect(ids).toContain("snap001");
      }
    );
  });

  it("Windows path safety: backslash paths stored and queried correctly", async () => {
    const { withBranchSession, getChunkIdsForBranch } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("SRC\\Alpha.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "win001" })] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        // Remove using same backslash path
        session.applyFile("SRC\\Alpha.ts", { kind: "removed" });
      }
    );
    const ids = getChunkIdsForBranch(P, S, B);
    expect(ids.has("win001")).toBe(false);
  });

  it("full mode: wipeBranch called, priorHashes is empty", async () => {
    const { withBranchSession } = await import("../src/branch-state.js");
    // First: embed something
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "old", tags: [makeTag()] });
      }
    );
    // Then: full mode — priorHashes should be empty
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "full" },
      async (session) => {
        expect(Object.keys(session.priorHashes)).toHaveLength(0);
      }
    );
  });

  it("priorHashes contains hashes from previous incremental run", async () => {
    const { withBranchSession } = await import("../src/branch-state.js");
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/alpha.ts", { kind: "embedded", hash: "hash-v1", tags: [makeTag()] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        expect(session.priorHashes["src/alpha.ts"]).toBe("hash-v1");
      }
    );
  });
});

describe("wipeSource (Fix 1)", () => {
  it("wipeSource deletes all branch_tags for every branch of a source", async () => {
    const { withBranchSession, wipeSource, getAllChunkIdsForSource } = await import("../src/branch-state.js");

    // Tag chunks on two branches
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/a.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "wipe-a" })] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/x", mode: "incremental" },
      async (session) => {
        session.applyFile("src/b.ts", { kind: "embedded", hash: "h2", tags: [makeTag({ chunkId: "wipe-b", filePath: "src/b.ts" })] });
      }
    );

    expect(getAllChunkIdsForSource(P, S).size).toBeGreaterThan(0);

    wipeSource(P, S);

    expect(getAllChunkIdsForSource(P, S).size).toBe(0);
  });

  it("wipeSource deletes all hash files for the source prefix", async () => {
    const { withBranchSession, wipeSource } = await import("../src/branch-state.js");
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { config } = await import("../src/config.js");

    // Create hash entries on two branches (saveBranchHashesAtomic is triggered by applyFile)
    await withBranchSession({ projectId: P, sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/a.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "wh-a" })] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/y", mode: "incremental" },
      async (session) => {
        session.applyFile("src/b.ts", { kind: "embedded", hash: "h2", tags: [makeTag({ chunkId: "wh-b", filePath: "src/b.ts" })] });
      }
    );

    const hashesDir = join(config.dataDir, "hashes");
    const prefix = `${P}__${S}__`;
    const before = existsSync(hashesDir) ? readdirSync(hashesDir).filter((f) => f.startsWith(prefix)) : [];
    expect(before.length).toBeGreaterThan(0);

    wipeSource(P, S);

    const after = existsSync(hashesDir) ? readdirSync(hashesDir).filter((f) => f.startsWith(prefix)) : [];
    expect(after.length).toBe(0);
  });

  it("full-mode session starts with empty knownChunkIds (Fix 1 — line 252 ternary)", async () => {
    const { withBranchSession } = await import("../src/branch-state.js");

    // Tag a chunk on main via incremental session
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "incremental" },
      async (session) => {
        session.applyFile("src/a.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "known-001" })] });
      }
    );

    // Full-mode session must NOT see existing chunks as "known"
    await withBranchSession({ projectId: P, sourceId: S, branch: B, mode: "full" },
      async (session) => {
        expect(session.knownChunkIds.size).toBe(0);
      }
    );
  });
});

describe("getBranchesForChunks", () => {
  it("empty chunkIds returns empty Map without hitting DB", async () => {
    const { getBranchesForChunks } = await import("../src/branch-state.js");
    const result = getBranchesForChunks(P, S, []);
    expect(result.size).toBe(0);
  });

  it("unknown chunk_id returns no entry in the Map", async () => {
    const { getBranchesForChunks } = await import("../src/branch-state.js");
    const result = getBranchesForChunks(P, S, ["no-such-chunk-id"]);
    expect(result.has("no-such-chunk-id")).toBe(false);
  });

  it("returns branches for known chunk_ids", async () => {
    const { withBranchSession, getBranchesForChunks } = await import("../src/branch-state.js");

    await withBranchSession({ projectId: P, sourceId: S, branch: "master", mode: "incremental" },
      async (session) => {
        session.applyFile("src/a.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "gc-shared" })] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "feat/x", mode: "incremental" },
      async (session) => {
        session.applyFile("src/a.ts", { kind: "embedded", hash: "h1", tags: [makeTag({ chunkId: "gc-shared" })] });
      }
    );
    await withBranchSession({ projectId: P, sourceId: S, branch: "master", mode: "incremental" },
      async (session) => {
        session.applyFile("src/b.ts", { kind: "embedded", hash: "h2", tags: [makeTag({ chunkId: "gc-master-only", filePath: "src/b.ts" })] });
      }
    );

    const map = getBranchesForChunks(P, S, ["gc-shared", "gc-master-only"]);
    expect(map.has("gc-shared")).toBe(true);
    expect(map.has("gc-master-only")).toBe(true);

    const sharedBranches = map.get("gc-shared")!;
    expect(sharedBranches).toContain("master");
    expect(sharedBranches).toContain("feat/x");

    const masterOnlyBranches = map.get("gc-master-only")!;
    expect(masterOnlyBranches).toEqual(["master"]);
  });

  it("master/main sort first, then alphabetical", async () => {
    const { withBranchSession, getBranchesForChunks } = await import("../src/branch-state.js");
    const cid = "gc-sort-test";

    for (const branch of ["zebra", "master", "apple", "main"]) {
      await withBranchSession({ projectId: P, sourceId: S, branch, mode: "incremental" },
        async (session) => {
          session.applyFile("src/x.ts", { kind: "embedded", hash: "h3", tags: [makeTag({ chunkId: cid })] });
        }
      );
    }

    const map = getBranchesForChunks(P, S, [cid]);
    const branches = map.get(cid)!;

    // master and main must come first
    expect(branches[0] === "master" || branches[0] === "main").toBe(true);
    expect(branches[1] === "master" || branches[1] === "main").toBe(true);
    // rest are alphabetical
    expect(branches[2]).toBe("apple");
    expect(branches[3]).toBe("zebra");
  });

  it("ignores tags from other (project, source) tuples", async () => {
    const { withBranchSession, getBranchesForChunks } = await import("../src/branch-state.js");
    const cid = "gc-isolation-test";

    // Tag on a DIFFERENT source
    await withBranchSession({ projectId: P, sourceId: "other-source", branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/z.ts", { kind: "embedded", hash: "h4", tags: [makeTag({ chunkId: cid })] });
      }
    );
    // Tag on a DIFFERENT project
    await withBranchSession({ projectId: "other-proj", sourceId: S, branch: "main", mode: "incremental" },
      async (session) => {
        session.applyFile("src/z.ts", { kind: "embedded", hash: "h4", tags: [makeTag({ chunkId: cid })] });
      }
    );

    // Query for (P, S) — must see no entries
    const map = getBranchesForChunks(P, S, [cid]);
    expect(map.has(cid)).toBe(false);
  });
});
