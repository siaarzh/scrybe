/**
 * In-place chunk-ID rehash migration (scheme 1 → 2).
 *
 * Old hash: sha256(project_id NUL source_id NUL language NUL content)
 * New hash: sha256(project_id NUL source_id NUL item_path NUL item_url NUL item_type NUL content)
 *
 * The migration:
 *   1. Writes chunk_id_scheme "1→2-migrating" to sidecar (restart-safe marker).
 *   2. Pre-validates: re-computes old chunk IDs on raw stored content and asserts
 *      they match stored chunk_id. Aborts on mismatch (source marked corrupt).
 *   3. Rewrites chunk_id column for every row using the new hash inputs and
 *      normalizeContent() applied to stored content.
 *   4. Writes chunk_id_scheme 2 to sidecar.
 *
 * Stored content is NOT rewritten — only the ID changes.
 * See ADR-0004 for the full contract.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { normalizeContent } from "../normalize.js";
import { config } from "../config.js";
import {
  makeSchema,
  makeKnowledgeSchema,
  CURRENT_CHUNK_ID_SCHEME,
  CURRENT_CHUNK_ID_SCHEME_VERSION,
} from "../vector-store.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";

// DB_PATH is computed lazily so tests can override SCRYBE_DATA_DIR before import side-effects.
// Production callers always use the default; tests pass _dbPath in opts.
function defaultDbPath(): string {
  return join(config.dataDir, "lancedb");
}

// ─── Sidecar helpers (path-aware overrides for testing) ───────────────────────

interface TableMeta {
  chunk_id_scheme: number | string;
  chunk_id_scheme_introduced_in?: string;
}

function tableMetaPath(dbPath: string, tableName: string): string {
  return join(dbPath, `${tableName}-meta.json`);
}

function readTableMetaAt(dbPath: string, tableName: string): TableMeta | null {
  const p = tableMetaPath(dbPath, tableName);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as TableMeta;
  } catch {
    return null;
  }
}

function writeTableMetaAt(dbPath: string, tableName: string, meta: TableMeta): void {
  mkdirSync(dbPath, { recursive: true });
  writeFileSync(tableMetaPath(dbPath, tableName), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

export const DEFAULT_VALIDATION_SAMPLE = 1000;

export interface MigrationResult {
  status: "ok" | "skipped" | "failed";
  rows_rehashed: number;
  reason?: string;
}

// ─── Frozen old-scheme hash (scheme 1) ───────────────────────────────────────
// This function must never change. It reproduces the scheme-1 hash so the
// pre-rewrite validator can detect if stored chunk_ids match the expected formula.
// Knowledge rows: language = "" (was always empty for knowledge)
// Code rows: language = the language field stored in the row

/** @internal — exported only for migration tests (C5a/C5b/C5c). Never call from production paths. */
export function makeOldChunkIdV1(
  projectId: string,
  sourceId: string,
  language: string,
  content: string
): string {
  return createHash("sha256")
    .update(projectId + "\0" + sourceId + "\0" + language + "\0" + content)
    .digest("hex");
}

// ─── New-scheme hash (scheme 2) ───────────────────────────────────────────────

