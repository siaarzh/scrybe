import { getProject, getSource, updateSource, assignTableName, resolveEmbeddingConfig } from "./registry.js";
import {
  loadBranchHashes,
  deleteBranchHashes,
  saveBranchHash,
  removeBranchHash,
} from "./hashes.js";
import { loadCursor, saveCursor, deleteCursor } from "./cursors.js";
import { getPlugin } from "./plugins/index.js";
import type { AnyChunk } from "./plugins/base.js";
import { embedBatched } from "./embedder.js";
import {
  upsert,
  deleteProject,
  createFtsIndex,
  createKnowledgeFtsIndex,
  upsertKnowledge,
  deleteKnowledgeProject,
} from "./vector-store.js";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import type { IndexMode, IndexResult, CodeChunk, KnowledgeChunk } from "./types.js";
import { resolveBranch, resolveBranchForPath } from "./branches.js";
import { scanRef, chunkFileContent } from "./plugins/code.js";
import { getLanguage } from "./chunker.js";
import {
  addTags,
  getAllChunkIdsForSource,
  getChunkIdsForFile,
  removeTagsForBranch,
  removeTagsForFile,
  type BranchTag,
} from "./branch-tags.js";

export interface ProgressReport {
  phase: "scan" | "embed_start" | "embed_batch" | "embed_done";
  projectId: string;
  sourceId: string;
  filesScanned?: number;
  bytesTotal?: number;        // undefined = unknown, fall back to chunk-count display
  filesTotal?: number;
  bytesEmbedded?: number;     // cumulative
  filesEmbedded?: number;     // cumulative distinct files flushed — used for % display
  chunksIndexed?: number;     // cumulative
  batchBytes?: number;
  batchDurationMs?: number;
}

export interface IndexOptions {
  onScanProgress?: (filesScanned: number) => void;
  onEmbedProgress?: (chunksIndexed: number) => void;
  onProgress?: (report: ProgressReport) => void;
  signal?: AbortSignal;
  /** Branch to index. Defaults to current HEAD for code sources; "*" for non-code. */
  branch?: string;
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
  const { onScanProgress, onEmbedProgress, onProgress, signal } = options;

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

  // Non-code sources (tickets, webpages) always use "*" as branch sentinel.
  // Code sources respect the explicit option or auto-resolve from HEAD.
  const branch = isCode
    ? (options.branch ?? resolveBranch(projectId, sourceId))
    : "*";

  // For code sources, detect non-HEAD branch indexing: file content must come from
  // git objects (via scanRef) rather than the working tree, which reflects HEAD only.
  const rootPath = isCode
    ? (source.source_config as { type: "code"; root_path: string }).root_path
    : "";
  const isNonHeadBranch = isCode && rootPath !== "" && branch !== resolveBranchForPath(rootPath);
  const nonHeadContentCache = new Map<string, string>();

  // --- Phase 1: Scan and diff ---
  checkAbort(signal);

  const oldHashes = mode === "full" ? {} : loadBranchHashes(projectId, sourceId, branch);
  if (mode === "full") deleteCursor(projectId, sourceId);
  const cursor = mode === "full" ? null : loadCursor(projectId, sourceId);

  let currentSources: Record<string, string>;
  if (isNonHeadBranch) {
    // Enumerate files from git objects; cache content for the chunk phase.
    currentSources = {};
    for await (const entry of scanRef(rootPath, branch)) {
      const hash = createHash("sha256").update(entry.content).digest("hex");
      currentSources[entry.relPath] = hash;
      nonHeadContentCache.set(entry.relPath, entry.content);
    }
  } else {
    currentSources = await plugin.scanSources(project, source, cursor);
  }

  // When using a cursor, currentSources is a partial set (only recently changed).
  // Merge with oldHashes so the diff only picks up actual changes.
  // Non-HEAD branches always enumerate all files — no cursor merging needed.
  const effectiveCursor = isNonHeadBranch ? null : cursor;
  const merged = effectiveCursor ? { ...oldHashes, ...currentSources } : currentSources;

