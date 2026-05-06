/**
 * Plan 43 — chunk-ID collision fix + central stamping + field rename.
 * Tests C1, C2, C3.
 */
import { describe, it, expect } from "vitest";
import { stampChunkId } from "../src/chunker.js";
import type { RawKnowledgeChunk, RawCodeChunk } from "../src/types.js";

// ─── C1 — Two issues with identical comment body → distinct chunk_ids ─────────

describe("C1 — identical comment body on different issues → distinct chunk_ids", () => {
  it("same body text, different item_path → different chunk_id", () => {
    const base: Omit<RawKnowledgeChunk, "item_path"> = {
      project_id: "cmx-core",
      source_id: "gitlab-issues",
      item_url: "https://gitlab.example.com/project/issues/1#note_100",
      item_type: "ticket_comment",
      author: "alice",
      timestamp: "2024-01-01T00:00:00Z",
      content: "+1",
    };

    const chunk1 = stampChunkId({ ...base, item_path: "issues/1#note_100" });
    const chunk2 = stampChunkId({ ...base, item_path: "issues/2#note_200" });

    expect(chunk1.chunk_id).not.toBe(chunk2.chunk_id);
  });

  it("same body text on different issue bodies (item_path differs) → different chunk_id", () => {
    const base: Omit<RawKnowledgeChunk, "item_path" | "item_url"> = {
      project_id: "cmx-core",
      source_id: "gitlab-issues",
      item_type: "ticket",
      author: "bob",
      timestamp: "2024-01-01T00:00:00Z",
      content: "lgtm",
    };

    const chunk1 = stampChunkId({ ...base, item_path: "issues/10", item_url: "https://gitlab.example.com/project/issues/10" });
    const chunk2 = stampChunkId({ ...base, item_path: "issues/20", item_url: "https://gitlab.example.com/project/issues/20" });

    expect(chunk1.chunk_id).not.toBe(chunk2.chunk_id);
  });
});

// ─── C2 — Same chunk produces same chunk_id across re-indexing ────────────────

describe("C2 — determinism: same chunk produces the same chunk_id across restarts", () => {
  it("identical RawKnowledgeChunk produces the same chunk_id on repeated calls", () => {
    const raw: RawKnowledgeChunk = {
      project_id: "cmx-core",
      source_id: "gitlab-issues",
      item_path: "issues/42#note_999",
      item_url: "https://gitlab.example.com/project/issues/42#note_999",
      item_type: "ticket_comment",
      author: "carol",
      timestamp: "2024-06-01T12:00:00Z",
      content: "Please see the attached screenshot.",
    };

    const id1 = stampChunkId(raw).chunk_id;
    const id2 = stampChunkId(raw).chunk_id;
    const id3 = stampChunkId({ ...raw }).chunk_id;

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("identical RawCodeChunk produces the same chunk_id on repeated calls", () => {
    const raw: RawCodeChunk = {
      project_id: "myrepo",
      source_id: "code",
      item_path: "src/auth/login.ts",
      item_url: "",
      item_type: "code",
      content: "export function login(user: string): boolean { return true; }",
      start_line: 1,
      end_line: 1,
      language: "typescript",
      symbol_name: "login",
    };

    const id1 = stampChunkId(raw).chunk_id;
    const id2 = stampChunkId(raw).chunk_id;

    expect(id1).toBe(id2);
  });
});

// ─── C3 — Changing item_path or content changes chunk_id ─────────────────────

describe("C3 — changing item_path or content changes chunk_id", () => {
  const base: RawKnowledgeChunk = {
    project_id: "proj",
    source_id: "src",
    item_path: "issues/1",
    item_url: "https://example.com/issues/1",
    item_type: "ticket",
    author: "alice",
    timestamp: "2024-01-01T00:00:00Z",
    content: "original content",
  };

  it("changing only item_path produces a different chunk_id", () => {
    const original = stampChunkId(base).chunk_id;
    const modified = stampChunkId({ ...base, item_path: "issues/2" }).chunk_id;
    expect(original).not.toBe(modified);
  });

  it("changing only content produces a different chunk_id", () => {
    const original = stampChunkId(base).chunk_id;
    const modified = stampChunkId({ ...base, content: "different content" }).chunk_id;
    expect(original).not.toBe(modified);
  });

  it("changing only item_url produces a different chunk_id", () => {
    const original = stampChunkId(base).chunk_id;
    const modified = stampChunkId({ ...base, item_url: "https://example.com/issues/999" }).chunk_id;
    expect(original).not.toBe(modified);
  });

  it("changing only item_type produces a different chunk_id", () => {
    const original = stampChunkId(base).chunk_id;
    const modified = stampChunkId({ ...base, item_type: "ticket_comment" }).chunk_id;
    expect(original).not.toBe(modified);
  });

  it("code chunks with identical content but different file paths → different chunk_id", () => {
    const code: RawCodeChunk = {
      project_id: "myrepo",
      source_id: "code",
      item_path: "src/utils/noop.ts",
      item_url: "",
      item_type: "code",
      content: "export function noop(): void {}",
      start_line: 1,
      end_line: 1,
      language: "typescript",
      symbol_name: "noop",
    };
    const copy: RawCodeChunk = { ...code, item_path: "src/helpers/noop.ts" };

    expect(stampChunkId(code).chunk_id).not.toBe(stampChunkId(copy).chunk_id);
  });
});
