import { getProject, updateProject } from "./registry.js";
import { loadHashes, saveHashes, deleteHashes } from "./hashes.js";
import { deleteCursor } from "./cursors.js";
import { getPlugin } from "./plugins/index.js";
import { embedBatched } from "./embedder.js";
import {
  upsert,
  deleteProject,
  deleteFileChunks,
  resetTable,
  createFtsIndex,
  createKnowledgeFtsIndex,
  upsertKnowledge,
  deleteKnowledgeProject,
  deleteKnowledgeSource,
  resetKnowledgeTable,
} from "./vector-store.js";
import { writeMeta } from "./embedding-meta.js";
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

export async function indexProject(
  projectId: string,
  mode: IndexMode,
  options: IndexOptions = {}
): Promise<IndexResult> {
  const { onScanProgress, onEmbedProgress, signal } = options;
  const project = getProject(projectId);
  if (!project) throw new Error(`Project '${projectId}' not found`);

  const sourceType = project.source_config?.type ?? "code";
  const plugin = getPlugin(sourceType);
  const isCode = plugin.embeddingProfile === "code";

  // --- Phase 1: Scan and diff ---
  checkAbort(signal);

  const oldHashes = mode === "full" ? {} : loadHashes(projectId);
  if (mode === "full") deleteCursor(projectId);
  const currentSources = await plugin.scanSources(project);

  let filesScanned = 0;
  for (const key of Object.keys(currentSources)) {
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

  // Full mode: drop and recreate the table, rebuild everything
  if (mode === "full") {
    if (isCode) {
      await resetTable();
    } else {
      await resetKnowledgeTable();
    }
    deleteHashes(projectId);
    for (const p of Object.keys(currentSources)) toReindex.add(p);
  } else {
    // Incremental: delete stale chunks
    for (const p of [...toRemove, ...toReindex]) {
      checkAbort(signal);
      if (isCode) {
        await deleteFileChunks(projectId, p);
      } else {
        await deleteKnowledgeSource(projectId, p);
      }
    }
  }

  // --- Phase 2: Chunk + embed changed sources ---
  let chunksIndexed = 0;
  const batchSize = config.embedBatchSize;

  let codeBatch: CodeChunk[] = [];
  let knowledgeBatch: KnowledgeChunk[] = [];

  async function flushCode(): Promise<void> {
    if (codeBatch.length === 0) return;
    const texts = codeBatch.map((c) => c.content);
    const vectors = await embedBatched(texts, "code");
    await upsert(codeBatch, vectors);
    chunksIndexed += codeBatch.length;
    onEmbedProgress?.(chunksIndexed);
    codeBatch = [];
  }

  async function flushKnowledge(): Promise<void> {
    if (knowledgeBatch.length === 0) return;
    const texts = knowledgeBatch.map((c) => c.content);
    const vectors = await embedBatched(texts, "text");
    await upsertKnowledge(knowledgeBatch, vectors);
    chunksIndexed += knowledgeBatch.length;
    onEmbedProgress?.(chunksIndexed);
    knowledgeBatch = [];
  }

  for await (const chunk of plugin.fetchChunks(project, toReindex)) {
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

  // Persist hashes and (on full reindex) record embedding config used
  saveHashes(projectId, currentSources);
  if (mode === "full") writeMeta();
  updateProject(projectId, { last_indexed: new Date().toISOString() });

  // Rebuild FTS index
  if (config.hybridEnabled) {
    try {
      if (isCode) {
        await createFtsIndex();
      } else {
        await createKnowledgeFtsIndex();
      }
    } catch (err) {
      console.warn("[scrybe] FTS index creation failed (hybrid search will fall back to vector-only):", err);
    }
  }

  return {
    status: "ok",
    project_id: projectId,
    chunks_indexed: chunksIndexed,
    files_scanned: filesScanned,
    files_reindexed: toReindex.size,
    files_removed: toRemove.size,
  };
}

// Keep legacy re-export for any external callers
export { deleteProject, deleteKnowledgeProject };