  let filesScanned = 0;
  for (const _key of Object.keys(merged)) {
    checkAbort(signal);
    filesScanned++;
    onScanProgress?.(filesScanned);
  }

  // With a cursor we can't detect deletions (they won't appear in the partial fetch).
  // Stale vectors are cleaned up on full reindex.
  const toRemove = effectiveCursor
    ? new Set<string>()
    : new Set(Object.keys(oldHashes).filter((p) => !(p in currentSources)));
  const toReindex = new Set(
    Object.keys(merged).filter((p) => oldHashes[p] !== merged[p])
  );

  // Snapshot chunk_ids from removed files BEFORE tags are deleted — they still exist in
  // LanceDB. This enables rename-detection: renamed.ts has the same content-addressed
  // chunk_ids as the old alpha.ts, so we skip re-embedding even after removing alpha.ts tags.
  const preservedFromRemovals = new Set<string>();

  // Full mode: delete this source's data and rebuild from scratch
  if (mode === "full") {
    if (isCode) {
      await deleteProject(projectId, tableName);
    } else {
      await deleteKnowledgeProject(projectId, tableName);
    }
    deleteBranchHashes(projectId, sourceId, branch);
    removeTagsForBranch(projectId, sourceId, branch);
    for (const p of Object.keys(currentSources)) toReindex.add(p);
  } else {
    // Incremental: remove tags for deleted and changed files.
    // We do NOT delete from LanceDB here — orphan chunks are cleaned up by `scrybe gc`.
    // This prevents cross-branch corruption when branches share content-addressed chunk IDs.
    for (const p of toRemove) {
      checkAbort(signal);
      for (const id of getChunkIdsForFile(projectId, sourceId, branch, p)) {
        preservedFromRemovals.add(id);
      }
      removeTagsForFile(projectId, sourceId, branch, p);
      removeBranchHash(projectId, sourceId, branch, p);
    }
    for (const p of toReindex) {
      checkAbort(signal);
      removeTagsForFile(projectId, sourceId, branch, p);
    }
  }

  // Build the skip-embed set AFTER removing stale tags.
  // Any chunk_id still in branch_tags has a valid LanceDB row — safe to skip embedding.
  const alreadyEmbedded = getAllChunkIdsForSource(projectId, sourceId);
  // Also include chunk_ids from files just removed from this branch — still in LanceDB.
  for (const id of preservedFromRemovals) alreadyEmbedded.add(id);

  // --- Phase 2: Chunk + embed changed sources, checkpoint per key ---

  // Compute file-size totals for byte-accurate progress (code sources only).
  // bytesTotal is an approximation — chunk content bytes differ slightly from file bytes
  // due to overlap, but the ratio stays accurate enough for ETA estimation.
  let bytesTotal: number | undefined;
  if (isCode && toReindex.size > 0) {
    let sum = 0;
    if (isNonHeadBranch) {
      for (const relPath of toReindex) {
        const content = nonHeadContentCache.get(relPath);
        if (content) sum += Buffer.byteLength(content, "utf8");
      }
    } else if (rootPath) {
      for (const relPath of toReindex) {
        try { sum += statSync(join(rootPath, relPath)).size; } catch { /* skip missing/unreadable */ }
      }
    }
    if (sum > 0) bytesTotal = sum;
  }

  onProgress?.({ phase: "embed_start", projectId, sourceId, bytesTotal, filesTotal: toReindex.size });

  let chunksIndexed = 0;
  let bytesEmbedded = 0;
  const filesSeenSoFar = new Set<string>();
  const batchSize = config.embedBatchSize;
  const batchDelayMs = config.embedBatchDelayMs;

  // Cross-key accumulator: list of (key, chunks[]) pairs in order
  const keyBatches: Array<{ key: string; chunks: AnyChunk[] }> = [];
  let totalPending = 0;

