/**
 * Plan 42 Slice 4 — MCP + CLI output surface: metadata parsing.
 *
 * Verifies that `parseKnowledgeMetadata` (and by extension the MCP/CLI boundary)
 * correctly parses raw JSON strings from `KnowledgeSearchResult` into structured
 * values. No I/O — pure unit tests on the parse helper.
 *
 * Acceptance gates:
 *   - labels='["a","b"]' → labels: ["a","b"]
 *   - confidential='true' → confidential: true
 *   - empty milestone='' → milestone: null
 *   - malformed JSON does not throw (defaults: labels=[], assignees=[], milestone=null)
 *   - state is preserved / empty state → null
 */

import { describe, it, expect } from "vitest";
import { parseKnowledgeMetadata } from "../src/tools/search.js";
import type { KnowledgeSearchResult } from "../src/types.js";

function makeRaw(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    score: 0.9,
    project_id: "test",
    source_id: "issues",
    item_path: "issues/1",
    item_url: "https://example.com/issues/1",
    item_type: "ticket",
    author: "alice",
    timestamp: "2024-06-01T00:00:00Z",
    content: "some content",
    state: "",
    labels: "",
    assignees: "",
    milestone: "",
    confidential: "",
    ...overrides,
  };
}

describe("Plan 42 Slice 4 — parseKnowledgeMetadata", () => {
  it("parses labels JSON array string to string[]", () => {
    const result = parseKnowledgeMetadata(makeRaw({ labels: '["a","b"]' }));
    expect(result.labels).toEqual(["a", "b"]);
  });

  it("parses empty labels to []", () => {
    const result = parseKnowledgeMetadata(makeRaw({ labels: "" }));
    expect(result.labels).toEqual([]);
  });

  it("parses assignees JSON array string to string[]", () => {
    const result = parseKnowledgeMetadata(makeRaw({ assignees: '["alice","bob"]' }));
    expect(result.assignees).toEqual(["alice", "bob"]);
  });

  it("parses milestone JSON object string to object", () => {
    const result = parseKnowledgeMetadata(makeRaw({
      milestone: '{"title":"26.4","due_date":"2026-07-01"}',
    }));
    expect(result.milestone).toEqual({ title: "26.4", due_date: "2026-07-01" });
  });

  it("returns null for empty milestone string", () => {
    const result = parseKnowledgeMetadata(makeRaw({ milestone: "" }));
    expect(result.milestone).toBeNull();
  });

  it("parses confidential='true' to boolean true", () => {
    const result = parseKnowledgeMetadata(makeRaw({ confidential: "true" }));
    expect(result.confidential).toBe(true);
  });

  it("parses confidential='false' to boolean false", () => {
    const result = parseKnowledgeMetadata(makeRaw({ confidential: "false" }));
    expect(result.confidential).toBe(false);
  });

  it("parses confidential='' to boolean false", () => {
    const result = parseKnowledgeMetadata(makeRaw({ confidential: "" }));
    expect(result.confidential).toBe(false);
  });

  it("preserves state string", () => {
    const result = parseKnowledgeMetadata(makeRaw({ state: "open" }));
    expect(result.state).toBe("open");
  });

  it("maps empty state to null", () => {
    const result = parseKnowledgeMetadata(makeRaw({ state: "" }));
    expect(result.state).toBeNull();
  });

  it("does not throw on malformed labels JSON — defaults to []", () => {
    expect(() => parseKnowledgeMetadata(makeRaw({ labels: "{not-json[" }))).not.toThrow();
    const result = parseKnowledgeMetadata(makeRaw({ labels: "{not-json[" }));
    expect(result.labels).toEqual([]);
  });

  it("does not throw on malformed assignees JSON — defaults to []", () => {
    expect(() => parseKnowledgeMetadata(makeRaw({ assignees: "not-json" }))).not.toThrow();
    const result = parseKnowledgeMetadata(makeRaw({ assignees: "not-json" }));
    expect(result.assignees).toEqual([]);
  });

  it("does not throw on malformed milestone JSON — defaults to null", () => {
    expect(() => parseKnowledgeMetadata(makeRaw({ milestone: "{broken:" }))).not.toThrow();
    const result = parseKnowledgeMetadata(makeRaw({ milestone: "{broken:" }));
    expect(result.milestone).toBeNull();
  });

  it("does not throw on non-array labels JSON (e.g. a string) — defaults to []", () => {
    // JSON.parse('"a string"') is valid JSON but not an array
    const result = parseKnowledgeMetadata(makeRaw({ labels: '"a string"' }));
    expect(result.labels).toEqual([]);
  });
});
