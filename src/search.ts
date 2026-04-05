import { config } from "./config.js";
import { embedQuery } from "./embedder.js";
import { search, ftsSearch, searchKnowledge as vsSearchKnowledge, ftsSearchKnowledge } from "./vector-store.js";
import { rerank } from "./reranker.js";
import type { SearchResult, KnowledgeSearchResult } from "./types.js";

const MAX_RERANK_CANDIDATES = 500;

function mergeRrfKnowledge(lists: KnowledgeSearchResult[][], k: number): KnowledgeSearchResult[] {
  const scores = new Map<string, number>();
  const byPath = new Map<string, KnowledgeSearchResult>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.project_id}:${r.source_path}:${r.content.slice(0, 40)}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
      if (!byPath.has(key)) byPath.set(key, r);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({ ...byPath.get(key)!, score }));
}

function mergeRrf(lists: SearchResult[][], k: number): SearchResult[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, SearchResult>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      scores.set(r.chunk_id, (scores.get(r.chunk_id) ?? 0) + 1 / (k + rank + 1));
      if (!byId.has(r.chunk_id)) byId.set(r.chunk_id, r);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id)!, score }));
}

export async function searchCode(
  query: string,
  projectId: string,
  topK: number
): Promise<SearchResult[]> {
  const queryVec = await embedQuery(query);
  const fetchCount = config.rerankEnabled
    ? Math.min(topK * config.rerankFetchMultiplier, MAX_RERANK_CANDIDATES)
    : topK;

  if (!config.hybridEnabled) {
    // Pure vector path (opt-out via SCRYBE_HYBRID=false)
    const candidates = await search(queryVec, projectId, fetchCount);
    if (!config.rerankEnabled || candidates.length === 0) return candidates.slice(0, topK);
    return rerank(query, candidates, topK);
  }

  // Hybrid path: vector + FTS in parallel
  const [vectorResults, ftsResults] = await Promise.all([
    search(queryVec, projectId, fetchCount),
    ftsSearch(query, projectId, fetchCount).catch((err: unknown) => {
      // Graceful fallback if FTS index doesn't exist yet
      const msg = err instanceof Error ? err.message : String(err);
      if (/index|fts/i.test(msg)) return [] as SearchResult[];
      throw err;
    }),
  ]);

  if (ftsResults.length === 0) {
    // FTS unavailable — behave as pure vector
    if (!config.rerankEnabled || vectorResults.length === 0) return vectorResults.slice(0, topK);
    return rerank(query, vectorResults, topK);
  }

  const merged = mergeRrf([vectorResults, ftsResults], config.rrfK);
  if (!config.rerankEnabled || merged.length === 0) return merged.slice(0, topK);
  return rerank(query, merged, topK);
}

export async function searchKnowledge(
  query: string,
  projectId: string,
  topK: number
): Promise<KnowledgeSearchResult[]> {
  const queryVec = await embedQuery(query, "text");
  const fetchCount = config.rerankEnabled
    ? Math.min(topK * config.rerankFetchMultiplier, MAX_RERANK_CANDIDATES)
    : topK;

  if (!config.hybridEnabled) {
    const candidates = await vsSearchKnowledge(queryVec, projectId, fetchCount);
    return candidates.slice(0, topK);
  }

  const [vectorResults, ftsResults] = await Promise.all([
    vsSearchKnowledge(queryVec, projectId, fetchCount),
    ftsSearchKnowledge(query, projectId, fetchCount).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/index|fts/i.test(msg)) return [] as KnowledgeSearchResult[];
      throw err;
    }),
  ]);

  if (ftsResults.length === 0) {
    if (!config.rerankEnabled || vectorResults.length === 0) return vectorResults.slice(0, topK);
    return rerank(query, vectorResults, topK);
  }

  const merged = mergeRrfKnowledge([vectorResults, ftsResults], config.rrfK);
  if (!config.rerankEnabled || merged.length === 0) return merged.slice(0, topK);
  return rerank(query, merged, topK);
}