  async function flushBatch(): Promise<void> {
    if (keyBatches.length === 0) return;

    const batchStart = Date.now();
    const allChunks = keyBatches.flatMap((kb) => kb.chunks);

    // Split into chunks that need embedding vs those already in LanceDB
    const toEmbed = allChunks.filter((c) => !alreadyEmbedded.has(c.chunk_id));

    // Embed only new chunks
    let embedVectors: number[][] = [];
    if (toEmbed.length > 0) {
      const texts = toEmbed.map((c) => c.content);
      embedVectors = await embedBatched(texts, embConfig, batchSize, batchDelayMs);
    }

    // Build chunk_id → vector lookup for newly embedded chunks
    const vectorMap = new Map<string, number[]>(
      toEmbed.map((c, i) => [c.chunk_id, embedVectors[i]])
    );

    // Mark new chunk_ids as known for subsequent flushes in this run
    for (const c of toEmbed) alreadyEmbedded.add(c.chunk_id);

    // Store and checkpoint each key's slice
    for (const { key, chunks } of keyBatches) {
      // Upsert only the newly embedded chunks for this key
      const newKeyChunks = chunks.filter((c) => vectorMap.has(c.chunk_id));
      if (newKeyChunks.length > 0) {
        const keyVectors = newKeyChunks.map((c) => vectorMap.get(c.chunk_id)!);
        if (isCode) {
          await upsert(newKeyChunks as CodeChunk[], keyVectors, tableName, embConfig.dimensions);
        } else {
          await upsertKnowledge(newKeyChunks as KnowledgeChunk[], keyVectors, tableName, embConfig.dimensions);
        }
      }

      // Add branch tags for code chunks only. Non-code sources (tickets, etc.) are
      // branch-agnostic and don't participate in branch-aware search or local GC.
      // Upstream deletion handling belongs to a future `scrybe reconcile` command.
      if (isCode) {
        const tags: BranchTag[] = chunks.map((c) => ({
          projectId,
          sourceId,
          branch,
          filePath: (c as CodeChunk).file_path,
          chunkId: c.chunk_id,
          startLine: (c as CodeChunk).start_line,
          endLine: (c as CodeChunk).end_line,
        }));
        addTags(tags);
      }

      // Checkpoint immediately after this key is processed
      saveBranchHash(projectId, sourceId, branch, key, merged[key]);
    }

    chunksIndexed += allChunks.length;
    onEmbedProgress?.(chunksIndexed);

    for (const { key } of keyBatches) filesSeenSoFar.add(key);
    const batchBytes = toEmbed.reduce((sum, c) => sum + Buffer.byteLength(c.content, "utf8"), 0);
    bytesEmbedded += batchBytes;
    onProgress?.({
      phase: "embed_batch",
      projectId,
      sourceId,
      chunksIndexed,
      bytesEmbedded,
      filesEmbedded: filesSeenSoFar.size,
      batchBytes,
      batchDurationMs: Date.now() - batchStart,
    });

    keyBatches.length = 0;
    totalPending = 0;
  }

  let currentKey: string | null = null;

  const chunkIter = isNonHeadBranch
    ? fetchChunksFromRef(projectId, sourceId, toReindex, nonHeadContentCache)
    : plugin.fetchChunks(project, source, toReindex);

  for await (const chunk of chunkIter) {
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
  onProgress?.({ phase: "embed_done", projectId, sourceId, chunksIndexed, bytesEmbedded });

  // Update last_indexed timestamp (hashes already persisted per-key above)
  const now = new Date().toISOString();
  updateSource(projectId, sourceId, { last_indexed: now });
  // Don't update the cursor for non-HEAD branches — the cursor tracks HEAD-based scan state
  if (!isNonHeadBranch) {
    saveCursor(projectId, sourceId, now);
  }

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

async function* fetchChunksFromRef(
  projectId: string,
  sourceId: string,
  toReindex: Set<string>,
  contentCache: Map<string, string>
): AsyncGenerator<AnyChunk> {
  for (const relPath of toReindex) {
    const content = contentCache.get(relPath);
    if (content == null) continue;
    const lang = getLanguage(basename(relPath)) ?? "";
    yield* chunkFileContent(projectId, sourceId, relPath, content, lang) as AnyChunk[];
  }
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
