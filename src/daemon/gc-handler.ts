/**
 * GC job handler — runs chunk-orphan deletion + compaction for a project.
 * Called by the daemon queue for both auto-gc (mode="grace") and manual gc (mode="purge").
 *
 * Returns: { orphans_deleted, bytes_freed, duration_ms }
 */
import { getProject } from "../registry.js";
import { listChunkIds, deleteChunks, compactTable, compactTableWithGrace } from "../vector-store.js";
import { getAllChunkIdsForSource } from "../branch-state.js";

export interface GcJobInput {
  projectId: string;
  /** If provided, only gc this specific source; otherwise gc all code sources in project. */
  sourceId?: string;
  /** "grace" = compactTableWithGrace (auto-gc). "purge" = compactTable (manual gc). */
  mode: "grace" | "purge";
}

export interface GcJobOutput {
  orphans_deleted: number;
  bytes_freed: number;
  duration_ms: number;
}

export async function runGcJobHandler(req: GcJobInput): Promise<GcJobOutput> {
  const project = getProject(req.projectId);
  if (!project) throw new Error(`Project '${req.projectId}' not found`);

  const startTime = Date.now();
  let orphansDeleted = 0;
  let bytesFreed = 0;

  const sources = req.sourceId
    ? project.sources.filter((s) => s.source_id === req.sourceId)
    : project.sources;

  for (const source of sources) {
    if (!source.table_name || source.source_config.type !== "code") continue;

    // 1. Compute orphans
    const lanceIds = await listChunkIds(req.projectId, source.table_name);
    const taggedIds = getAllChunkIdsForSource(req.projectId, source.source_id);
    const orphans = lanceIds.filter((id) => !taggedIds.has(id));

    // 2. Delete orphan chunks
    if (orphans.length > 0) {
      await deleteChunks(orphans, source.table_name);
      orphansDeleted += orphans.length;
    }

    // 3. Compact
    const result = req.mode === "purge"
      ? await compactTable(source.table_name)
      : await compactTableWithGrace(source.table_name);
    bytesFreed += result.bytesFreed;
  }

  return {
    orphans_deleted: orphansDeleted,
    bytes_freed: bytesFreed,
    duration_ms: Date.now() - startTime,
  };
}
