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

describe("wrong source kind names the right tool", () => {
  async function setup(id: string, kinds: Array<"code" | "knowledge">) {
    const { addProject, addSource } = await import("../src/registry.js");
    addProject({ id, description: "wrong-tool hint" });
    if (kinds.includes("code")) {
      addSource(id, { source_id: "c1", source_config: { type: "code", root_path: "/tmp/none", languages: ["ts"] } });
    }
    if (kinds.includes("knowledge")) {
      addSource(id, { source_id: "k1", source_config: { type: "ticket", provider: "github", base_url: "http://x", project_id: "1", token: "t" } });
    }
  }

  it("searchCode on a knowledge-only project names search_knowledge", async () => {
    const { searchCode } = await import("../src/search.js");
    await setup("plan132-knowledge-only", ["knowledge"]);
    await expect(searchCode("q", "plan132-knowledge-only")).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).toBe(
        "NO_CODE_SOURCES: Project 'plan132-knowledge-only' has no code sources; it has knowledge sources: use search_knowledge"
      );
      expect(isCallerFacing(err)).toBe(true);
      return true;
    });
  });

  it("searchCode on a project with neither kind keeps the old message", async () => {
    const { searchCode } = await import("../src/search.js");
    await setup("plan132-neither-a", []);
    await expect(searchCode("q", "plan132-neither-a")).rejects.toThrow(
      "NO_CODE_SOURCES: Project has no indexed code sources"
    );
  });

  it("searchCode with a sources filter that empties the set keeps the old message", async () => {
    const { searchCode } = await import("../src/search.js");
    await setup("plan132-filter-a", ["code", "knowledge"]);
    await expect(searchCode("q", "plan132-filter-a", { sources: ["nope"] })).rejects.toThrow(
      "NO_CODE_SOURCES: Project has no indexed code sources"
    );
  });

  it("searchKnowledge on a code-only project names search_code", async () => {
    const { searchKnowledge } = await import("../src/search.js");
    await setup("plan132-code-only", ["code"]);
    await expect(searchKnowledge("q", "plan132-code-only", 10)).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).toBe(
        "NO_KNOWLEDGE_SOURCES: Project 'plan132-code-only' has no knowledge sources; it has code sources: use search_code"
      );
      expect(isCallerFacing(err)).toBe(true);
      return true;
    });
  });

  it("searchKnowledge on a project with neither kind keeps the old message", async () => {
    const { searchKnowledge } = await import("../src/search.js");
    await setup("plan132-neither-k", []);
    await expect(searchKnowledge("q", "plan132-neither-k", 10)).rejects.toThrow(
      "NO_KNOWLEDGE_SOURCES: Project has no indexed knowledge sources"
    );
  });

  it("searchKnowledge with a source_id filter that empties the set keeps the old message", async () => {
    const { searchKnowledge } = await import("../src/search.js");
    await setup("plan132-filter-k", ["code", "knowledge"]);
    await expect(searchKnowledge("q", "plan132-filter-k", 10, "nope")).rejects.toThrow(
      "NO_KNOWLEDGE_SOURCES: No knowledge source with id 'nope' found"
    );
  });

  it("the MCP error field carries the tool name and an unchanged error_type", async () => {
    const { searchCode, searchKnowledge } = await import("../src/search.js");
    const { classifyError } = await import("../src/mcp-server.js");
    await setup("plan132-knowledge-only", ["knowledge"]);
    await setup("plan132-code-only", ["code"]);
    const codeErr = await searchCode("q", "plan132-knowledge-only").catch((e: unknown) => e);
    expect(classifyError(codeErr)).toEqual({
      error: "Project 'plan132-knowledge-only' has no code sources; it has knowledge sources: use search_knowledge",
      error_type: "no_code_sources",
    });
    const knowErr = await searchKnowledge("q", "plan132-code-only", 10).catch((e: unknown) => e);
    expect(classifyError(knowErr)).toEqual({
      error: "Project 'plan132-code-only' has no knowledge sources; it has code sources: use search_code",
      error_type: "no_knowledge_sources",
    });
  });
});
