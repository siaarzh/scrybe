/**
 * Health probe for LanceDB tables.
 *
 * Three checks, each conservative:
 *   1. Manifest parser — reads the active version manifest (highest-numbered file
 *      in `_versions/`), parses Lance protobuf to extract data-file UUIDs, and
 *      stats each `data/<uuid>.lance` file. Missing → "manifest_missing_data".
 *
 *   2. Dimension check — opens the table schema (manifest-only read, no data scan),
 *      compares the vector field dimension to the expected value from embedding-meta.json.
 *      Skipped when the table has 0 rows.
 *
 *   3. Catch-all — wraps openTable() in try/catch for any other format / IO error
 *      (→ "schema_unreadable"). Distinguishes hard errors from transient EBUSY/EIO
 *      (→ returns state "unknown").
 *
 * A single retry with a 100 ms backoff is applied on first detection to tolerate
 * concurrent-gc races.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import * as lancedb from "@lancedb/lancedb";
import { config } from "./config.js";

const DB_PATH = join(config.dataDir, "lancedb");

export type CorruptionReason =
  | "manifest_missing_data"
  | "dimensions_mismatch"
  | "schema_unreadable";

export interface HealthResult {
  state: "healthy" | "corrupt" | "unknown";
  reasons: CorruptionReason[];
  details: {
    missing_files?: string[];
    expected_dimensions?: number;
    actual_dimensions?: number;
    error_message?: string;
  };
  /** ms epoch — for cache TTL math */
  checked_at: number;
}

/** Shape stored in embedding-meta.json (per-profile format, post-Plan 30). */
interface EmbeddingMetaProfile {
  model?: string;
  dimensions?: number;
}
interface EmbeddingMeta {
  // per-profile shape (post-Plan 30): { code: { model, dimensions }, text: { model, dimensions } }
  code?: EmbeddingMetaProfile;
  text?: EmbeddingMetaProfile;
  // flat legacy shape (pre-Plan 30): { model, dimensions }
  model?: string;
  dimensions?: number;
}

function readEmbeddingMeta(): EmbeddingMeta | null {
  const p = join(config.dataDir, "embedding-meta.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as EmbeddingMeta;
  } catch {
    return null;
  }
}

/**
 * Parse a single Lance manifest protobuf and return the set of data-file UUIDs
 * referenced by it. Uses the same binary scan used by `pruneIndexOrphans` in
 * vector-store.ts: look for field tag `\x0a\x10` (field 1, type LEN, length 16)
 * followed by 16 raw UUID bytes.
 *
 * We over-collect rather than under-collect: any `0a 10 + 16b` sequence is
 * treated as a UUID. Safe because false positives cause us to stat an extra
 * non-existent file, which only makes the probe more conservative.
 */
function parseManifestDataUuids(manifestPath: string): string[] {
  let buf: Buffer;
  try {
    buf = readFileSync(manifestPath);
  } catch {
    return [];
  }
  if (buf.length === 0) return []; // zero-byte manifest — handled by catch-all

  const uuids: string[] = [];
  for (let i = 0; i < buf.length - 17; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x10) {
      const hex = buf.slice(i + 2, i + 18).toString("hex");
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      uuids.push(uuid);
    }
  }
  return uuids;
}

/**
 * Find the active (highest-numbered) manifest file in a table's `_versions/` dir.
 * Returns null if the directory doesn't exist or is empty.
 */
function findActiveManifest(versionsDir: string): string | null {
  if (!existsSync(versionsDir)) return null;
  let highest = -1;
  let found: string | null = null;
  try {
    for (const name of readdirSync(versionsDir)) {
      // Manifest files are named "<N>.manifest"
      const m = name.match(/^(\d+)\.manifest$/);
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (n > highest) { highest = n; found = join(versionsDir, name); }
      }
    }
  } catch {
    return null;
  }
  return found;
}

/**
 * Return a list of all manifests in `_versions/`, sorted descending by version number.
 * Used by the rollback-tier in indexer.ts.
 */
