import { config } from "./config.js";
import { getProject } from "./registry.js";
import { resolveEmbeddingConfig } from "./registry.js";
import { getPlugin } from "./plugins/index.js";
import { embedQuery } from "./embedder.js";
import {
  search,
  ftsSearch,
  searchKnowledge as vsSearchKnowledge,
  ftsSearchKnowledge,
} from "./vector-store.js";
import { rerank } from "./reranker.js";
import type { SearchResult, KnowledgeSearchResult, Source } from "./types.js";

const MAX_RERANK_CANDIDATES = 500;

function mergeRrfKnowledge(lists: KnowledgeSearchResult[][], k: number): KnowledgeSearchResult[] {
  const scores = new Map<string, number>();
  const byKey = new Map<string, KnowledgeSearchResult>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.project_id}:${r.source_id}:${r.source_path}:${r.content.slice(0, 40)}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
      if (!byKey.has(key)) byKey.set(key, r);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({ ...byKey.get(key)!, score }));
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

function getCodeSources(sources: Source[]): Source[] {
  return sources.filter((s) => {
    try { return getPlugin(s.source_config.type).embeddingProfile === "code"; }
    catch { return false; }
  });
}

function getKnowledgeSources(sources: Source[]): Source[] {
  return sources.filter((s) => {
    try { return getPlugin(s.source_config.type).embeddingProfile === "text"; }
    catch { return false; }
  });
}

export async function searchCode(
  query: string,
  projectId: string,
  topK: number
): Promise<SearchResult[]> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project '${projectId}' not found`);

  const codeSources = getCodeSources(project.sources);
  if (codeSources.length === 0) {
    throw new Error("NO_CODE_SOURCES: Project has no indexed code sources");
  }

  const fetchCount = config.rerankEnabled
    ? Math.min(topK * config.rerankFetchMultiplier, MAX_RERANK_CANDIDATES)
    : topK;

  // Fan out across all code sources in parallel
  const allResults = await Promise.all(
    codeSources
      .filter((s) => s.table_name)
      .map(async (source) => {
        const embConfig = resolveEmbeddingConfig(source);
        const tableName = source.table_name!;
        const queryVec = await embedQuery(query, embConfig);

        if (!config.hybridEnabled) {
          return search(queryVec, projectId, fetchCount, tableName, embConfig.dimensions);
        }

        const [vectorResults, ftsResults] = await Promise.all([
          search(queryVec, projectId, fetchCount, tableName, embConfig.dimensions),
          ftsSearch(query, projectId, fetchCount, tableName).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (/index|fts/i.test(msg)) return [] as SearchResult[];
            throw err;
          }),
        ]);

        if (ftsResults.length === 0) return vectorResults;
        return mergeRrf([vectorResults, ftsResults], config.rrfK);
      })
  );

  const merged = allResults.length === 1 ? allResults[0] : mergeRrf(allResults, config.rrfK);
  if (!config.rerankEnabled || merged.length === 0) return merged.slice(0, topK);
  return rerank(query, merged, topK);
}

export async function searchKnowledge(
  query: string,
  projectId: string,
  topK: number,
  sourceId?: string,
  sourceTypes?: string[]
): Promise<KnowledgeSearchResult[]> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project '${projectId}' not found`);

  let knowledgeSources = getKnowledgeSources(project.sources);
  if (sourceId) {
    knowledgeSources = knowledgeSources.filter((s) => s.source_id === sourceId);
    if (knowledgeSources.length === 0) {
      throw new Error(`NO_KNOWLEDGE_SOURCES: No knowledge source with id '${sourceId}' found`);
    }
  }
  if (knowledgeSources.length === 0) {
    throw new Error("NO_KNOWLEDGE_SOURCES: Project has no indexed knowledge sources");
  }

  const fetchCount = config.rerankEnabled
    ? Math.min(topK * config.rerankFetchMultiplier, MAX_RERANK_CANDIDATES)
    : topK;

  // Fan out across matching knowledge sources in parallel
  const allResults = await Promise.all(
    knowledgeSources
      .filter((s) => s.table_name)
      .map(async (source) => {
        const embConfig = resolveEmbeddingConfig(source);
        const tableName = source.table_name!;
        const queryVec = await embedQuery(query, embConfig);

        let results: KnowledgeSearchResult[];
        if (!config.hybridEnabled) {
          results = await vsSearchKnowledge(queryVec, projectId, fetchCount, tableName, embConfig.dimensions);
        } else {
          const [vectorResults, ftsResults] = await Promise.all([
            vsSearchKnowledge(queryVec, projectId, fetchCount, tableName, embConfig.dimensions),
            ftsSearchKnowledge(query, projectId, fetchCount, tableName).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (/index|fts/i.test(msg)) return [] as KnowledgeSearchResult[];
              throw err;
            }),
          ]);
          results = ftsResults.length === 0
            ? vectorResults
            : mergeRrfKnowledge([vectorResults, ftsResults], config.rrfK);
        }

        // Filter by source_types if specified
        if (sourceTypes && sourceTypes.length > 0) {
          results = results.filter((r) => sourceTypes.includes(r.source_type));
        }

        return results;
      })
  );

  const merged =
    allResults.length === 1
      ? allResults[0]
      : mergeRrfKnowledge(allResults, config.rrfK);

  if (!config.rerankEnabled || merged.length === 0) return merged.slice(0, topK);
  return rerank(query, merged, topK);
}
