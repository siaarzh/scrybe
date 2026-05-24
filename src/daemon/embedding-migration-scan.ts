/**
 * Cold-start embedding migration scan (Plan 77 Slice 6).
 *
 * On daemon cold start, scans all registered sources and auto-enqueues a full
 * reindex for sources whose embedding vectors are outdated (schema version < 2)
 * and whose assigned preset uses the local provider. Voyage/OpenAI sources are
 * skipped — their vectors did not change.
 *
 * Size gate: sources with ≥ LARGE_SOURCE_CHUNK_THRESHOLD chunks are NOT
 * auto-enqueued; instead they are placed in awaiting_user_confirm state
 * (recomputed from (version < 2 AND local AND chunks >= threshold) on each scan)
 * so the user can opt in via mcp__scrybe__reindex_source.
 *
 * Idempotency: sources already at version 2, or already having a full reindex
 * job queued/running, are skipped.
 *
 * This function is a pure, explicit entry point — no side effects at import
 * time. Safe to import in tests with mocked dependencies.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { config, readScrybeConfig } from "../config.js";
import { listProjects } from "../registry.js";
import { countTableRows } from "../vector-store.js";
import { getQueueStatus } from "../jobs-store.js";
import { submitToQueue } from "./queue.js";

// ─── Constants ────────────────────────────────────────────────────────────

/** Current embedding schema version. Sources below this need reindex. */
export const EMBEDDING_SCHEMA_VERSION = 2;

/** Sources with ≥ this many chunks are placed in awaiting_user_confirm. */
export const LARGE_SOURCE_CHUNK_THRESHOLD = 50_000;

// ─── Public shape ─────────────────────────────────────────────────────────

export interface AwaitingMigrationEntry {
  project_id: string;
  source_id: string;
  chunk_count: number;
  reason: string;
}

// ─── Decision type ────────────────────────────────────────────────────────

type ScanDecision =
  | "auto_enqueued"
  | "awaiting_user_confirm"
  | "skipped_non_local"
  | "skipped_already_migrated"
  | "skipped_duplicate_job";

// ─── Helpers ──────────────────────────────────────────────────────────────

function logFilePath(): string {
  return process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
}

function appendLog(entry: Record<string, unknown>): void {
  try {
    appendFileSync(logFilePath(), JSON.stringify(entry) + "\n", "utf8");
  } catch { /* non-fatal — log I/O must not crash the daemon */ }
}

/**
 * Determine whether the assigned embedding preset for a source uses a local provider.
 * Returns true only when config.json exists and the relevant slot's preset has
 * provider === "local". Returns false when config.json is absent (legacy env path)
 * because we can't safely determine the provider without resolving env vars.
 */
function isLocalPreset(sourceType: string): boolean {
  const cfg = readScrybeConfig();
  if (!cfg) return false; // no config.json — can't determine safely

  const slot = sourceType === "ticket" || sourceType === "webpage" || sourceType === "message"
    ? "text_preset"
    : "code_preset";

  const presetName = cfg.assignments[slot];
  if (!presetName) return false;

  const preset = cfg.embedding_presets[presetName];
  return preset?.provider === "local";
}

/**
 * Check whether there is already an active (queued or running) full reindex
 * job for the given project/source pair.
 */
function hasActiveMigrationJob(projectId: string, sourceId: string): boolean {
  try {
    const status = getQueueStatus(projectId);
    const allActive = [...status.running, ...status.queued];
    return allActive.some((job: any) =>
      job.project_id === projectId &&
      (job.source_id === sourceId || job.source_id == null) &&
      job.mode === "full"
    );
  } catch {
    return false; // SQLite unavailable — assume no duplicates
  }
}

// ─── In-memory state ──────────────────────────────────────────────────────

/** Last scan result — populated once per cold start, never written again. */
let _lastScanResult: AwaitingMigrationEntry[] = [];

/**
 * Return the current list of sources awaiting user-confirmed migration,
 * optionally filtered to a specific project.
 */