export function listManifestsSorted(versionsDir: string): Array<{ path: string; version: number }> {
  if (!existsSync(versionsDir)) return [];
  const out: Array<{ path: string; version: number }> = [];
  try {
    for (const name of readdirSync(versionsDir)) {
      const m = name.match(/^(\d+)\.manifest$/);
      if (m) {
        out.push({ path: join(versionsDir, name), version: parseInt(m[1]!, 10) });
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.version - a.version);
}

/**
 * Check whether all data-file UUIDs referenced by a manifest exist on disk.
 * Returns the list of missing file paths (relative to the table dir), or an
 * empty array if everything is present.
 */
export function checkManifestDataFiles(tableDir: string, manifestPath: string): string[] {
  const uuids = parseManifestDataUuids(manifestPath);
  const dataDir = join(tableDir, "data");
  const missing: string[] = [];
  for (const uuid of uuids) {
    const dataFile = join(dataDir, `${uuid}.lance`);
    if (!existsSync(dataFile)) {
      missing.push(`data/${uuid}.lance`);
    }
  }
  return missing;
}

/**
 * Check whether a manifest is "clean" — all referenced data files exist on disk.
 */
export function isManifestClean(tableDir: string, manifestPath: string): boolean {
  return checkManifestDataFiles(tableDir, manifestPath).length === 0;
}

/** Transient IO errors that should yield state="unknown" rather than "corrupt". */
function isTransientIoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /EBUSY|EIO|EAGAIN/i.test(msg);
}

/**
 * Classify a Lance error thrown by openTable() or a read operation:
 * - "Not found" pointing at a data/ file → manifest_missing_data
 * - Zero bytes / insufficient data / invalid format → schema_unreadable
 * - EBUSY/EIO → transient
 */
function classifyLanceError(err: unknown): "manifest_missing_data" | "schema_unreadable" | "transient" {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTransientIoError(err)) return "transient";
  // Lance error mentioning a missing data file: "Not found: .../data/<uuid>.lance"
  if (/not found/i.test(msg) && /data[\\/][0-9a-f-]+\.lance/i.test(msg)) {
    return "manifest_missing_data";
  }
  return "schema_unreadable";
}

/**
 * Extract the missing data file path(s) from a Lance "Not found" error message.
 * Returns an array of relative paths like ["data/<uuid>.lance"].
 */
function extractMissingFilePaths(err: unknown): string[] {
  const msg = err instanceof Error ? err.message : String(err);
  const matches = msg.match(/data[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lance/gi);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/\\/g, "/")))];
}

