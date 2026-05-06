/**
 * Plan 47 — normalizeContent() unit tests.
 * T1, T2, T6 from the plan's test coverage section.
 */
import { describe, it, expect } from "vitest";
import { normalizeContent } from "../src/normalize.js";
import { makeChunkId } from "../src/chunker.js";

describe("normalizeContent", () => {
  // T6 — preserve trailing whitespace and blank lines (regression guard)
  it("preserves trailing whitespace and blank lines", () => {
    const input = "foo\r\n  trailing  \n\nbar";
    const result = normalizeContent(input);
    expect(result).toBe("foo\n  trailing  \n\nbar");
  });

  it("collapses \\r\\n to \\n", () => {
    expect(normalizeContent("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("collapses lone \\r to \\n", () => {
    expect(normalizeContent("a\rb\rc")).toBe("a\nb\nc");
  });

  it("strips leading UTF-8 BOM", () => {
    const withBom = "﻿const x = 1;";
    expect(normalizeContent(withBom)).toBe("const x = 1;");
  });

  it("is a no-op on already-LF content without BOM", () => {
    const s = "line1\nline2\nline3\n";
    expect(normalizeContent(s)).toBe(s);
  });

  // T1 — CRLF on disk + LF in git → identical chunk_id after normalize
  it("T1: file with CRLF EOL and same file with LF → identical chunk_id after normalize", () => {
    const crlfContent = "const x = 1;\r\nconst y = 2;\r\n";
    const lfContent   = "const x = 1;\nconst y = 2;\n";

    const id1 = makeChunkId("proj", "src", "typescript", normalizeContent(crlfContent));
    const id2 = makeChunkId("proj", "src", "typescript", normalizeContent(lfContent));
    expect(id1).toBe(id2);
  });

  // T2 — UTF-8 BOM on disk + no BOM in git → identical chunk_id after normalize
  it("T2: file with UTF-8 BOM and same file without BOM → identical chunk_id after normalize", () => {
    const withBom    = "﻿const x = 1;\nconst y = 2;\n";
    const withoutBom = "const x = 1;\nconst y = 2;\n";

    const id1 = makeChunkId("proj", "src", "typescript", normalizeContent(withBom));
    const id2 = makeChunkId("proj", "src", "typescript", normalizeContent(withoutBom));
    expect(id1).toBe(id2);
  });
});
