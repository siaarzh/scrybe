import { getProject, getSource, updateSource, assignTableName, resolveEmbeddingConfig } from "./registry.js";
import { loadHashes, deleteHashes, saveHash, removeHash } from "./hashes.js";
import { loadCursor, saveCursor, deleteCursor } from "./cursors.js";
import { getPlugin } from "./plugins/index.js";
import type { AnyChunk } from "./plugins/base.js";
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
  const cursor = mode === "full" ? null : loadCursor(projectId, sourceId);
  const currentSources = await plugin.scanSources(project, source, cursor);

  // When using a cursor, currentSources is a partial set (only recently changed).
  // Merge with oldHashes so the diff only picks up actual changes.
  const merged = cursor ? { ...oldHashes, ...currentSources } : currentSources;

  let filesScanned = 0;
  for (const _key of Object.keys(merged)) {
    checkAbort(signal);
    filesScanned++;
    onScanProgress?.(filesScanned);
  }

  // With a cursor we can't detect deletions (they won't appear in the partial fetch).
  // Stale vectors are cleaned up on full reindex.
  const toRemove = cursor
    ? new Set<string>()
    : new Set(Object.keys(oldHashes).filter((p) => !(p in currentSources)));
  const toReindex = new Set(
    Object.keys(merged).filter((p) => oldHashes[p] !== merged[p])
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
    // Incremental: delete stale chunks and checkpoint each removal immediately
    for (const p of toRemove) {
      checkAbort(signal);
      if (isCode) {
        await deleteFileChunks(projectId, p, tableName);
      } else {
        await deleteKnowledgeSource(projectId, p, tableName);
      }
      removeHash(projectId, sourceId, p);
    }
    // Pre-delete chunks that will be re-embedded (hash update happens after embed)
    for (const p of toReindex) {
      checkAbort(signal);
      if (isCode) {
        await deleteFileChunks(projectId, p, tableName);
      } else {
        await deleteKnowledgeSource(projectId, p, tableName);
      }
    }
  }

  // --- Phase 2: Chunk + embed changed sources, checkpoint per key ---
  // Chunks are accumulated across keys up to embedBatchSize for efficient embedding,
  // but checkpointed per key after their slice is stored.
  let chunksIndexed = 0;
  const batchSize = config.embedBatchSize;
  const batchDelayMs = config.embedBatchDelayMs;

  // Cross-key accumulator: list of (key, chunks[]) pairs in order
  const keyBatches: Array<{ key: string; chunks: AnyChunk[] }> = [];
  let totalPending = 0;

  async function flushBatch(): Promise<void> {
    if (keyBatches.length === 0) return;

    // Embed all pending chunks in one call
    const allChunks = keyBatches.flatMap((kb) => kb.chunks);
    const texts = allChunks.map((c) => c.content);
    const vectors = await embedBatched(texts, embConfig, batchSize, batchDelayMs);

    // Store and checkpoint each key's slice
    let offset = 0;
    for (const { key, chunks } of keyBatches) {
      const keyVectors = vectors.slice(offset, offset + chunks.length);
      offset += chunks.length;

      if (isCode) {
        await upsert(chunks as CodeChunk[], keyVectors, tableName, embConfig.dimensions);
      } else {
        await upsertKnowledge(chunks as KnowledgeChunk[], keyVectors, tableName, embConfig.dimensions);
      }

      // Checkpoint immediately after this key is stored
      saveHash(projectId, sourceId, key, merged[key]);
    }

    chunksIndexed += allChunks.length;
    onEmbedProgress?.(chunksIndexed);

    keyBatches.length = 0;
    totalPending = 0;
  }

  let currentKey: string | null = null;

  for await (const chunk of plugin.fetchChunks(project, source, toReindex)) {
    checkAbort(signal);
    const key = isCode
      ? (chunk as CodeChunk).file_path
      : (chunk as KnowledgeChunk).source_path;

    // Start a new key entry when the key changes
    if (key !== currentKey) {
      keyBatches.push({ key, chunks: [] });
      currentKey = key;
    }
    keyBatches[keyBatches.length - 1].chunks.push(chunk);
    totalPending++;

    // Flush when we've accumulated a full batch
    if (totalPending >= batchSize) {
      await flushBatch();
      currentKey = null;
    }
  }
  await flushBatch();

  // Update last_indexed timestamp (hashes already persisted per-key above)
  const now = new Date().toISOString();
  updateSource(projectId, sourceId, { last_indexed: now });
  saveCursor(projectId, sourceId, now);

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
