import { getProject, getSource, updateSource, assignTableName, resolveEmbeddingConfig } from "./registry.js";
import { loadHashes, saveHashes, deleteHashes } from "./hashes.js";
import { deleteCursor } from "./cursors.js";
import { getPlugin } from "./plugins/index.js";
import { embedBatched } from "./embedder.js";
import {
  upsert,
  deleteProject,
  deleteFileChunks,
  createFtsIndex,
  createKnowledgeFtsIndex,
  upsertKnowledge,
  deleteKnowledgeProject,
  deleteKnowledgeSource,
} from "./vector-store.js";
import { config } from "./config.js";
import type { IndexMode, IndexResult, CodeChunk, KnowledgeChunk } from "./types.js";

export interface IndexOptions {
  onScanProgress?: (filesScanned: number) => void;
  onEmbedProgress?: (chunksIndexed: number) => void;
  signal?: AbortSignal;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("INDEX_CANCELLED");
  }
}

export async function indexSource(
  projectId: string,
  sourceId: string,
  mode: IndexMode,
  options: IndexOptions = {}
): Promise<IndexResult> {
  const { onScanProgress, onEmbedProgress, signal } = options;

  const project = getProject(projectId);
  if (!project) throw new Error(`Project '${projectId}' not found`);

  let source = getSource(projectId, sourceId);
  if (!source) throw new Error(`Source '${sourceId}' not found in project '${projectId}'`);

  // Assign table name on first index (immutable after)
  source = assignTableName(projectId, source);
  const tableName = source.table_name!;

  const plugin = getPlugin(source.source_config.type);
  const isCode = plugin.embeddingProfile === "code";
  const embConfig = resolveEmbeddingConfig(source);

  // --- Phase 1: Scan and diff ---
  checkAbort(signal);

  const oldHashes = mode === "full" ? {} : loadHashes(projectId, sourceId);
  if (mode === "full") deleteCursor(projectId, sourceId);
  const currentSources = await plugin.scanSources(project, source);

  let filesScanned = 0;
  for (const _key of Object.keys(currentSources)) {
    checkAbort(signal);
    filesScanned++;
    onScanProgress?.(filesScanned);
  }

  const toRemove = new Set(
    Object.keys(oldHashes).filter((p) => !(p in currentSources))
  );
  const toReindex = new Set(
    Object.keys(currentSources).filter((p) => oldHashes[p] !== currentSources[p])
  );

  // Full mode: delete this source's data and rebuild from scratch
  if (mode === "full") {
    if (isCode) {
      await deleteProject(projectId, tableName);
    } else {
      await deleteKnowledgeProject(projectId, tableName);
    }
    deleteHashes(projectId, sourceId);
    for (const p of Object.keys(currentSources)) toReindex.add(p);
  } else {
    // Incremental: delete stale chunks
    for (const p of [...toRemove, ...toReindex]) {
      checkAbort(signal);
      if (isCode) {
        await deleteFileChunks(projectId, p, tableName);
      } else {
        await deleteKnowledgeSource(projectId, p, tableName);
      }
    }
  }

  // --- Phase 2: Chunk + embed changed sources ---
  let chunksIndexed = 0;
  const batchSize = config.embedBatchSize;
  const batchDelayMs = config.embedBatchDelayMs;

  let codeBatch: CodeChunk[] = [];
  let knowledgeBatch: KnowledgeChunk[] = [];

  async function flushCode(): Promise<void> {
    if (codeBatch.length === 0) return;
    const texts = codeBatch.map((c) => c.content);
    const vectors = await embedBatched(texts, embConfig, batchSize, batchDelayMs);
    await upsert(codeBatch, vectors, tableName, embConfig.dimensions);
    chunksIndexed += codeBatch.length;
    onEmbedProgress?.(chunksIndexed);
    codeBatch = [];
  }

  async function flushKnowledge(): Promise<void> {
    if (knowledgeBatch.length === 0) return;
    const texts = knowledgeBatch.map((c) => c.content);
    const vectors = await embedBatched(texts, embConfig, batchSize, batchDelayMs);
    await upsertKnowledge(knowledgeBatch, vectors, tableName, embConfig.dimensions);
    chunksIndexed += knowledgeBatch.length;
    onEmbedProgress?.(chunksIndexed);
    knowledgeBatch = [];
  }

  for await (const chunk of plugin.fetchChunks(project, source, toReindex)) {
    checkAbort(signal);
    if (isCode) {
      codeBatch.push(chunk as CodeChunk);
      if (codeBatch.length >= batchSize) await flushCode();
    } else {
      knowledgeBatch.push(chunk as KnowledgeChunk);
      if (knowledgeBatch.length >= batchSize) await flushKnowledge();
    }
  }
  await flushCode();
  await flushKnowledge();

  // Persist hashes and update last_indexed
  saveHashes(projectId, sourceId, currentSources);
  updateSource(projectId, sourceId, { last_indexed: new Date().toISOString() });

  // Rebuild FTS index
  if (config.hybridEnabled) {
    try {
      if (isCode) {
        await createFtsIndex(tableName);
      } else {
        await createKnowledgeFtsIndex(tableName);
      }
    } catch (err) {
      console.warn("[scrybe] FTS index creation failed (hybrid search will fall back to vector-only):", err);
    }
  }

  return {
    status: "ok",
    project_id: projectId,
    source_id: sourceId,
    chunks_indexed: chunksIndexed,
    files_scanned: filesScanned,
    files_reindexed: toReindex.size,
    files_removed: toRemove.size,
  };
}

/**
 * Reindex all sources in a project sequentially.
 */
export async function indexProject(
  projectId: string,
  mode: IndexMode,
  options: IndexOptions = {}
): Promise<IndexResult[]> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project '${projectId}' not found`);

  const results: IndexResult[] = [];
  for (const source of project.sources) {
    const result = await indexSource(projectId, source.source_id, mode, options);
    results.push(result);
  }
  return results;
}
