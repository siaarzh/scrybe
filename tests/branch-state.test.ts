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

async function openSession(branch = B, mode: "incremental" | "full" = "incremental") {
  const { withBranchSession } = await import("../src/branch-state.js");
  return { withBranchSession, branch };
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