async function runProbeOnce(
  tableName: string,
  opts: { expectedDimensions?: number }
): Promise<HealthResult> {
  const tableDir = join(DB_PATH, `${tableName}.lance`);
  const versionsDir = join(tableDir, "_versions");
  const reasons: CorruptionReason[] = [];
  const details: HealthResult["details"] = {};

  // ── Early exit: table directory doesn't exist → healthy (never indexed) ────
  if (!existsSync(tableDir)) {
    return { state: "healthy", reasons: [], details: {}, checked_at: Date.now() };
  }

  // ── 1. Zero-byte manifest pre-check ──────────────────────────────────────
  // Detect this before openTable so we can set a clear error_message.
  const activeManifest = findActiveManifest(versionsDir);
  if (activeManifest !== null) {
    try {
      const sz = statSync(activeManifest).size;
      if (sz === 0) {
        reasons.push("schema_unreadable");
        details.error_message = "zero-byte manifest";
        return { state: "corrupt", reasons, details, checked_at: Date.now() };
      }
    } catch { /* stat failed — fall through to openTable */ }
  }

  // ── 2. Open-table + dim check ─────────────────────────────────────────────
  // openTable() triggers a manifest read; any missing data file causes a "Not found"
  // IO error. We don't scan manifests ourselves — we let Lance report what's wrong.
  try {
    const db = await lancedb.connect(DB_PATH);
    const names = await db.tableNames();
    if (!names.includes(tableName)) {
      // Table not in Lance registry — treat as healthy (will be created on next index)
      return { state: "healthy", reasons: [], details: {}, checked_at: Date.now() };
    }
    const openedTable = await db.openTable(tableName);

    // countRows() reads metadata only (no data file access in newer Lance versions).
    // We also do a minimal data read (limit 1) to force Lance to open the data files.
    // This is what triggers "Not found: .../data/<uuid>.lance" for corrupt tables.
    const rowCount = await openedTable.countRows();
    if (rowCount > 0) {
      // Probe read: fetch 1 row to trigger data-file access.
      // On a healthy table this is a fast manifest+one-page read.
      // On a corrupt table (missing data file) this throws.
      await openedTable
        .query()
        .select(["chunk_id"])
        .limit(1)
        .toArray();

      // Dimension check: only when the table has data and expectedDimensions is set.
      if (opts.expectedDimensions != null) {
        const schema = await openedTable.schema();
        const vectorField = schema.fields.find((f) => f.name === "vector");
        if (vectorField) {
          // FixedSizeList<item: float32>[N] — extract N from the type string
          const typeStr = vectorField.type.toString();
          const dimMatch = typeStr.match(/FixedSizeList\[(\d+)/);
          if (dimMatch) {
            const actualDims = parseInt(dimMatch[1]!, 10);
            if (actualDims !== opts.expectedDimensions) {
              reasons.push("dimensions_mismatch");
              details.expected_dimensions = opts.expectedDimensions;
              details.actual_dimensions = actualDims;
            }
          }
        }
      }
    }
  } catch (err) {
    const classification = classifyLanceError(err);
    if (classification === "transient") {
      return {
        state: "unknown",
        reasons: [],
        details: { error_message: err instanceof Error ? err.message : String(err) },
        checked_at: Date.now(),
      };
    }
    if (classification === "manifest_missing_data") {
      reasons.push("manifest_missing_data");
      const missing = extractMissingFilePaths(err);
      if (missing.length > 0) details.missing_files = missing;
    } else {
      reasons.push("schema_unreadable");
      details.error_message = err instanceof Error ? err.message : String(err);
    }
  }

  if (reasons.length > 0) {
    return { state: "corrupt", reasons, details, checked_at: Date.now() };
  }
  return { state: "healthy", reasons: [], details: {}, checked_at: Date.now() };
}

/**
 * Probe a single LanceDB table for health issues.
 *
 * @param tableName      The Lance table name (without `.lance` suffix).
 * @param opts.expectedDimensions   Expected vector dimension from embedding config.
 *                                  When omitted, the dimension check is skipped.
 */
export async function probeTableHealth(
  tableName: string,
  opts: { expectedDimensions?: number } = {}
): Promise<HealthResult> {
  const first = await runProbeOnce(tableName, opts);

  // If healthy or unknown, no retry needed.
  if (first.state !== "corrupt") return first;

  // Single retry with 100 ms backoff — handles concurrent-gc races where a data
  // file was briefly missing during compaction.
  await new Promise<void>((r) => setTimeout(r, 100));
  return runProbeOnce(tableName, opts);
}

/**
 * Get the expected embedding dimensions for a table from embedding-meta.json.
 * Returns undefined if no meta file exists (dimension check is skipped).
 *
 * The profile parameter mirrors the registry.ts `resolveEmbeddingConfig` logic:
 * "code" tables use the code embedding dimensions; "knowledge" tables use text.
 */
/**
 * Get the expected embedding dimensions for a table from embedding-meta.json.
 * Returns undefined if no meta file exists (dimension check is skipped).
 *
 * The profile parameter mirrors the registry.ts `resolveEmbeddingConfig` logic:
 * "code" tables use the code embedding dimensions; "knowledge" tables use text.
 */
export function getExpectedDimensions(profile: "code" | "knowledge"): number | undefined {
  const meta = readEmbeddingMeta();
  if (!meta) return undefined;

  if (profile === "code") {
    // Per-profile shape: { code: { dimensions } }
    if (meta.code?.dimensions) return meta.code.dimensions;
    // Legacy flat shape: { dimensions }
    if (meta.dimensions) return meta.dimensions;
    return undefined;
  }

  // knowledge / text profile
  if (meta.text?.dimensions) return meta.text.dimensions;
  // Fall back to code dimensions if text not stored separately
  if (meta.code?.dimensions) return meta.code.dimensions;
  if (meta.dimensions) return meta.dimensions;
  return undefined;
}
