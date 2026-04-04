import { config } from "./config.js";
import { embedQuery } from "./embedder.js";
import { search } from "./vector-store.js";
import { rerank } from "./reranker.js";
import type { SearchResult } from "./types.js";

const MAX_RERANK_CANDIDATES = 500;

export async function searchCode(
  query: string,
  projectId: string,
  topK: number
): Promise<SearchResult[]> {
  const queryVec = await embedQuery(query);

  if (!config.rerankEnabled) {
    return search(queryVec, projectId, topK);
  }

  const fetchCount = Math.min(topK * config.rerankFetchMultiplier, MAX_RERANK_CANDIDATES);
  const candidates = await search(queryVec, projectId, fetchCount);

  if (candidates.length === 0) return [];

  return rerank(query, candidates, topK);
}
