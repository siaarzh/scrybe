import { getProject, getSource, updateSource, assignTableName, resolveEmbeddingConfig } from "./registry.js";
import { loadCursor, saveCursor, deleteCursor } from "./cursors.js";
import { getPlugin } from "./plugins/index.js";
import type { AnyChunk } from "./plugins/base.js";
import { embedBatched, getCharCap, type HalvingSession } from "./embedder.js";
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
import { gitExec, gitExecOrThrow } from "./util/git-exec.js";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import type { IndexMode, IndexResult, CodeChunk, KnowledgeChunk } from "./types.js";
import { withBranchSession, resolveBranchForPath, setLastIndexedSha, type BranchTag } from "./branch-state.js";
import { scanRef, chunkFileContent } from "./plugins/code.js";
import { getLanguage, walkRepoFiles } from "./chunker.js";
import { normalizeContent } from "./normalize.js";
import { diagEmit } from "./daemon/events.js";
import {
  withPhase,
  startSegmentedPhase,
  emitJobIntent,
  type PhaseJobContext,
} from "./daemon/phase-telemetry.js";
import { recordUpsertForRebuildCadence, markFullReindexForRebuild } from "./daemon/vector-index-backfill.js";

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
  /** Called during local model download (0-100 percent). Only fires for local provider on first cold load. */
  onDownloadProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Branch to index (label stored in branch_tags / branch_state). Defaults to current HEAD for code sources; "*" for non-code. */
  branch?: string;
  /**
   * Git ref used to read content (git ls-tree, rev-parse). When absent, falls back to `branch`.
   * Set this to `origin/<branch>` for pinned branches so the indexer reads from the
   * remote-tracking ref rather than a local branch that may not exist or may lag upstream.
   * The stored label in branch_tags and branch_state is always `branch`, never `contentRef`.
   */
  contentRef?: string;
  /**
   * Daemon job id, threaded through purely so per-phase memory records
   * (`phase-log.jsonl`) can be joined to the job's `activity-span` in
   * `daemon-log.jsonl`. Absent for direct CLI / wizard calls.
   */
  jobId?: string;
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
  const { onScanProgress, onEmbedProgress, onProgress, onDownloadProgress, signal } = options;

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

  // contentRef is the git ref used to read content (ls-tree, rev-parse).
  // For pinned branches the poller sets contentRef = "origin/<branch>" so the indexer
  // reads from the remote-tracking ref; `branch` remains the logical label stored in
  // branch_tags and branch_state.  When no contentRef is given, fall back to branch.
  const effectiveContentRef = isCode ? (options.contentRef ?? options.branch) : undefined;

  return withBranchSession(
    { projectId, sourceId, branch: effectiveBranchInput, rootPath: rootPath || undefined, mode },
    async (session, branch) => {
      const jobStart = Date.now();

      // Identity stamped on every per-phase memory record for this job.
      const phaseCtx: PhaseJobContext = {
        projectId,
        sourceId,
        jobId: options.jobId ?? null,
        branch,
        mode,
      };
      emitJobIntent(phaseCtx, "started", { is_code: isCode });

      // The git ref used for content reads (SHA capture, ls-tree). Uses contentRef when
      // provided (pinned branches read from origin/<branch>); falls back to the label branch.
      const gitRef = effectiveContentRef ?? branch;

      // Capture the SHA at indexer start (code sources only). Used to record the
      // last-indexed SHA in branch_state on successful completion.
      const indexedShaAtStart: string | null = (isCode && rootPath !== "")
        ? (gitExec(["rev-parse", gitRef], { cwd: rootPath }) ?? null)
        : null;

      // For code sources: detect non-HEAD branch indexing (content from git objects).
      const isNonHeadBranch = isCode && rootPath !== "" && branch !== resolveBranchForPath(rootPath);

      // Validate that the content ref is resolvable before doing any work.
      // git ls-tree silently returns nothing on an unknown ref — this catches that early.
      if (isNonHeadBranch && rootPath !== "") {
        const refToVerify = effectiveContentRef ?? options.branch;
        if (refToVerify !== undefined) {
          try {
            gitExecOrThrow(["rev-parse", "--verify", refToVerify], { cwd: rootPath });
          } catch {
            const hint = refToVerify.startsWith("origin/")
              ? "fetch the ref first"
              : `try 'origin/${refToVerify}' or fetch the ref first`;
            throw new Error(`branch '${refToVerify}' not found locally — ${hint}`);
          }
        }
      }

      const nonHeadContentCache = new Map<string, string>();

      // --- Pre-flight corruption check (full mode only) ---
      if (mode === "full") {
        checkAbort(signal);
        // Phase `preflight_health`. NOTE: every expensive step in here
        // (getTableHealth, restoreToVersion, dropTable, rmSync) is a single
        // blocking native/sync call, so the poll timer never gets a tick and
        // there is no loop to sample from. peakRssBytes for this phase is
        // therefore max(entry, exit) — treat it as two-point, not a true
        // high-water mark.
        await withPhase(phaseCtx, "preflight_health", async (phase) => {
        phase.setWork({ table_state: "unknown", repaired: "none" });
        try {
          let pluginProfile: "code" | "knowledge" = isCode ? "code" : "knowledge";
          const expDims = getExpectedDimensions(pluginProfile) ?? embConfig.dimensions;
          const preHealth = await getTableHealth(tableName, { force: true, expectedDimensions: expDims });
          phase.setWork({ table_state: preHealth.state });
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
                        phase.setWork({ repaired: "rollback" });
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
                phase.setWork({ repaired: "rebuild" });
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
        });
      }

      // --- Phase 1: Scan and diff ---
      checkAbort(signal);

      const oldHashes = mode === "full" ? {} : { ...session.priorHashes };
      if (mode === "full") deleteCursor(projectId, sourceId);
      const cursor = mode === "full" ? null : loadCursor(projectId, sourceId);

      // Phase `scan` — enumerate the source's current state. Two shapes:
      //   - non-HEAD branch: streams every blob out of the git ref and keeps
      //     the full content in `nonHeadContentCache`, so this phase's RSS
      //     growth is the whole tree. It has a per-entry loop, so it is sampled
      //     properly.
      //   - everything else: one opaque `plugin.scanSources()` call. For ticket
      //     sources that awaits network paging, so the poll timer does tick.
      //     For code sources it is a synchronous filesystem walk that blocks
      //     the event loop end to end — the peak there is max(entry, exit).
      const currentSources: Record<string, string> = await withPhase(phaseCtx, "scan", async (phase) => {
        if (isNonHeadBranch) {
          const scanned: Record<string, string> = {};
          let contentBytes = 0;
          // Use gitRef (contentRef ?? branch) so pinned branches read from origin/<branch>
          // while `branch` (the label) remains the logical name stored in branch_tags.
          for await (const entry of scanRef(rootPath, gitRef, projectId, sourceId)) {
            const hash = createHash("sha256").update(entry.content).digest("hex");
            scanned[entry.relPath] = hash;
            nonHeadContentCache.set(entry.relPath, entry.content);
            contentBytes += Buffer.byteLength(entry.content, "utf8");
            phase.sample();
          }
          phase.setWork({
            scan_kind: "git-ref",
            sources_found: Object.keys(scanned).length,
            cached_content_bytes: contentBytes,
          });
          return scanned;
        }
        const scanned = await plugin.scanSources(project, source, cursor);
        phase.setWork({
          scan_kind: isCode ? "working-tree" : "plugin-fetch",
          sources_found: Object.keys(scanned).length,
          cursor_used: cursor !== null,
        });
        return scanned;
      });

      // Code sources scan the full filesystem and detect deletions via hash diff —
      // the cursor is irrelevant for them. Only knowledge sources (e.g. GitLab issues)
      // use cursor-based incremental fetching where toRemove must stay empty.
      const effectiveCursor = (isNonHeadBranch || isCode) ? null : cursor;
      const merged = effectiveCursor ? { ...oldHashes, ...currentSources } : currentSources;

      // Phase `diff` — decide what changed. Pure JS and fully synchronous, so
      // the poll timer cannot tick; the explicit samples below are the only
      // interior readings. Sampled every 256th key rather than every key: the
      // loop body is otherwise a counter increment, and a ~8µs
      // process.memoryUsage.rss() per file would dominate the phase it measures.
      const { filesScanned, toRemove, toReindex } = await withPhase(phaseCtx, "diff", async (phase) => {
        let scanned = 0;
        for (const _key of Object.keys(merged)) {
          checkAbort(signal);
          scanned++;
          if ((scanned & 0xff) === 0) phase.sample();
          onScanProgress?.(scanned);
        }

        const removing = effectiveCursor
          ? new Set<string>()
          : new Set(Object.keys(oldHashes).filter((p) => !(p in currentSources)));
        const reindexing = new Set(
          Object.keys(merged).filter((p) => oldHashes[p] !== merged[p])
        );

        phase.setWork({
          files_total: Object.keys(merged).length,
          prior_hashes: Object.keys(oldHashes).length,
          files_to_reindex: reindexing.size,
          files_to_remove: removing.size,
        });
        return { filesScanned: scanned, toRemove: removing, toReindex: reindexing };
      });

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

      // What this job was told to do, recorded before any of the expensive work
      // starts. A job that processes nothing but allocates GB is the case we
      // most need to see, and this is what separates it from "killed before it
      // could write anything".
      emitJobIntent(phaseCtx, "planned", {
        files_total: Object.keys(merged).length,
        files_to_reindex: mode === "full" ? Object.keys(currentSources).length : toReindex.size,
        files_to_remove: toRemove.size,
        is_non_head_branch: isNonHeadBranch,
        provider: embConfig.provider_type ?? "unknown",
      });

      // Phase `stale_apply` — wipe (full) or un-tag (incremental) whatever the
      // diff condemned, then measure the byte size of what is about to be read.
      // The full-mode branch is one blocking LanceDB delete; the incremental
      // branch is a SQLite write loop. Neither yields to the event loop, so the
      // samples below are placed in the loops themselves.
      const bytesTotal: number | undefined = await withPhase(phaseCtx, "stale_apply", async (phase) => {
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
          phase.sample();
          debugEmit({ event: "indexer.applyFile", projectId, sourceId, branch, path: p, kind: "removed" });
        }
        // Remove only tags (not hashes) for files that will be re-embedded.
        // Hash will be updated by the "embedded" outcome in flushBatch.
        for (const p of toReindex) {
          checkAbort(signal);
          session.applyFile(p, { kind: "stale-tags-only" });
          phase.sample();
        }
      }

      // session.knownChunkIds is pre-fetched at session open — it already includes
      // chunk IDs from removed files (they stay in LanceDB after tag removal).
      // No need for a separate preservedFromRemovals set.

      // --- Phase 2: Chunk + embed changed sources, checkpoint per key ---

      let sized: number | undefined;
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
            phase.sample();
          }
        }
        if (sum > 0) sized = sum;
      }

      phase.setWork({
        files_to_reindex: toReindex.size,
        files_to_remove: toRemove.size,
        known_chunk_ids: session.knownChunkIds.size,
        bytes_to_read: sized ?? 0,
      });
      return sized;
      });

      onProgress?.({ phase: "embed_start", projectId, sourceId, bytesTotal, filesTotal: toReindex.size });

      let chunksIndexed = 0;
      let filesReindexed = 0;
      let bytesEmbedded = 0;
      const filesSeenSoFar = new Set<string>();
      let chunksPersisted = 0;
      let cumulativeEmbedded = 0;
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

      // Thread download progress callback — only fires during local model first load.
      const dlProgressCb = onDownloadProgress
        ? (p: { percent: number }) => onDownloadProgress(p.percent)
        : undefined;

      // Phase `chunk_embed` — the streaming chunk → embed → upsert loop. This is
      // where a job spends nearly all of its wall clock and allocates nearly all
      // of its memory, so a single record at loop end would rebuild the exact
      // blind spot this instrumentation exists to remove. It is therefore
      // SEGMENTED: an interim record is flushed at each batch boundary once the
      // current segment has run longer than SCRYBE_PHASE_SEGMENT_MS (default
      // 15 s), which both bounds volume and makes growth locatable inside the
      // loop. `end()` is called from the finally below on every exit path.
      const embedPhase = startSegmentedPhase(phaseCtx, "chunk_embed");
      embedPhase.setWork({ batch_size: batchSize, provider: embConfig.provider_type ?? "unknown" });

      async function flushBatch(): Promise<void> {
        if (keyBatches.length === 0) return;

        const batchStart = Date.now();
        const persistedAtBatchStart = chunksPersisted;
        const allChunks = keyBatches.flatMap((kb) => kb.chunks);

        const toEmbed = allChunks.filter((c) => !session.knownChunkIds.has(c.chunk_id));

        let embedVectors: number[][] = [];
        if (toEmbed.length > 0) {
          const texts = toEmbed.map((c) => c.content);
          embedVectors = await embedBatched(texts, embConfig, batchSize, batchDelayMs, halvingSession, dlProgressCb);
        }
        // Bracket the embed call. For an API provider the poll timer also ticks
        // through the awaits; for the local provider the ONNX session runs as
        // one blocking native call, so these two readings are all there is.
        embedPhase.sample();

        const vectorMap = new Map<string, number[]>(
          toEmbed.map((c, i) => [c.chunk_id, embedVectors[i]])
        );

        // One upsert call per flushBatch — keeps manifest version count to ~1
        // per batch, so end-of-run optimize() stays cheap.
        let allChunksToWrite: AnyChunk[] = [];
        let allVectorsToWrite: number[][] = [];
        for (const { chunks } of keyBatches) {
          for (const c of chunks) {
            if (vectorMap.has(c.chunk_id)) {
              allChunksToWrite.push(c);
              allVectorsToWrite.push(vectorMap.get(c.chunk_id)!);
            }
          }
        }

        // Defence-in-depth: collapse intra-batch chunk_id duplicates.
        // Pre-v0.31.0 scheme-1 hash collisions could produce N chunks with the same
        // chunk_id from one keyBatch flush; mergeInsert's source-side dedup gap then
        // inserted all N. Scheme-2 makes collisions extremely unlikely (chunk_id is
        // content+path-deterministic), but a future plugin emitting near-identical
        // chunks could reintroduce the snowball. This Set-based filter closes the gate.
        {
          const deduped = dedupeChunkBatch(allChunksToWrite, allVectorsToWrite);
          allChunksToWrite = deduped.chunks;
          allVectorsToWrite = deduped.vectors;
          if (deduped.dupesRemoved > 0) {
            diagEmit({
              event: "indexer.flush.intra_batch_dedup",
              projectId,
              sourceId,
              branch,
              intra_batch_dupes: deduped.dupesRemoved,
            });
          }
        }

        if (allChunksToWrite.length > 0) {
          const rowsBefore = await countTableRows(tableName).catch(() => 0);
          if (isCode) {
            await upsert(allChunksToWrite as CodeChunk[], allVectorsToWrite, tableName, embConfig.dimensions);
          } else {
            await upsertKnowledge(allChunksToWrite as KnowledgeChunk[], allVectorsToWrite, tableName, embConfig.dimensions);
          }
          const rowsAfter = await countTableRows(tableName).catch(() => 0);
          const actuallyAdded = Math.max(0, rowsAfter - rowsBefore);
          chunksPersisted += actuallyAdded;
          // Plan 95 Phase 4: report this batch's write to the rebuild-cadence
          // tracker (src/daemon/vector-index-backfill.ts owns the threshold
          // decision + idle-gated scheduling; this call is non-blocking and
          // never triggers a build inline on this hot upsert path).
          recordUpsertForRebuildCadence(tableName, actuallyAdded, rowsAfter);
          diagEmit({
            event: "indexer.write.completed",
            projectId,
            sourceId,
            branch,
            chunks_in_batch: allChunksToWrite.length,
            chunks_actually_added: actuallyAdded,
            cumulative_chunks_persisted: chunksPersisted,
          });
          filesReindexed += keyBatches.filter((kb) => kb.chunks.some((c) => vectorMap.has(c.chunk_id))).length;
          // Bracket the upsert. countTableRows + mergeInsert are blocking
          // native LanceDB calls; nothing in JS can see inside them.
          embedPhase.sample();
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
              filePath: (c as CodeChunk).item_path,
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
        const batchMs = Date.now() - batchStart;
        onProgress?.({
          phase: "embed_batch",
          projectId,
          sourceId,
          chunksIndexed,
          bytesEmbedded,
          filesEmbedded: filesSeenSoFar.size,
          batchBytes,
          batchDurationMs: batchMs,
        });

        cumulativeEmbedded += allChunks.length;
        diagEmit({
          event: "indexer.embed.batch",
          projectId,
          sourceId,
          branch,
          batch_size: allChunks.length,
          batch_ms: batchMs,
          cumulative_chunks_embedded: cumulativeEmbedded,
        });

        embedPhase.addWork({
          batches: 1,
          chunks_prepared: allChunks.length,
          chunks_embedded: toEmbed.length,
          chunks_persisted: chunksPersisted - persistedAtBatchStart,
          bytes_embedded: batchBytes,
          files_checkpointed: keyBatches.length,
        });
        embedPhase.setWork({
          cumulative_chunks_prepared: chunksIndexed,
          cumulative_chunks_persisted: chunksPersisted,
          cumulative_bytes_embedded: bytesEmbedded,
          cumulative_files_seen: filesSeenSoFar.size,
        });
        // Batch boundary — the only place a segment may be cut, since a segment
        // record must describe completed work only.
        embedPhase.maybeRoll();

        keyBatches.length = 0;
        totalPending = 0;
      }

      let currentKey: string | null = null;

      // Inside the try so that a throw from getCharCap / iterator construction
      // still ends the phase (and clears its poll timer) rather than leaking it.
      try {
        const maxChars = isCode ? getCharCap(embConfig) : undefined;
        const chunkIter = isNonHeadBranch
          ? fetchChunksFromRef(projectId, sourceId, toReindex, nonHeadContentCache, maxChars)
          : isCode
            ? fetchChunksFromWorkingTree(projectId, sourceId, rootPath, toReindex, maxChars)
            : plugin.fetchChunks(project, source, toReindex);

        let chunksSeen = 0;
        for await (const chunk of chunkIter) {
          checkAbort(signal);
          const key = isCode
            ? (chunk as CodeChunk).item_path
            : (chunk as KnowledgeChunk).item_path;

          if (key !== currentKey) {
            keyBatches.push({ key, chunks: [] });
            currentKey = key;
          }
          keyBatches[keyBatches.length - 1].chunks.push(chunk);
          totalPending++;

          // Chunk production is where a tree-sitter parse of a large file
          // allocates, and an `async function*` only yields to microtasks — the
          // poll timer (a macrotask) never fires while this loop is producing.
          // Sample every 64th chunk: often enough to catch a parse spike,
          // sparse enough that the ~8µs read stays off the hot path.
          if ((++chunksSeen & 0x3f) === 0) embedPhase.sample();

          if (totalPending >= batchSize) {
            await flushBatch();
            currentKey = null;
          }
        }
        await flushBatch();
        onProgress?.({ phase: "embed_done", projectId, sourceId, chunksIndexed, bytesEmbedded });

        // Sweep "attempted but produced 0 chunks" files — give them a hash so the scanner
        // stops re-marking them next cycle. Uses the existing "embedded" outcome with empty
        // tags (knowledge sources already use this path at line 423 / similar).
        if (isCode) {
          const noChunkFiles = [...toReindex].filter((p) => !filesSeenSoFar.has(p));
          embedPhase.setWork({ zero_chunk_files: noChunkFiles.length });
          for (const p of noChunkFiles) {
            if (merged[p] === undefined) continue; // defensive
            try {
              session.applyFile(p, { kind: "embedded", hash: merged[p], tags: [] });
            } catch (err) {
              // non-fatal — log warn, continue
              debugEmit({
                event: "indexer.zero-chunk-hash-save-failed",
                projectId,
                sourceId,
                branch,
                path: p,
                error: String(err),
              });
            }
          }
        }
      } catch (err) {
        embedPhase.end(
          (err instanceof Error ? err.message : String(err)) === "INDEX_CANCELLED" ? "cancelled" : "error",
        );
        throw err;
      }
      // end() is idempotent, so the catch above and this call cannot double-emit.
      embedPhase.end("ok");

      if (halvingSession) {
        const existingMaxFailed = stateEntry?.maxFailed ?? 0;
        writeEntry(stateKey, {
          lastSuccessful: halvingSession.effectiveBatchSize,
          maxFailed: halvingSession.halved ? halvingSession.maxFailed! : existingMaxFailed,
        });
      }

      const now = new Date().toISOString();
      // Stamp embedding_schema_version=2 on every successful reindex so the
      // cold-start migration scan can skip up-to-date sources (Plan 77 Slice 6).
      updateSource(projectId, sourceId, { last_indexed: now, embedding_schema_version: 2 });
      if (!isNonHeadBranch) {
        saveCursor(projectId, sourceId, now);
      }

      const didWork = toReindex.size + toRemove.size > 0;

      // The three tail phases below are each a single blocking native LanceDB
      // call. Nothing in JavaScript runs while they execute, so the poll timer
      // never ticks and their peakRssBytes is max(entry, exit) — a two-point
      // reading, not a high-water mark. They are still worth separating: a
      // 500 MB step across `compact` is attributable even without an interior.
      if (didWork && config.hybridEnabled) {
        await withPhase(phaseCtx, "fts_index", async (phase) => {
          try {
            if (isCode) {
              await createFtsIndex(tableName);
            } else {
              await createKnowledgeFtsIndex(tableName);
            }
            phase.setWork({ built: true });
          } catch (err) {
            phase.setWork({ built: false });
            console.warn("[scrybe] FTS index creation failed (hybrid search will fall back to vector-only):", err);
          }
        });
      }

      if (didWork) {
        await withPhase(phaseCtx, "compact", async (phase) => {
          try { await compactTableWithGrace(tableName); phase.setWork({ compacted: true }); }
          catch { phase.setWork({ compacted: false }); /* non-fatal */ }
        });
        await withPhase(phaseCtx, "prune_orphans", async (phase) => {
          try {
            const pruneResult = await pruneIndexOrphans(tableName);
            phase.setWork({ orphans_removed: pruneResult.removed });
            if (pruneResult.removed > 0) {
              debugEmit({ event: "indexer.pruneOrphans", projectId, sourceId, ...pruneResult });
            }
          } catch { phase.setWork({ orphans_removed: -1 }); /* non-fatal */ }
        });
      }

      // Plan 95 Phase 4: a full reindex can rewrite/add a large fraction of a
      // table's rows in one go, so always request an idle-gated rebuild after
      // one completes rather than waiting for the incremental accumulator
      // (recordUpsertForRebuildCadence) to cross its threshold.
      if (didWork && mode === "full") {
        markFullReindexForRebuild(tableName);
      }

      // Invalidate health cache after any successful reindex — state may have changed.
      invalidateHealthCache(tableName);

      const result = {
        status: "ok" as const,
        project_id: projectId,
        source_id: sourceId,
        chunks_prepared: chunksIndexed,
        chunks_persisted: chunksPersisted,
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
        chunks_persisted: chunksPersisted,
        total_ms: Date.now() - jobStart,
      });

      // Record the last-indexed SHA in branch_state for code sources on success.
      // Non-fatal: a write failure logs a warning but does not propagate.
      if (isCode && indexedShaAtStart !== null) {
        try {
          setLastIndexedSha(projectId, sourceId, branch, indexedShaAtStart, Date.now());
        } catch (shaWriteErr) {
          diagEmit({
            event: "indexer.branch_state.write_failed",
            projectId,
            sourceId,
            branch,
            error: String(shaWriteErr),
          });
        }
      }

      return result;
    }
  );
}