export function getAwaitingMigration(projectId?: string): AwaitingMigrationEntry[] {
  if (!projectId) return _lastScanResult;
  return _lastScanResult.filter((e) => e.project_id === projectId);
}

// ─── Main scan function ───────────────────────────────────────────────────

/**
 * Run the embedding migration scan once per cold start.
 * Returns the list of large sources that are awaiting_user_confirm.
 *
 * opts.countChunks — injectable for tests; defaults to countTableRows.
 * opts.enqueueJob  — injectable for tests; defaults to submitToQueue.
 */
export async function runEmbeddingMigrationScan(opts?: {
  countChunks?: (tableName: string) => Promise<number>;
  enqueueJob?: (projectId: string, sourceId: string) => void;
}): Promise<AwaitingMigrationEntry[]> {
  const countChunks = opts?.countChunks ?? countTableRows;
  const enqueueJob = opts?.enqueueJob ?? ((projectId: string, sourceId: string) => {
    submitToQueue({ projectId, sourceId, mode: "full" });
  });

  const awaiting: AwaitingMigrationEntry[] = [];
  const projects = listProjects();

  for (const project of projects) {
    for (const source of project.sources) {
      const version = source.embedding_schema_version ?? 1;
      const sourceType = (source.source_config as { type: string }).type ?? "code";

      let decision: ScanDecision;
      let chunks = 0;

      if (version >= EMBEDDING_SCHEMA_VERSION) {
        decision = "skipped_already_migrated";
      } else if (!isLocalPreset(sourceType)) {
        decision = "skipped_non_local";
      } else if (hasActiveMigrationJob(project.id, source.source_id)) {
        decision = "skipped_duplicate_job";
      } else {
        // Local preset, version < 2, no active job — count chunks to decide
        try {
          chunks = source.table_name ? await countChunks(source.table_name) : 0;
        } catch {
          chunks = 0;
        }

        if (chunks >= LARGE_SOURCE_CHUNK_THRESHOLD) {
          decision = "awaiting_user_confirm";
          awaiting.push({
            project_id: project.id,
            source_id: source.source_id,
            chunk_count: chunks,
            reason: `local preset vectors outdated (schema v${version} < v${EMBEDDING_SCHEMA_VERSION}); ` +
              `${chunks} chunks exceeds auto-reindex threshold (${LARGE_SOURCE_CHUNK_THRESHOLD}) — ` +
              `call mcp__scrybe__reindex_source to opt in`,
          });
        } else {
          decision = "auto_enqueued";
          try {
            enqueueJob(project.id, source.source_id);
          } catch (err) {
            // non-fatal — log but don't crash the daemon
            process.stderr.write(
              `[scrybe] embedding migration scan: failed to enqueue reindex for ` +
              `${project.id}/${source.source_id}: ${err}\n`
            );
          }
        }
      }

      // Emit structured log entry per Plan 77 spec
      const logEntry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        evt: "embedding_migration_scan",
        project: project.id,
        source: source.source_id,
        decision,
        from_version: version,
        to_version: EMBEDDING_SCHEMA_VERSION,
      };
      if (decision === "auto_enqueued" || decision === "awaiting_user_confirm") {
        logEntry["chunks"] = chunks;
      }

      appendLog(logEntry);

      // Skip non-decisions from stderr — only log actionable ones
      if (decision === "auto_enqueued") {
        process.stderr.write(
          `[scrybe] embedding migration: auto-enqueuing full reindex for ` +
          `${project.id}/${source.source_id} (${chunks} chunks, schema v${version} → v${EMBEDDING_SCHEMA_VERSION})\n`
        );
      } else if (decision === "awaiting_user_confirm") {
        process.stderr.write(
          `[scrybe] embedding migration: ${project.id}/${source.source_id} has ${chunks} chunks — ` +
          `too large for auto-reindex. Call mcp__scrybe__reindex_source to opt in.\n`
        );
      }
    }
  }

  // Persist result in module state so queue_status can surface it without re-scanning.
  _lastScanResult = awaiting;

  return awaiting;
}
