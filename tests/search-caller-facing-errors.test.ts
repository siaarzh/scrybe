/**
 * Plan 94 Slice 2 — unit tests for search.ts's caller-facing throw sites.
 *
 * `searchCode` / `searchKnowledge` throw plain `Error`s for well-formed but
 * "you asked for something that isn't there" calls — nonexistent `project_id`,
 * nonexistent `source_id`, or a project with no indexed sources of the
 * requested type. Per Plan 94 Decision 3 / Phase 2, ALL FIVE of these throw
 * sites (search.ts:90,101,205,211,215) are marked via `markCallerFacing` so
 * the daemon RPC catch (mcp-rpc.ts) echoes the message under -32602 instead
 * of masking it as "internal error" — the `NO_CODE_SOURCES:` /
 * `NO_KNOWLEDGE_SOURCES:` prefix strings are wrapped, not rewritten (the
 * out-of-scope item is refactoring/normalizing those prefixes, not tagging
 * their throw sites — see plan.md `## Out of scope`).
 *
 * See tests/daemon-mcp-rpc.test.ts for the daemon-catch-level coverage of the
 * same contract through the real HTTP route (project-not-found and
 * source-id-not-found cases).
 *
 * These are fast unit tests: no fixture, no embedding provider, no indexed
 * source required — every throw site here fires before any embedding/
 * vector-store call.
 */
import { describe, it, expect } from "vitest";
import { isCallerFacing } from "../src/daemon/caller-error.js";

describe("searchCode — project-not-found is caller-facing", () => {
  it("throws an Error marked callerFacing for a nonexistent project_id", async () => {
    const { searchCode } = await import("../src/search.js");
    await expect(searchCode("some query", "definitely-not-a-registered-project-94")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("Project 'definitely-not-a-registered-project-94' not found");
        expect(isCallerFacing(err)).toBe(true);
        return true;
      }
    );
  });
});

describe("searchKnowledge — project-not-found is caller-facing", () => {
  it("throws an Error marked callerFacing for a nonexistent project_id", async () => {
    const { searchKnowledge } = await import("../src/search.js");
    await expect(searchKnowledge("some query", "definitely-not-a-registered-project-94", 10)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("Project 'definitely-not-a-registered-project-94' not found");
        expect(isCallerFacing(err)).toBe(true);
        return true;
      }
    );
  });
});

describe("searchCode — NO_CODE_SOURCES is caller-facing (searching a source type the project doesn't have)", () => {
  it("a project with zero code sources throws NO_CODE_SOURCES marked callerFacing, string unchanged", async () => {
    const { addProject } = await import("../src/registry.js");
    const { searchCode } = await import("../src/search.js");
    addProject({ id: "plan94-slice2-no-code-sources", description: "no code sources" });

    await expect(searchCode("q", "plan94-slice2-no-code-sources")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("NO_CODE_SOURCES: Project has no indexed code sources");
      expect(isCallerFacing(err)).toBe(true);
      return true;
    });
  });
});

describe("searchKnowledge — source_id-not-found is caller-facing", () => {
  it("a project with no source matching the requested source_id throws NO_KNOWLEDGE_SOURCES marked callerFacing, string unchanged", async () => {
    const { addProject } = await import("../src/registry.js");
    const { searchKnowledge } = await import("../src/search.js");
    addProject({ id: "plan94-slice2-bad-source-id", description: "no matching source_id" });

    await expect(
      searchKnowledge("q", "plan94-slice2-bad-source-id", 10, "bogus-source-id")
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("NO_KNOWLEDGE_SOURCES: No knowledge source with id 'bogus-source-id' found");
      expect(isCallerFacing(err)).toBe(true);
      return true;
    });
  });
});

describe("searchKnowledge — NO_KNOWLEDGE_SOURCES (no sources at all) is caller-facing", () => {
  it("a project with zero knowledge sources throws NO_KNOWLEDGE_SOURCES marked callerFacing, string unchanged", async () => {
    const { addProject } = await import("../src/registry.js");
    const { searchKnowledge } = await import("../src/search.js");
    addProject({ id: "plan94-slice2-empty-project", description: "empty test project" });

    await expect(searchKnowledge("q", "plan94-slice2-empty-project", 10)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("NO_KNOWLEDGE_SOURCES: Project has no indexed knowledge sources");
      expect(isCallerFacing(err)).toBe(true);
      return true;
    });
  });
});