// ─── Exported dedup helper (also used in flushBatch above) ───────────────────

/**
 * Collapse intra-batch chunk_id duplicates from two parallel arrays.
 *
 * Walks `chunks` and `vectors` in lock-step. First-seen chunk_id wins;
 * subsequent rows sharing the same id are dropped. Returns the deduped
 * arrays and the count of rows removed.
 *
 * Extracted for testability — flushBatch calls this before every upsert.
 */
export function dedupeChunkBatch<C extends { chunk_id: string }>(
  chunks: C[],
  vectors: number[][],
): { chunks: C[]; vectors: number[][]; dupesRemoved: number } {
  const seen = new Set<string>();
  const dedupedChunks: C[] = [];
  const dedupedVectors: number[][] = [];
  let dupesRemoved = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (seen.has(c.chunk_id)) {
      dupesRemoved++;
      continue;
    }
    seen.add(c.chunk_id);
    dedupedChunks.push(c);
    dedupedVectors.push(vectors[i]!);
  }
  return { chunks: dedupedChunks, vectors: dedupedVectors, dupesRemoved };
}

async function* fetchChunksFromRef(
  projectId: string,
  sourceId: string,
  toReindex: Set<string>,
  contentCache: Map<string, string>,
  maxChars?: number
): AsyncGenerator<AnyChunk> {
  for (const relPath of toReindex) {
    const content = contentCache.get(relPath);
    if (content == null) continue;
    const lang = getLanguage(basename(relPath)) ?? "";
    yield* chunkFileContent(projectId, sourceId, relPath, content, lang, maxChars) as AnyChunk[];
  }
}

async function* fetchChunksFromWorkingTree(
  projectId: string,
  sourceId: string,
  rootPath: string,
  toReindex: Set<string>,
  maxChars?: number
): AsyncGenerator<AnyChunk> {
  for (const { relPath, absPath } of walkRepoFiles(rootPath, projectId, sourceId)) {
    if (!toReindex.has(relPath)) continue;
    let content: string;
    try {
      content = normalizeContent(readFileSync(absPath, "utf8"));
    } catch {
      continue;
    }
    const lang = getLanguage(basename(relPath)) ?? "";
    yield* chunkFileContent(projectId, sourceId, relPath, content, lang, maxChars) as AnyChunk[];
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
