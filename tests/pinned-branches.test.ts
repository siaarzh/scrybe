/**
 * Phase 1 — Pinned branches: add/remove/clear/list round-trips through projects.json.
 * Exercises the shared pinned-branches module via direct function calls (all three
 * CLI / MCP / HTTP surfaces share this module).
 */
import { describe, it, expect, beforeEach } from "vitest";

// Project setup — created fresh per test via beforeEach isolation (see isolate.ts)
let projectId: string;
let sourceId: string;

beforeEach(async () => {
  const { addProject, addSource } = await import("../src/registry.js");
  const { randomBytes } = await import("crypto");
  projectId = `test-pin-${randomBytes(4).toString("hex")}`;
  sourceId = "primary";
  addProject({ id: projectId, description: "pinned-branches test" });
  addSource(projectId, {
    source_id: sourceId,
    source_config: { type: "code", root_path: "/fake/path", languages: ["ts"] },
  });
});

describe("listPinned", () => {
  it("returns empty array for a fresh source", async () => {
    const { listPinned } = await import("../src/pinned-branches.js");
    expect(listPinned(projectId, sourceId)).toEqual([]);
  });
});

describe("addPinned", () => {
  it("adds branches in 'add' mode (default)", async () => {
    const { addPinned, listPinned } = await import("../src/pinned-branches.js");
    const result = addPinned(projectId, sourceId, ["main", "dev"]);
    expect(result.branches).toEqual(["main", "dev"]);
    expect(result.added).toEqual(["main", "dev"]);
    expect(result.warnings).toEqual([]);
    expect(listPinned(projectId, sourceId)).toEqual(["main", "dev"]);
  });

  it("deduplicates on repeated add", async () => {
    const { addPinned } = await import("../src/pinned-branches.js");
    addPinned(projectId, sourceId, ["main"]);
    const result = addPinned(projectId, sourceId, ["main", "dev"]);
    expect(result.branches).toEqual(["main", "dev"]);
    expect(result.added).toEqual(["dev"]); // main was already there
  });

  it("replaces list in 'set' mode", async () => {
    const { addPinned, listPinned } = await import("../src/pinned-branches.js");
    addPinned(projectId, sourceId, ["main", "dev", "beta"]);
    const result = addPinned(projectId, sourceId, ["main", "release/1.0"], "set");
    expect(result.branches).toEqual(["main", "release/1.0"]);
    expect(result.added).toEqual(["release/1.0"]); // main was in previous list
    expect(listPinned(projectId, sourceId)).toEqual(["main", "release/1.0"]);
  });

  it("emits warning when count exceeds 20", async () => {
    const { addPinned } = await import("../src/pinned-branches.js");
    const branches = Array.from({ length: 21 }, (_, i) => `branch-${i}`);
    const result = addPinned(projectId, sourceId, branches);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("21 pinned branches");
  });

  it("throws InvalidSourceTypeError for ticket source", async () => {
    const { addProject, addSource } = await import("../src/registry.js");
    const { addPinned, InvalidSourceTypeError } = await import("../src/pinned-branches.js");
    const ticketProjectId = `${projectId}-ticket`;
    addProject({ id: ticketProjectId, description: "ticket project" });
    addSource(ticketProjectId, {
      source_id: "issues",
      source_config: {
        type: "ticket",
        provider: "gitlab",
        base_url: "https://gitlab.example.com",
        project_id: "42",
        token: "glpat-fake",
      },
    });
    expect(() => addPinned(ticketProjectId, "issues", ["main"])).toThrow(InvalidSourceTypeError);
  });
});

describe("removePinned", () => {
  it("removes specified branches", async () => {
    const { addPinned, removePinned, listPinned } = await import("../src/pinned-branches.js");
    addPinned(projectId, sourceId, ["main", "dev", "beta"]);
    const result = removePinned(projectId, sourceId, ["dev"]);
    expect(result.removed).toEqual(["dev"]);
    expect(result.branches).toEqual(["main", "beta"]);
    expect(listPinned(projectId, sourceId)).toEqual(["main", "beta"]);
  });

  it("is a no-op for branches not in list", async () => {
    const { addPinned, removePinned } = await import("../src/pinned-branches.js");
    addPinned(projectId, sourceId, ["main"]);
    const result = removePinned(projectId, sourceId, ["nonexistent"]);
    expect(result.removed).toEqual([]);
    expect(result.branches).toEqual(["main"]);
  });
});

describe("clearPinned", () => {
  it("removes all branches", async () => {
    const { addPinned, clearPinned, listPinned } = await import("../src/pinned-branches.js");
    addPinned(projectId, sourceId, ["main", "dev", "beta"]);
    const result = clearPinned(projectId, sourceId);
    expect(result.removed).toEqual(["main", "dev", "beta"]);
    expect(result.branches).toEqual([]);
    expect(listPinned(projectId, sourceId)).toEqual([]);
  });

  it("is a no-op on empty list", async () => {
    const { clearPinned } = await import("../src/pinned-branches.js");
    const result = clearPinned(projectId, sourceId);
    expect(result.removed).toEqual([]);
    expect(result.branches).toEqual([]);
  });
});

describe("persistence", () => {
  it("pinned_branches round-trips through projects.json", async () => {
    const { addPinned } = await import("../src/pinned-branches.js");
    const { getSource } = await import("../src/registry.js");
    addPinned(projectId, sourceId, ["main", "dev"]);
    // re-read from registry to verify JSON persistence
    const source = getSource(projectId, sourceId);
    expect(source?.pinned_branches).toEqual(["main", "dev"]);
  });
});
