/**
 * Pins the content-addressed chunk_id formula.
 * makeChunkId(projectId, sourceId, language, content) = sha256(fields joined by NUL)
 */
import { describe, it, expect } from "vitest";

describe("makeChunkId — content-addressed formula", () => {
  it("is deterministic: same inputs produce the same id", async () => {
    const { makeChunkId } = await import("../src/chunker.js");
    const id1 = makeChunkId("proj", "primary", "typescript", "const x = 1;");
    const id2 = makeChunkId("proj", "primary", "typescript", "const x = 1;");
    expect(id1).toBe(id2);
  });

  it("different projectId with same content → different id", async () => {
    const { makeChunkId } = await import("../src/chunker.js");
    const id1 = makeChunkId("proj-a", "primary", "typescript", "const x = 1;");
    const id2 = makeChunkId("proj-b", "primary", "typescript", "const x = 1;");
    expect(id1).not.toBe(id2);
  });

  it("different language with same content → different id", async () => {
    const { makeChunkId } = await import("../src/chunker.js");
    const id1 = makeChunkId("proj", "primary", "typescript", "const x = 1;");
    const id2 = makeChunkId("proj", "primary", "javascript", "const x = 1;");
    expect(id1).not.toBe(id2);
  });

  it("NUL separator prevents concat collision: projectId='a' sourceId='bc' ≠ projectId='ab' sourceId='c'", async () => {
    const { makeChunkId } = await import("../src/chunker.js");
    const id1 = makeChunkId("a", "bc", "typescript", "content");
    const id2 = makeChunkId("ab", "c", "typescript", "content");
    expect(id1).not.toBe(id2);
  });
});