/** @internal — exported only for migration tests. */
export function makeNewChunkIdV2(
  projectId: string,
  sourceId: string,
  itemPath: string,
  itemUrl: string,
  itemType: string,
  content: string
): string {
  return createHash("sha256")
    .update(projectId + "\0" + sourceId + "\0" + itemPath + "\0" + itemUrl + "\0" + itemType + "\0" + content)
    .digest("hex");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a Float32Array from whatever LanceDB returns for a vector column.
 * LanceDB's toArray() returns an Apache Arrow FixedSizeList Vector, which does
 * NOT round-trip safely as a plain object into createTable. Materialise to a
 * concrete Float32Array so the new table insertion serialises correctly.
 */
function materializeVector(v: unknown): Float32Array {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return new Float32Array(v as number[]);
  // Apache Arrow Vector (FixedSizeList backed by FloatVector)
  if (v != null && typeof (v as { toArray?: () => Float32Array }).toArray === "function") {
    return (v as { toArray: () => Float32Array }).toArray();
  }
  // Fallback: try Float32Array.from iterator
  try { return Float32Array.from(v as Iterable<number>); } catch { return new Float32Array(0); }
}

function daemonLog(record: Record<string, unknown>): void {
  const logPath = process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
  try {
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
  } catch { /* non-fatal */ }
}

/** Detect whether a table uses the code or knowledge schema by checking its columns. */
async function detectProfile(table: lancedb.Table): Promise<"code" | "knowledge"> {
  const schema = await table.schema();
  const hasItemPath = schema.fields.some((f) => f.name === "item_path");
  const hasSourcePath = schema.fields.some((f) => f.name === "source_path");
  // If neither field exists this is an old-scheme code table (has file_path) or knowledge (source_path)
  if (hasSourcePath) return "knowledge";
  if (hasItemPath) {
    // Check if it has knowledge-only fields
    const hasItemType = schema.fields.some((f) => f.name === "item_type");
    const hasLanguage = schema.fields.some((f) => f.name === "language");
    if (hasItemType && !hasLanguage) return "knowledge";
  }
  return "code";
}

/** Check the old-scheme column names present in a table. */
async function hasOldSchema(table: lancedb.Table): Promise<boolean> {
  const schema = await table.schema();
  return schema.fields.some((f) => f.name === "source_path" || f.name === "file_path");
}

// ─── Pre-rewrite validator (G3) ───────────────────────────────────────────────

async function validatePreMigration(
  table: lancedb.Table,
  projectId: string,
  sourceId: string,
  profile: "code" | "knowledge",
  sampleSize: number
): Promise<{ ok: boolean; reason?: string; sampled: boolean }> {
  let rows: Array<Record<string, unknown>>;
  try {
    const q = table.query().limit(sampleSize > 0 ? sampleSize : Number.MAX_SAFE_INTEGER);
    rows = (await q.toArray()) as Array<Record<string, unknown>>;
  } catch (err) {
    return { ok: false, reason: `Failed to read rows for validation: ${err instanceof Error ? err.message : String(err)}`, sampled: false };
  }

  const totalRows = rows.length;
  const sampled = sampleSize > 0 && totalRows >= sampleSize;

  for (const row of rows) {
    const storedId = String(row["chunk_id"] ?? "");
    const content = String(row["content"] ?? "");
    // For scheme-1 code rows, language was stored and used in hash.
    // For scheme-1 knowledge rows, language was "" (never stored in knowledge tables).
    const language = profile === "code" ? String(row["language"] ?? "") : "";
    const expected = makeOldChunkIdV1(projectId, sourceId, language, content);

    if (expected !== storedId) {
      return {
        ok: false,
        reason: `chunk_id mismatch: stored=${storedId.slice(0, 12)}… expected=${expected.slice(0, 12)}… (table may have been written by a different scheme)`,
        sampled,
      };
    }
  }

  return { ok: true, sampled };
}

// ─── Main migration ───────────────────────────────────────────────────────────

export async function migrateTable(
  tableName: string,
  projectId: string,
  sourceId: string,
  opts: {
    validationSampleSize?: number;
    onProgress?: (done: number, total: number) => void;
    /** @internal — override the LanceDB directory path (used in tests only). */
    _dbPath?: string;
  } = {}
): Promise<MigrationResult> {
  const sampleSize = opts.validationSampleSize ?? DEFAULT_VALIDATION_SAMPLE;
  const dbPath = opts._dbPath ?? defaultDbPath();

  // Skip if already on scheme 2
  const meta = readTableMetaAt(dbPath, tableName);
  if (meta && meta.chunk_id_scheme === CURRENT_CHUNK_ID_SCHEME) {
    return { status: "skipped", rows_rehashed: 0, reason: "already on current scheme" };
  }

  // Connect to Lance
  let db: lancedb.Connection;
  try {
    db = await lancedb.connect(dbPath);
  } catch (err) {
    return { status: "failed", rows_rehashed: 0, reason: `Cannot connect to LanceDB: ${err instanceof Error ? err.message : String(err)}` };
  }

  const names = await db.tableNames();
  const tableExists = names.includes(tableName);

  // Bug 2 restart-safety: if the sidecar says "1→2-migrating" but the table is gone,
  // the process crashed between drop and recreate — data is lost, user must reindex.
  if (meta?.chunk_id_scheme === "1→2-migrating" && !tableExists) {
    daemonLog({ event: "migration.recreate_crashed", tableName, projectId, sourceId,
      reason: "Table missing after crash between drop and recreate — data lost, reindex required." });
    return {
      status: "failed",
      rows_rehashed: 0,
      reason: "Migration crashed mid-recreate; table data lost. Run reindex --full to recover.",
    };
  }

  if (!tableExists) {
    return { status: "skipped", rows_rehashed: 0, reason: "table does not exist" };
  }

  let table: lancedb.Table;
  try {
    table = await db.openTable(tableName);
  } catch (err) {
    return { status: "failed", rows_rehashed: 0, reason: `Cannot open table: ${err instanceof Error ? err.message : String(err)}` };
  }

  const profile = await detectProfile(table);
  const oldSchema = await hasOldSchema(table);

  if (!oldSchema) {
    // Table has new schema — it was already migrated or created under new code.
    // Stamp scheme 2 if not already stamped.
    if (!meta || meta.chunk_id_scheme !== CURRENT_CHUNK_ID_SCHEME) {
      writeTableMetaAt(dbPath, tableName, {
        chunk_id_scheme: CURRENT_CHUNK_ID_SCHEME,
        chunk_id_scheme_introduced_in: CURRENT_CHUNK_ID_SCHEME_VERSION,
      });
    }
    return { status: "skipped", rows_rehashed: 0, reason: "table already has new schema" };
  }

  // Validation-failed marker from a prior run: do not retry blindly. The validator's
  // job is to refuse to migrate a table whose stored chunk_ids don't match the scheme-1
  // hash (means the table is corrupt or written by some unknown scheme). Without this
  // guard, a second `scrybe migrate` would enter the restart path, skip validation, and
  // destroy data the validator was protecting.
  if (meta?.chunk_id_scheme === "validation_failed") {
    daemonLog({ event: "migration.validation_failed_replay", tableName, projectId, sourceId });
    return {
      status: "failed",
      rows_rehashed: 0,
      reason: "Pre-migration validation previously failed for this table. Run `scrybe doctor --repair` or `scrybe reindex --full` to recover.",
    };
  }

  // Bug 1 restart-safety: if the in-progress marker is already set, this is a restart
  // after a mid-rehash crash. The table has mixed old-ID and new-ID rows. Skip validation
  // (it would fail on already-rehashed rows) and go straight to the rehash loop,
  // which is idempotent (rows whose chunk_id already matches the new hash are left untouched).
  const isRestart = meta?.chunk_id_scheme === "1→2-migrating";

  if (isRestart) {
    daemonLog({ event: "migration.restart_detected", tableName, projectId, sourceId });
  } else {
    daemonLog({ event: "migration.start", tableName, projectId, sourceId, profile });

    // Step 1: Write in-progress marker before any mutation (restart-safe)
    writeTableMetaAt(dbPath, tableName, { chunk_id_scheme: "1→2-migrating" });

    // Step 2: Pre-validate (on raw stored content — old hashes taken on raw bytes).
    // Only run on a fresh migration; on restart the table has mixed IDs so validation
    // would produce false mismatches.
    const validation = await validatePreMigration(table, projectId, sourceId, profile, sampleSize);
    if (!validation.ok) {
      // Persist a distinct "validation_failed" marker so subsequent migrate runs don't
      // enter the restart path (which skips validation and would destroy the table).
      writeTableMetaAt(dbPath, tableName, { chunk_id_scheme: "validation_failed" });
      daemonLog({ event: "migration.validation_failed", tableName, projectId, sourceId, reason: validation.reason });
      return {
        status: "failed",
        rows_rehashed: 0,
        reason: `Pre-migration validation failed: ${validation.reason}. Run \`scrybe doctor --repair\` or \`scrybe reindex --full\` to recover.`,
      };
    }

    if (validation.sampled) {
      daemonLog({ event: "migration.validation_sampled", tableName, projectId, sourceId, sample_size: sampleSize });
    }
  }

  // Step 3: Read all rows into memory (including vectors).
  // Memory note: this buffers the entire table. For typical codebases (< 500k rows, ~1–2 KB/row)
  // this is 0.5–1 GB RAM in the worst case. Streaming-rebuild is not implemented — add it later
  // if memory pressure becomes a real concern in production.
  let allRows: Array<Record<string, unknown>>;
  try {
    allRows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray() as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    daemonLog({ event: "migration.failed", tableName, projectId, sourceId, reason: String(err), rows_done: 0 });
    return {
      status: "failed",
      rows_rehashed: 0,
      reason: `Failed to read rows: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const total = allRows.length;

  // Build new-schema rows: rename old column names to new ones and recompute chunk_id.
  // Old knowledge columns: source_path → item_path, source_url → item_url, source_type → item_type.
  // Old code columns: file_path → item_path; item_url = "", item_type = "code".
  const newRows: Array<Record<string, unknown>> = [];
  let rowsRehashed = 0;

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const content = String(row["content"] ?? "");
    const normalizedContent = normalizeContent(content);

    let itemPath: string;
    let itemUrl: string;
    let itemType: string;

    if (profile === "knowledge") {
      // On restart, some rows may already use new column names — prefer item_path if present.
      itemPath = String(row["item_path"] ?? row["source_path"] ?? "");
      itemUrl = String(row["item_url"] ?? row["source_url"] ?? "");
      itemType = String(row["item_type"] ?? row["source_type"] ?? "ticket");
    } else {
      itemPath = String(row["item_path"] ?? row["file_path"] ?? "");
      itemUrl = "";
      itemType = "code";
    }

    const newChunkId = makeNewChunkIdV2(projectId, sourceId, itemPath, itemUrl, itemType, normalizedContent);

    // Build the new-schema row. Preserve fields common to both schemas.
    // Materialise the vector to a concrete Float32Array — Apache Arrow Vector objects
    // returned by toArray() do not serialise correctly when passed directly to createTable.
    const newRow: Record<string, unknown> = {
      chunk_id: newChunkId,
      project_id: row["project_id"] ?? projectId,
      item_path: itemPath,
      content: row["content"],
      vector: materializeVector(row["vector"]),
    };

    if (profile === "knowledge") {
      newRow["source_id"] = row["source_id"] ?? sourceId;
      newRow["item_url"] = itemUrl;
      newRow["item_type"] = itemType;
      newRow["author"] = row["author"] ?? "";
      newRow["timestamp"] = row["timestamp"] ?? "";
    } else {
      newRow["start_line"] = row["start_line"] ?? 0;
      newRow["end_line"] = row["end_line"] ?? 0;
      newRow["language"] = row["language"] ?? "";
      newRow["symbol_name"] = row["symbol_name"] ?? "";
    }

    newRows.push(newRow);
    rowsRehashed++;
    opts.onProgress?.(rowsRehashed, total);
  }

  // Steps 4–6: Drop old table, recreate with new schema, bulk-insert.
  // RISK: if the process crashes between drop (step 4) and recreate (step 6),
  // data is permanently lost for this table. The sidecar still says "1→2-migrating"
  // and the "missing table + migrating marker" guard at the top of this function
  // will return a clear error pointing the user to reindex --full.
  daemonLog({
    event: "migration.pre_drop",
    tableName, projectId, sourceId, rows: total,
    warning: "Data loss window: crash between drop and recreate requires reindex --full to recover.",
  });

  try {
    await db.dropTable(tableName);
  } catch (err) {
    daemonLog({ event: "migration.failed", tableName, projectId, sourceId, reason: `dropTable failed: ${String(err)}` });
    return {
      status: "failed",
      rows_rehashed: 0,
      reason: `Failed to drop old table: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Detect vector dimensions from the materialised Float32Array in the first new row.
  const firstVec = newRows[0]?.["vector"] as Float32Array | undefined;
  const dimensions: number = firstVec?.length ?? 1536;

  const schema = profile === "knowledge"
    ? makeKnowledgeSchema(dimensions)
    : makeSchema(dimensions);

  try {
    const newTable = await db.createTable(tableName, newRows as any, { schema });
    // Verify creation succeeded
    await newTable.countRows();
  } catch (err) {
    daemonLog({ event: "migration.failed", tableName, projectId, sourceId, reason: `createTable failed: ${String(err)}` });
    return {
      status: "failed",
      rows_rehashed: rowsRehashed,
      reason: `Failed to recreate table: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 7: Stamp scheme 2
  writeTableMetaAt(dbPath, tableName, {
    chunk_id_scheme: CURRENT_CHUNK_ID_SCHEME,
    chunk_id_scheme_introduced_in: CURRENT_CHUNK_ID_SCHEME_VERSION,
  });

  daemonLog({ event: "migration.completed", tableName, projectId, sourceId, rows_rehashed: rowsRehashed });

  return { status: "ok", rows_rehashed: rowsRehashed };
}
