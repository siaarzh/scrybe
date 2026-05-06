/**
 * Pins the content-addressed chunk_id formula.
 * stampChunkId(raw) = sha256(project_id, source_id, item_path, item_url, item_type, content joined by NUL)
 */
import { describe, it, expect } from "vitest";
import { stampChunkId } from "../src/chunker.js";
import type { RawCodeChunk } from "../src/types.js";

function makeRaw(overrides: Partial<RawCodeChunk> = {}): RawCodeChunk {
  return {
    project_id: "proj",
    source_id: "primary",
    item_path: "src/foo.ts",
    item_url: "",
    item_type: "code",
    content: "const x = 1;",
    start_line: 1,
    end_line: 1,
    language: "typescript",
    symbol_name: "",
    ...overrides,
  };
}

describe("stampChunkId — content-addressed formula", () => {
  it("is deterministic: same inputs produce the same chunk_id", () => {
    const id1 = stampChunkId(makeRaw()).chunk_id;
    const id2 = stampChunkId(makeRaw()).chunk_id;
    expect(id1).toBe(id2);
  });

  it("different project_id with same content → different chunk_id", () => {
    const id1 = stampChunkId(makeRaw({ project_id: "proj-a" })).chunk_id;
    const id2 = stampChunkId(makeRaw({ project_id: "proj-b" })).chunk_id;
    expect(id1).not.toBe(id2);
  });

  it("different item_path with same content → different chunk_id", () => {
    const id1 = stampChunkId(makeRaw({ item_path: "src/foo.ts" })).chunk_id;
    const id2 = stampChunkId(makeRaw({ item_path: "src/bar.ts" })).chunk_id;
    expect(id1).not.toBe(id2);
  });

  it("NUL separator prevents concat collision: project_id='a' source_id='bc' ≠ project_id='ab' source_id='c'", () => {
    const id1 = stampChunkId(makeRaw({ project_id: "a", source_id: "bc" })).chunk_id;
    const id2 = stampChunkId(makeRaw({ project_id: "ab", source_id: "c" })).chunk_id;
    expect(id1).not.toBe(id2);
  });
});
