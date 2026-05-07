/**
 * Plan 48 — Slice 5: flushBatch defence-in-depth dedup.
 *
 * Tests the `dedupeChunkBatch` helper exported from src/indexer.ts.
 * This helper is called inside flushBatch just before every upsert call to
 * collapse any intra-batch chunk_id duplicates. Scheme-2 chunk_ids are
 * content+path-deterministic so genuine collisions are extremely unlikely,
 * but a future plugin that emits near-identical chunks could reintroduce the
 * pre-v0.31.0 snowball class. This unit test locks the contract permanently.
 */

import { describe, it, expect } from "vitest";
import { dedupeChunkBatch } from "../src/indexer.js";

// Minimal stub that satisfies the `chunk_id` constraint.
interface StubChunk {
  chunk_id: string;
  content: string;
}

function makeChunk(chunk_id: string, content: string = "body"): StubChunk {
  return { chunk_id, content };
}

function makeVector(seed: number): number[] {
  return [seed, seed + 0.1, seed + 0.2, seed + 0.3];
}

describe("dedupeChunkBatch", () => {
  it("returns identical arrays when there are no duplicates", () => {
    const chunks = [makeChunk("aaa"), makeChunk("bbb"), makeChunk("ccc")];
    const vectors = [makeVector(1), makeVector(2), makeVector(3)];

    const result = dedupeChunkBatch(chunks, vectors);

    expect(result.dupesRemoved).toBe(0);
    expect(result.chunks).toHaveLength(3);
    expect(result.vectors).toHaveLength(3);
    expect(result.chunks.map((c) => c.chunk_id)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("collapses K duplicates of one id to a single first-seen row", () => {
    // 5 rows all share the same chunk_id — only the first survives.
    const sharedId = "shared-abc";
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(sharedId, `content-${i}`)
    );
    const vectors = Array.from({ length: 5 }, (_, i) => makeVector(i));

    const result = dedupeChunkBatch(chunks, vectors);

    expect(result.dupesRemoved).toBe(4);
    expect(result.chunks).toHaveLength(1);
    expect(result.vectors).toHaveLength(1);
    expect(result.chunks[0]!.chunk_id).toBe(sharedId);
    // First-seen wins: index 0's content survives
    expect(result.chunks[0]!.content).toBe("content-0");
    expect(result.vectors[0]).toEqual(makeVector(0));
  });

  it("keeps unique ids while collapsing only the duplicated ones", () => {
    // Batch: A B A C B  → deduped: A B C (2 dupes removed)
    const chunks = [
      makeChunk("A"),
      makeChunk("B"),
      makeChunk("A"),   // dupe
      makeChunk("C"),
      makeChunk("B"),   // dupe
    ];
    const vectors = [
      makeVector(1),
      makeVector(2),
      makeVector(3),  // will be dropped
      makeVector(4),
      makeVector(5),  // will be dropped
    ];

    const result = dedupeChunkBatch(chunks, vectors);

    expect(result.dupesRemoved).toBe(2);
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks.map((c) => c.chunk_id)).toEqual(["A", "B", "C"]);
    expect(result.vectors).toEqual([makeVector(1), makeVector(2), makeVector(4)]);
  });

  it("chunks and vectors remain in lock-step after dedup", () => {
    // Verify that each surviving chunk[i].chunk_id is paired with the correct vector.
    const chunks = [
      makeChunk("x1"),
      makeChunk("x2"),
      makeChunk("x1"),  // dupe — drop index 2's vector
      makeChunk("x3"),
    ];
    const vectors = [
      [0.1, 0.1],
      [0.2, 0.2],
      [0.9, 0.9],  // dropped with its dupe chunk
      [0.3, 0.3],
    ];

    const result = dedupeChunkBatch(chunks, vectors);

    expect(result.chunks).toHaveLength(3);
    expect(result.vectors).toHaveLength(3);
    // x1 → first vector; x2 → second vector; x3 → fourth vector
    expect(result.chunks[0]!.chunk_id).toBe("x1");
    expect(result.vectors[0]).toEqual([0.1, 0.1]);
    expect(result.chunks[1]!.chunk_id).toBe("x2");
    expect(result.vectors[1]).toEqual([0.2, 0.2]);
    expect(result.chunks[2]!.chunk_id).toBe("x3");
    expect(result.vectors[2]).toEqual([0.3, 0.3]);
  });

  it("handles an empty batch without error", () => {
    const result = dedupeChunkBatch([], []);

    expect(result.dupesRemoved).toBe(0);
    expect(result.chunks).toHaveLength(0);
    expect(result.vectors).toHaveLength(0);
  });

  it("handles a single-element batch (no dupes possible)", () => {
    const result = dedupeChunkBatch([makeChunk("solo")], [[1, 2, 3]]);

    expect(result.dupesRemoved).toBe(0);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.chunk_id).toBe("solo");
  });

  it("collapses all N rows when every row shares one chunk_id", () => {
    const N = 10;
    const chunks = Array.from({ length: N }, () => makeChunk("single"));
    const vectors = Array.from({ length: N }, (_, i) => [i]);

    const result = dedupeChunkBatch(chunks, vectors);

    expect(result.dupesRemoved).toBe(N - 1);
    expect(result.chunks).toHaveLength(1);
    expect(result.vectors).toHaveLength(1);
  });
});
