import { getProject } from "./registry.js";
import { loadHashes, saveHashes, deleteHashes, hashFile } from "./hashes.js";
import { walkRepoFiles, chunkRepo } from "./chunker.js";
import { embedBatched } from "./embedder.js";
import { upsert, deleteProject, deleteFileChunks, resetTable } from "./vector-store.js";
import { writeMeta } from "./embedding-meta.js";
import { config } from "./config.js";
import type { IndexMode, IndexResult, CodeChunk } from "./types.js";

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

  // --- Phase 1: Scan and diff ---
  checkAbort(signal);

  const oldHashes = mode === "full" ? {} : loadHashes(projectId);
  const currentFiles: Record<string, string> = {};

  let filesScanned = 0;
  for (const { relPath, absPath } of walkRepoFiles(project.root_path)) {
    checkAbort(signal);
    currentFiles[relPath] = await hashFile(absPath);
    filesScanned++;
    onScanProgress?.(filesScanned);
  }

  const toRemove = new Set(
    Object.keys(oldHashes).filter((p) => !(p in currentFiles))
  );
  const toReindex = new Set(
    Object.keys(currentFiles).filter((p) => oldHashes[p] !== currentFiles[p])
  );

  // Full mode: drop and recreate the table (handles dim changes), rebuild all files
  if (mode === "full") {
    await resetTable();
    deleteHashes(projectId);
    for (const p of Object.keys(currentFiles)) toReindex.add(p);
  } else {
    // Incremental: delete stale chunks
    for (const p of [...toRemove, ...toReindex]) {
      checkAbort(signal);
      await deleteFileChunks(projectId, p);
    }
  }

  // --- Phase 2: Chunk + embed changed files ---
  let chunksIndexed = 0;
  const batchSize = config.embedBatchSize;
  let chunkBatch: CodeChunk[] = [];

  async function flushBatch(): Promise<void> {
    if (chunkBatch.length === 0) return;
    const texts = chunkBatch.map((c) => c.content);
    const vectors = await embedBatched(texts);
    await upsert(chunkBatch, vectors);
    chunksIndexed += chunkBatch.length;
    onEmbedProgress?.(chunksIndexed);
    chunkBatch = [];
  }

  for (const chunk of chunkRepo(projectId, project.root_path, toReindex)) {
    checkAbort(signal);
    chunkBatch.push(chunk);
    if (chunkBatch.length >= batchSize) {
      await flushBatch();
    }
  }
  await flushBatch();

  // Persist hashes and (on full reindex) record the embedding config used
  saveHashes(projectId, currentFiles);
  if (mode === "full") writeMeta();

  return {
    status: "ok",
    project_id: projectId,
    chunks_indexed: chunksIndexed,
    files_scanned: filesScanned,
    files_reindexed: toReindex.size,
    files_removed: toRemove.size,
  };
}
