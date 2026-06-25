/**
 * Plan 93 Slice 4 — R4c: HEAD-coincidence invariant.
 *
 * When the working-tree HEAD is the same branch that is pinned
 * (e.g. HEAD=`dev` and `dev` is a pinned remote branch), the indexer
 * must produce exactly ONE logical label — `dev` — regardless of whether
 * indexing was driven by a HEAD-scan or by a pinned contentRef=origin/dev run.
 *
 * Design spec (ADR-0008):
 *   - Pinned branches are stored under their logical short name only.
 *   - `origin/dev` is the git-read target only; it is NEVER stored as a label.
 *   - No second "origin/dev" label is created alongside the logical label.
 *   - resolveBranchForSearch with the logical name resolves correctly (step 1 hit).
 *   - resolveBranchForSearch with a qualified `origin/dev` name falls back via
 *     step 3 and resolves to the logical label (back-compat path).
 *
 * Assertions:
 *   A. After a pinned-branch index (branch="dev", contentRef="origin/dev"),
 *      listBranches returns ["dev"] only — no "origin/dev".
 *   B. getChunkIdsForBranch("dev") is non-empty.
 *   C. getChunkIdsForBranch("origin/dev") is empty.
 *   D. resolveBranchForSearch("dev") returns "dev" (step 1 hit — no fallback needed).
 *   E. resolveBranchForSearch("origin/dev") returns "dev" (step-3 back-compat path).
 *   F. A second index pass (simulating HEAD=dev being re-indexed, same logical label)
 *      does NOT create a second "origin/dev" label — listBranches still has one entry.
 */
import { describe, it, expect, afterEach } from "vitest";

const P = "p93-head-coin";
const S = "primary";
const LOGICAL = "dev";
const CONTENT_REF = "origin/dev";

function makeTag(chunkId: string, filePath: string = "src/index.ts") {
  return { filePath, chunkId, startLine: 1, endLine: 10 };
}

describe("Plan 93 R4c — HEAD-coincidence: single logical label, no origin/ duplicate", () => {
  afterEach(async () => {
    // Clean up branch_tags rows inserted by these tests
    const { getDB } = await import("../src/branch-state.js");
    const db = getDB();
    db.prepare("DELETE FROM branch_tags WHERE project_id=?").run(P);
    db.prepare("DELETE FROM branch_state WHERE project_id=?").run(P);
  });

  it("A+B+C: pinned index writes only the logical label, not origin/-prefixed label", async () => {
    const { withBranchSession, listBranches, getChunkIdsForBranch } = await import("../src/branch-state.js");

    // Simulate a pinned-branch index: branch=logical, contentRef only influences git reads
    // (not tested here — content is mocked via session). The label written is LOGICAL.
    await withBranchSession({ projectId: P, sourceId: S, branch: LOGICAL, mode: "full" },
      async (session) => {
        session.applyFile("src/index.ts", {
          kind: "embedded",
          hash: "sha-abc123",
          tags: [makeTag("head-coin-chunk-1"), makeTag("head-coin-chunk-2")],
        });
      }
    );

    // A: only the logical label exists
    const branches = listBranches(P, S);
    expect(branches).toContain(LOGICAL);
    expect(branches).not.toContain(CONTENT_REF);
    expect(branches).toHaveLength(1);

    // B: logical label has chunks
    const logicalIds = getChunkIdsForBranch(P, S, LOGICAL);
    expect(logicalIds.size).toBeGreaterThan(0);

    // C: qualified label has no chunks
    const qualifiedIds = getChunkIdsForBranch(P, S, CONTENT_REF);
    expect(qualifiedIds.size).toBe(0);
  });

  it("D: resolveBranchForSearch with logical name hits step 1 (no fallback needed)", async () => {
    const { withBranchSession, resolveBranchForSearch } = await import("../src/branch-state.js");

    await withBranchSession({ projectId: P, sourceId: S, branch: LOGICAL, mode: "full" },
      async (session) => {
        session.applyFile("src/index.ts", {
          kind: "embedded",
          hash: "sha-def456",
          tags: [makeTag("head-coin-chunk-3")],
        });
      }
    );

    const resolved = resolveBranchForSearch(P, S, LOGICAL);
    expect(resolved).toBe(LOGICAL);
  });

  it("E: resolveBranchForSearch with origin/-prefixed name falls back to logical via step 3", async () => {
    const { withBranchSession, resolveBranchForSearch } = await import("../src/branch-state.js");

    await withBranchSession({ projectId: P, sourceId: S, branch: LOGICAL, mode: "full" },
      async (session) => {
        session.applyFile("src/index.ts", {
          kind: "embedded",
          hash: "sha-ghi789",
          tags: [makeTag("head-coin-chunk-4")],
        });
      }
    );

    // Caller supplies qualified form (e.g. older code or a migration-escaped label)
    const resolved = resolveBranchForSearch(P, S, CONTENT_REF);
    // Must resolve to the logical label, not null and not "origin/dev"
    expect(resolved).toBe(LOGICAL);
  });

  it("F: second index pass (same logical label) does not create an origin/ label", async () => {
    const { withBranchSession, listBranches } = await import("../src/branch-state.js");

    // First pass
    await withBranchSession({ projectId: P, sourceId: S, branch: LOGICAL, mode: "full" },
      async (session) => {
        session.applyFile("src/index.ts", {
          kind: "embedded",
          hash: "sha-v1",
          tags: [makeTag("head-coin-chunk-5")],
        });
      }
    );

    // Second pass (incremental, simulating HEAD=dev re-scan)
    await withBranchSession({ projectId: P, sourceId: S, branch: LOGICAL, mode: "incremental" },
      async (session) => {
        session.applyFile("src/index.ts", {
          kind: "embedded",
          hash: "sha-v2",
          tags: [makeTag("head-coin-chunk-5"), makeTag("head-coin-chunk-6")],
        });
      }
    );

    const branches = listBranches(P, S);
    // Still exactly one label
    expect(branches).toContain(LOGICAL);
    expect(branches).not.toContain(CONTENT_REF);
    expect(branches).toHaveLength(1);
  });
});
