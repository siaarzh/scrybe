import { getProject, getSource, updateSource, assignTableName, resolveEmbeddingConfig } from "./registry.js";
import { loadCursor, saveCursor, deleteCursor } from "./cursors.js";
import { getPlugin } from "./plugins/index.js";
import type { AnyChunk } from "./plugins/base.js";
import { embedBatched, type HalvingSession } from "./embedder.js";
import { readEntry, writeEntry, computeProbeSize } from "./embed-batch-state.js";
import {
  upsert,
  deleteProject,
  createFtsIndex,
  createKnowledgeFtsIndex,
  upsertKnowledge,
  deleteKnowledgeProject,
  compactTableWithGrace,
  pruneIndexOrphans,
  getTableHealth,
  invalidateHealthCache,
  dropTable,
  countTableRows,
} from "./vector-store.js";
import { listManifestsSorted, isManifestClean, getExpectedDimensions } from "./health-probe.js";
import { createHash } from "node:crypto";
import { gitExecOrThrow } from "./util/git-exec.js";
import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import type { IndexMode, IndexResult, CodeChunk, KnowledgeChunk } from "./types.js";
import { withBranchSession, resolveBranchForPath, type BranchTag } from "./branch-state.js";
import { scanRef, chunkFileContent } from "./plugins/code.js";
import { getLanguage } from "./chunker.js";
import { diagEmit } from "./daemon/events.js";

// ─── Indexer debug mode ───────────────────────────────────────────────────────
// Set SCRYBE_DEBUG_INDEXER=1 to emit high-volume per-batch events to daemon-log.jsonl.

function debugEnabled(): boolean {
  return process.env["SCRYBE_DEBUG_INDEXER"] === "1";
}

function debugEmit(record: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
  try {
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), debug: true, ...record }) + "\n", "utf8");
  } catch { /* non-fatal */ }
}

export interface ProgressReport {
  phase: "scan" | "embed_start" | "embed_batch" | "embed_done";
  projectId: string;
  sourceId: string;
  filesScanned?: number;
  bytesTotal?: number;
  filesTotal?: number;
  bytesEmbedded?: number;
  filesEmbedded?: number;
  chunksIndexed?: number;
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

  source = assignTableName(projectId, source);
  const tableName = source.table_name!;

  const plugin = getPlugin(source.source_config.type);
  const isCode = plugin.embeddingProfile === "code";
  const embConfig = resolveEmbeddingConfig(source);

  const rootPath = isCode
    ? (source.source_config as { type: "code"; root_path: string }).root_path
    : "";

  // Non-code sources always use "*" branch sentinel.
  const effectiveBranchInput = isCode ? options.branch : "*";

