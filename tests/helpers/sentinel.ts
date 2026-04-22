/**
 * Contract 3 — Sentinel tokens.
 * Returns a unique BM25-friendly token that won't appear in any fixture file.
 * BM25/FTS finds these exactly, bypassing weak-model noise in semantic search.
 */
import { randomBytes } from "crypto";

export function sentinel(label?: string): string {
  const hex = randomBytes(4).toString("hex");
  return label ? `XY_${label}_${hex}` : `XY_${hex}`;
}