  return withBranchSession(
    { projectId, sourceId, branch: effectiveBranchInput, rootPath: rootPath || undefined, mode },
    async (session, branch) => {
      const _diagJobStart = Date.now();

      // For code sources: detect non-HEAD branch indexing (content from git objects).
      const isNonHeadBranch = isCode && rootPath !== "" && branch !== resolveBranchForPath(rootPath);

      // Validate that an explicitly supplied branch ref is resolvable before doing any work.
      // git ls-tree silently returns nothing on an unknown ref — this catches that early.
      if (isNonHeadBranch && options.branch !== undefined && rootPath !== "") {
        try {
          gitExecOrThrow(["rev-parse", "--verify", options.branch], { cwd: rootPath });
        } catch {
          throw new Error(
            `branch '${options.branch}' not found locally — try 'origin/${options.branch}' or fetch the ref first`
          );
        }
      }

      const nonHeadContentCache = new Map<string, string>();

      // --- Pre-flight corruption check (full mode only) ---
      if (mode === "full") {
        checkAbort(signal);
        try {
          let pluginProfile: "code" | "knowledge" = isCode ? "code" : "knowledge";
          const expDims = getExpectedDimensions(pluginProfile) ?? embConfig.dimensions;
          const preHealth = await getTableHealth(tableName, { force: true, expectedDimensions: expDims });
          if (preHealth.state === "corrupt") {
            const tableDir = join(config.dataDir, "lancedb", `${tableName}.lance`);
            const versionsDir = join(tableDir, "_versions");
            let repaired = false;

            // Rollback tier: only for manifest_missing_data (not for dim-mismatch or schema errors)
            if (
              preHealth.reasons.length === 1 &&
              preHealth.reasons[0] === "manifest_missing_data" &&
              existsSync(versionsDir)
            ) {
              // Walk manifests newest → oldest; find the first clean one
              const manifests = listManifestsSorted(versionsDir);
              for (const { version } of manifests) {
                if (isManifestClean(tableDir, join(versionsDir, `${version}.manifest`))) {
                  // Attempt Lance restoreToVersion
                  try {
                    const db = await (await import("@lancedb/lancedb")).connect(join(config.dataDir, "lancedb"));
                    const names = await db.tableNames();
                    if (names.includes(tableName)) {
                      const tbl = await db.openTable(tableName);
                      if (typeof (tbl as any).restoreToVersion === "function") {
                        await (tbl as any).restoreToVersion(version);
                        repaired = true;
                        invalidateHealthCache(tableName);
                        debugEmit({ event: "indexer.repaired", projectId, sourceId, method: "rollback", recovered_to_version: version });
                        appendFileSync(
                          process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl"),
                          JSON.stringify({ ts: new Date().toISOString(), event: "health.repaired-via-rollback", projectId, sourceId, recovered_to_version: version }) + "\n",
                          "utf8"
                        );
                      }
                    }
                  } catch { /* rollback API unavailable or failed — fall through to rebuild */ }
                  break;
                }
              }
            }

            // Rebuild tier: drop the table entirely and let the full reindex recreate it
            if (!repaired) {
              try {
                await dropTable(tableName);
                // Also rm the physical directory if it lingers (Lance may not fully purge on drop)
                if (existsSync(tableDir)) {
                  rmSync(tableDir, { recursive: true, force: true });
                }
                invalidateHealthCache(tableName);
                debugEmit({ event: "indexer.repaired", projectId, sourceId, method: "rebuild" });
                appendFileSync(
                  process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl"),
                  JSON.stringify({ ts: new Date().toISOString(), event: "health.repaired-via-rebuild", projectId, sourceId }) + "\n",
                  "utf8"
                );
              } catch { /* non-fatal — table may already be gone */ }
            }
          }
        } catch { /* non-fatal — probe must not block full reindex */ }
      }

      // --- Phase 1: Scan and diff ---
      checkAbort(signal);

      const oldHashes = mode === "full" ? {} : { ...session.priorHashes };
      if (mode === "full") deleteCursor(projectId, sourceId);
      const cursor = mode === "full" ? null : loadCursor(projectId, sourceId);

      let currentSources: Record<string, string>;
      if (isNonHeadBranch) {
        currentSources = {};
        for await (const entry of scanRef(rootPath, branch, projectId, sourceId)) {
          const hash = createHash("sha256").update(entry.content).digest("hex");
          currentSources[entry.relPath] = hash;
          nonHeadContentCache.set(entry.relPath, entry.content);
        }
      } else {
        currentSources = await plugin.scanSources(project, source, cursor);
      }

      // Code sources scan the full filesystem and detect deletions via hash diff —
      // the cursor is irrelevant for them. Only knowledge sources (e.g. GitLab issues)
      // use cursor-based incremental fetching where toRemove must stay empty.
      const effectiveCursor = (isNonHeadBranch || isCode) ? null : cursor;
      const merged = effectiveCursor ? { ...oldHashes, ...currentSources } : currentSources;

      let filesScanned = 0;
      for (const _key of Object.keys(merged)) {
        checkAbort(signal);
        filesScanned++;
        onScanProgress?.(filesScanned);
      }

      const toRemove = effectiveCursor
        ? new Set<string>()
        : new Set(Object.keys(oldHashes).filter((p) => !(p in currentSources)));
      const toReindex = new Set(
        Object.keys(merged).filter((p) => oldHashes[p] !== merged[p])
      );

      debugEmit({
        event: "indexer.phase1",
        projectId,
        sourceId,
        branch,
        mode,
        oldHashesCount: Object.keys(oldHashes).length,
        currentSourcesCount: Object.keys(currentSources).length,
        toRemove: [...toRemove],
        toReindexCount: toReindex.size,
      });

      diagEmit({
        event: "indexer.scan.completed",
        projectId,
        sourceId,
        branch,
        mode,
        files_total: Object.keys(merged).length,
        files_to_reindex: toReindex.size,
        files_to_remove: toRemove.size,
      });

      if (mode === "full") {
        if (isCode) {
          await deleteProject(projectId, tableName);
        } else {
          await deleteKnowledgeProject(projectId, tableName);
        }
        session.wipeBranch();
        for (const p of Object.keys(currentSources)) toReindex.add(p);
      } else {
        // Incremental: remove tags (and hashes) for deleted files.
        // We do NOT delete from LanceDB here — orphan chunks are cleaned up by `scrybe gc`.
        for (const p of toRemove) {
          checkAbort(signal);
          session.applyFile(p, { kind: "removed" });
          debugEmit({ event: "indexer.applyFile", projectId, sourceId, branch, path: p, kind: "removed" });
        }
        // Remove only tags (not hashes) for files that will be re-embedded.
        // Hash will be updated by the "embedded" outcome in flushBatch.
        for (const p of toReindex) {
          checkAbort(signal);
          session.applyFile(p, { kind: "stale-tags-only" });
        }
      }

      // session.knownChunkIds is pre-fetched at session open — it already includes
      // chunk IDs from removed files (they stay in LanceDB after tag removal).
      // No need for a separate preservedFromRemovals set.

      // --- Phase 2: Chunk + embed changed sources, checkpoint per key ---

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
            try { sum += statSync(join(rootPath, relPath)).size; } catch { /* skip */ }
          }
        }
        if (sum > 0) bytesTotal = sum;
      }

      onProgress?.({ phase: "embed_start", projectId, sourceId, bytesTotal, filesTotal: toReindex.size });

      let chunksIndexed = 0;
      let filesReindexed = 0;
      let bytesEmbedded = 0;
      const filesSeenSoFar = new Set<string>();
      let _diagChunksPersisted = 0;
      let _diagCumulativeEmbedded = 0;
      const batchDelayMs = config.embedBatchDelayMs;

      const stateKey = `${projectId}:${sourceId}:${embConfig.base_url ?? "local"}:${embConfig.model}`;
      const stateEntry = embConfig.provider_type !== "local" ? readEntry(stateKey) : null;
      const probeSize = stateEntry !== null ? computeProbeSize(stateEntry, config.embedBatchSize) : config.embedBatchSize;
      const batchSize = probeSize;
      const halvingSession: HalvingSession | undefined = embConfig.provider_type !== "local"
        ? { effectiveBatchSize: probeSize, maxFailed: stateEntry?.maxFailed ?? null, halved: false }
        : undefined;

      const keyBatches: Array<{ key: string; chunks: AnyChunk[] }> = [];
      let totalPending = 0;

      async function flushBatch(): Promise<void> {
        if (keyBatches.length === 0) return;

        const batchStart = Date.now();
        const allChunks = keyBatches.flatMap((kb) => kb.chunks);

        const toEmbed = allChunks.filter((c) => !session.knownChunkIds.has(c.chunk_id));

        let embedVectors: number[][] = [];
        if (toEmbed.length > 0) {
          const texts = toEmbed.map((c) => c.content);
          embedVectors = await embedBatched(texts, embConfig, batchSize, batchDelayMs, halvingSession);
        }

        const vectorMap = new Map<string, number[]>(
          toEmbed.map((c, i) => [c.chunk_id, embedVectors[i]])
        );

        // One upsert call per flushBatch — keeps manifest version count to ~1
        // per batch, so end-of-run optimize() stays cheap.
        const allChunksToWrite: AnyChunk[] = [];
        const allVectorsToWrite: number[][] = [];
        for (const { chunks } of keyBatches) {
          for (const c of chunks) {
            if (vectorMap.has(c.chunk_id)) {
              allChunksToWrite.push(c);
              allVectorsToWrite.push(vectorMap.get(c.chunk_id)!);
            }
          }
        }

        if (allChunksToWrite.length > 0) {
          const _diagRowsBefore = await countTableRows(tableName).catch(() => 0);
          if (isCode) {
            await upsert(allChunksToWrite as CodeChunk[], allVectorsToWrite, tableName, embConfig.dimensions);
          } else {
            await upsertKnowledge(allChunksToWrite as KnowledgeChunk[], allVectorsToWrite, tableName, embConfig.dimensions);
          }
          const _diagRowsAfter = await countTableRows(tableName).catch(() => 0);
          const _diagActuallyAdded = Math.max(0, _diagRowsAfter - _diagRowsBefore);
          _diagChunksPersisted += _diagActuallyAdded;
          diagEmit({
            event: "indexer.write.completed",
            projectId,
            sourceId,
            branch,
            chunks_in_batch: allChunksToWrite.length,
            chunks_actually_added: _diagActuallyAdded,
            cumulative_chunks_persisted: _diagChunksPersisted,
          });
          filesReindexed += keyBatches.filter((kb) => kb.chunks.some((c) => vectorMap.has(c.chunk_id))).length;
        }

        // Test-only: widen conflict window for two-writer race tests.
        const writeDelayMs = parseInt(process.env["SCRYBE_TEST_WRITE_DELAY_MS"] ?? "0", 10);
        if (writeDelayMs > 0) await new Promise((r) => setTimeout(r, writeDelayMs));

        // Per-file checkpoint: save hash + add branch tags atomically.
        // Runs after the single batched upsert — LanceDB write before SQLite checkpoint.
        for (const { key, chunks } of keyBatches) {
          // Checkpoint: save hash + add branch tags atomically.
          // For non-code sources, no tags are recorded (they're branch-agnostic).
          if (isCode) {
            const tags: BranchTag[] = chunks.map((c) => ({
              chunkId: c.chunk_id,
              filePath: (c as CodeChunk).file_path,
              startLine: (c as CodeChunk).start_line,
              endLine: (c as CodeChunk).end_line,
            }));
            session.applyFile(key, { kind: "embedded", hash: merged[key], tags });
          } else {
            // For non-code, only update the hash (no branch tags).
            // We pass empty tags — applyFile still saves the hash.
            session.applyFile(key, { kind: "embedded", hash: merged[key], tags: [] });
          }
        }

        chunksIndexed += allChunks.length;
        onEmbedProgress?.(chunksIndexed);

        for (const { key } of keyBatches) filesSeenSoFar.add(key);
        const batchBytes = toEmbed.reduce((sum, c) => sum + Buffer.byteLength(c.content, "utf8"), 0);
        bytesEmbedded += batchBytes;
        const _diagBatchMs = Date.now() - batchStart;
        onProgress?.({
          phase: "embed_batch",
          projectId,
          sourceId,
          chunksIndexed,
          bytesEmbedded,
          filesEmbedded: filesSeenSoFar.size,
          batchBytes,
          batchDurationMs: _diagBatchMs,
        });

        _diagCumulativeEmbedded += allChunks.length;
        diagEmit({
          event: "indexer.embed.batch",
          projectId,
          sourceId,
          branch,
          batch_size: allChunks.length,
          batch_ms: _diagBatchMs,
          cumulative_chunks_embedded: _diagCumulativeEmbedded,
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

        if (key !== currentKey) {
          keyBatches.push({ key, chunks: [] });
          currentKey = key;
        }
        keyBatches[keyBatches.length - 1].chunks.push(chunk);
        totalPending++;

        if (totalPending >= batchSize) {
          await flushBatch();
          currentKey = null;
        }
      }
      await flushBatch();
      onProgress?.({ phase: "embed_done", projectId, sourceId, chunksIndexed, bytesEmbedded });

      if (halvingSession) {
        const existingMaxFailed = stateEntry?.maxFailed ?? 0;
        writeEntry(stateKey, {
          lastSuccessful: halvingSession.effectiveBatchSize,
          maxFailed: halvingSession.halved ? halvingSession.maxFailed! : existingMaxFailed,
        });
      }

      const now = new Date().toISOString();
      updateSource(projectId, sourceId, { last_indexed: now });
      if (!isNonHeadBranch) {
        saveCursor(projectId, sourceId, now);
      }

      const didWork = toReindex.size + toRemove.size > 0;

      if (didWork && config.hybridEnabled) {
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

      if (didWork) {
        try { await compactTableWithGrace(tableName); } catch { /* non-fatal */ }
        try {
          const pruneResult = await pruneIndexOrphans(tableName);
          if (pruneResult.removed > 0) {
            debugEmit({ event: "indexer.pruneOrphans", projectId, sourceId, ...pruneResult });
          }
        } catch { /* non-fatal */ }
      }

      // Invalidate health cache after any successful reindex — state may have changed.
      invalidateHealthCache(tableName);

      const result = {
        status: "ok" as const,
        project_id: projectId,
        source_id: sourceId,
        chunks_prepared: chunksIndexed,
        chunks_persisted: _diagChunksPersisted,
        files_scanned: filesScanned,
        files_reindexed: filesReindexed,
        files_removed: toRemove.size,
      };

      debugEmit({
        event: "indexer.result",
        projectId,
        sourceId,
        branch,
        mode,
        chunksIndexed,
        filesScanned,
        filesReindexed,
        filesRemoved: toRemove.size,
      });

      diagEmit({
        event: "indexer.job.summary",
        projectId,
        sourceId,
        branch,
        mode,
        files_scanned: filesScanned,
        files_reindexed: filesReindexed,
        chunks_prepared: chunksIndexed,
        chunks_persisted: _diagChunksPersisted,
        total_ms: Date.now() - _diagJobStart,
      });

      return result;
    }
  );
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
