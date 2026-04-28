import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { mkdirSync, statSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import type { CodeChunk, SearchResult, KnowledgeChunk, KnowledgeSearchResult } from "./types.js";

const DB_PATH = join(config.dataDir, "lancedb");

function makeSchema(dimensions: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("file_path", new Utf8(), false),
    new Field("content", new Utf8(), false),
    new Field("start_line", new Int32(), false),
    new Field("end_line", new Int32(), false),
    new Field("language", new Utf8(), false),
    new Field("symbol_name", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dimensions, new Field("item", new Float32(), false)),
      false
    ),
  ]);
}

function makeKnowledgeSchema(dimensions: number): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("source_path", new Utf8(), false),
    new Field("source_url", new Utf8(), false),
    new Field("source_type", new Utf8(), false),
    new Field("author", new Utf8(), false),
    new Field("timestamp", new Utf8(), false),
    new Field("content", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dimensions, new Field("item", new Float32(), false)),
      false
    ),
  ]);
}

let _db: lancedb.Connection | null = null;
const _tableCache = new Map<string, lancedb.Table>();

function isCommitConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /commit conflict|cannot be automatically resolved/i.test(msg);
}

function evictTableCache(tableName: string): void {
  _tableCache.delete(tableName);
}

async function writeWithRetry<T>(
  tableName: string,
  op: (t: lancedb.Table) => Promise<T>
): Promise<T> {
  const table = await openExistingTable(tableName);
  if (!table) throw new Error(`Table '${tableName}' not found`);
  try {
    return await op(table);
  } catch (err) {
    if (!isCommitConflict(err)) throw err;
    // Stale handle — evict, reopen, single retry
    evictTableCache(tableName);
    const fresh = await openExistingTable(tableName);
    if (!fresh) throw err;
    process.stderr.write(`[scrybe] commit conflict on '${tableName}' — evicting cached table handle and retrying\n`);
    return await op(fresh);
  }
}

async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    mkdirSync(DB_PATH, { recursive: true });
    _db = await lancedb.connect(DB_PATH);
  }
  return _db;
}

async function getProjectTable(
  tableName: string,
  dimensions: number,
  profile: "code" | "knowledge"
): Promise<lancedb.Table> {
  const cached = _tableCache.get(tableName);
  if (cached) return cached;
  const db = await getDb();
  const names = await db.tableNames();
  let table: lancedb.Table;
  if (names.includes(tableName)) {
    table = await db.openTable(tableName);
  } else {
    const schema =
      profile === "code"
        ? makeSchema(dimensions)
        : makeKnowledgeSchema(dimensions);
    table = await db.createEmptyTable(tableName, schema);
  }
  _tableCache.set(tableName, table);
  return table;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function openExistingTable(tableName: string): Promise<lancedb.Table | null> {
  const cached = _tableCache.get(tableName);
  if (cached) return cached;
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(tableName)) return null;
  const table = await db.openTable(tableName);
  _tableCache.set(tableName, table);
  return table;
}

// ─── Code table operations ────────────────────────────────────────────────────

export async function upsert(
  chunks: CodeChunk[],
  vectors: number[][],
  tableName: string,
  dimensions: number
): Promise<void> {
  if (chunks.length === 0) return;
  const table = await getProjectTable(tableName, dimensions, "code");
  const rows = chunks.map((chunk, i) => ({
    chunk_id: chunk.chunk_id,
    project_id: chunk.project_id,
    file_path: chunk.file_path,
    content: chunk.content,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    language: chunk.language,
    symbol_name: chunk.symbol_name,
    vector: Float32Array.from(vectors[i]),
  }));
  await table.add(rows);
  await maybeCompact(table);
}

export async function search(
  queryVector: number[],
  projectId: string,
  topK: number,
  tableName: string,
  dimensions: number,
  chunkIdIn?: string[]
): Promise<SearchResult[]> {
  const table = await getProjectTable(tableName, dimensions, "code");
  let where = `project_id = '${escapeSql(projectId)}'`;
  if (chunkIdIn && chunkIdIn.length > 0) {
    const ids = chunkIdIn.map((id) => `'${escapeSql(id)}'`).join(", ");
    where += ` AND chunk_id IN (${ids})`;
  }
  const rows = await table
    .search(Float32Array.from(queryVector))
    .where(where)
    .limit(topK)
    .toArray();

  return rows.map((row) => ({
    chunk_id: String(row.chunk_id),
    score: 1 - (Number(row._distance ?? 0) ** 2) / 2,
    project_id: String(row.project_id),
    source_id: "",   // threaded in by search.ts fan-out
    file_path: String(row.file_path),
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    language: String(row.language),
    symbol_name: String(row.symbol_name),
    content: String(row.content),
    branches: [] as string[],  // annotated by search.ts after rerank
  }));
}

export async function ftsSearch(
  query: string,
  projectId: string,
  topK: number,
  tableName: string,
  chunkIdIn?: string[]
): Promise<SearchResult[]> {
  const table = _tableCache.get(tableName);
  if (!table) return [];
  let where = `project_id = '${escapeSql(projectId)}'`;
  if (chunkIdIn && chunkIdIn.length > 0) {
    const ids = chunkIdIn.map((id) => `'${escapeSql(id)}'`).join(", ");
    where += ` AND chunk_id IN (${ids})`;
  }
  const rows = await (table.search(query, "fts", "content") as lancedb.Query)
    .where(where)
    .limit(topK)
    .toArray();
  return rows.map((row) => ({
    chunk_id: String(row.chunk_id),
    score: 0,
    project_id: String(row.project_id),
    source_id: "",   // threaded in by search.ts fan-out
    file_path: String(row.file_path),
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    language: String(row.language),
    symbol_name: String(row.symbol_name),
    content: String(row.content),
    branches: [] as string[],  // annotated by search.ts after rerank
  }));
}

export async function createFtsIndex(tableName: string): Promise<void> {
  const table = _tableCache.get(tableName);
  if (!table) return;
  if ((await table.countRows()) === 0) return;
  await table.createIndex("content", {
    config: lancedb.Index.fts({ stem: false, lowercase: true }),
    replace: true,
  });
  await maybeCompact(table);
}

export async function deleteProject(projectId: string, tableName: string): Promise<void> {
  const existing = await openExistingTable(tableName);
  if (!existing) return;
  await writeWithRetry(tableName, async (t) => {
    await t.delete(`project_id = '${escapeSql(projectId)}'`);
    await maybeCompact(t);
  });
}

export async function deleteFileChunks(
  projectId: string,
  filePath: string,
  tableName: string
): Promise<void> {
  const existing = await openExistingTable(tableName);
  if (!existing) return;
  await writeWithRetry(tableName, async (t) => {
    await t.delete(
      `project_id = '${escapeSql(projectId)}' AND file_path = '${escapeSql(filePath)}'`
    );
    await maybeCompact(t);
  });
}

// ─── Knowledge table operations ───────────────────────────────────────────────

export async function upsertKnowledge(
  chunks: KnowledgeChunk[],
  vectors: number[][],
  tableName: string,
  dimensions: number
): Promise<void> {
  if (chunks.length === 0) return;
  const table = await getProjectTable(tableName, dimensions, "knowledge");
  const rows = chunks.map((chunk, i) => ({
    chunk_id: chunk.chunk_id,
    project_id: chunk.project_id,
    source_id: chunk.source_id,
    source_path: chunk.source_path,
    source_url: chunk.source_url,
    source_type: chunk.source_type,
    author: chunk.author,
    timestamp: chunk.timestamp,
    content: chunk.content,
    vector: Float32Array.from(vectors[i]),
  }));
  await table.add(rows);
  await maybeCompact(table);
}

export async function searchKnowledge(
  queryVector: number[],
  projectId: string,
  topK: number,
  tableName: string,
  dimensions: number
): Promise<KnowledgeSearchResult[]> {
  const table = await getProjectTable(tableName, dimensions, "knowledge");
  const rows = await table
    .search(Float32Array.from(queryVector))
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();

  return rows.map((row) => ({
    score: 1 - (Number(row._distance ?? 0) ** 2) / 2,
    project_id: String(row.project_id),
    source_id: String(row.source_id ?? ""),
    source_path: String(row.source_path),
    source_url: String(row.source_url),
    source_type: String(row.source_type),
    author: String(row.author),
    timestamp: String(row.timestamp),
    content: String(row.content),
  }));
}

export async function ftsSearchKnowledge(
  query: string,
  projectId: string,
  topK: number,
  tableName: string
): Promise<KnowledgeSearchResult[]> {
  const table = _tableCache.get(tableName);
  if (!table) return [];
  const rows = await (table.search(query, "fts", "content") as lancedb.Query)
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();
  return rows.map((row) => ({
    score: 0,
    project_id: String(row.project_id),
    source_id: String(row.source_id ?? ""),
    source_path: String(row.source_path),
    source_url: String(row.source_url),
    source_type: String(row.source_type),
    author: String(row.author),
    timestamp: String(row.timestamp),
    content: String(row.content),
  }));
}

export async function createKnowledgeFtsIndex(tableName: string): Promise<void> {
  const table = _tableCache.get(tableName);
  if (!table) return;
  if ((await table.countRows()) === 0) return;
  await table.createIndex("content", {
    config: lancedb.Index.fts({ stem: false, lowercase: true }),
    replace: true,
  });
  await maybeCompact(table);
}

export async function deleteKnowledgeProject(projectId: string, tableName: string): Promise<void> {
  const existing = await openExistingTable(tableName);
  if (!existing) return;
  await writeWithRetry(tableName, async (t) => {
    await t.delete(`project_id = '${escapeSql(projectId)}'`);
    await maybeCompact(t);
  });
}

export async function deleteKnowledgeSource(
  projectId: string,
  sourcePath: string,
  tableName: string
): Promise<void> {
  const existing = await openExistingTable(tableName);
  if (!existing) return;
  await writeWithRetry(tableName, async (t) => {
    await t.delete(
      `project_id = '${escapeSql(projectId)}' AND source_path = '${escapeSql(sourcePath)}'`
    );
    await maybeCompact(t);
  });
}

// ─── Compaction ───────────────────────────────────────────────────────────────

export const COMPACT_THRESHOLD = parseInt(process.env.SCRYBE_LANCE_COMPACT_THRESHOLD ?? "10", 10);

// Grace window for `optimize({ cleanupOlderThan })`. Long enough for a typical
// search+rerank to complete, short enough that a multi-batch indexing burst
// can't accumulate gigabytes of orphaned fragments before pruning runs.
// Tunable via SCRYBE_LANCE_GRACE_MS.
const DEFAULT_GRACE_MS = 60_000;
const GRACE_MS = (() => {
  const raw = parseInt(process.env.SCRYBE_LANCE_GRACE_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MS;
})();

function dirSizeBytes(tableName: string): number {
  const tableDir = join(DB_PATH, `${tableName}.lance`);
  if (!existsSync(tableDir)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { total += statSync(full).size; } catch { /* ignore races */ } }
    }
  };
  walk(tableDir);
  return total;
}

/**
 * Compact a table when version count exceeds the threshold.
 * Keeps a brief grace window (default 60s) so an in-flight cross-process search
 * still sees its snapshot. The 1h grace used previously caused multi-GB bloat
 * during sustained indexing bursts.
 */
async function maybeCompact(table: lancedb.Table): Promise<void> {
  const versions = await table.listVersions();
  if (versions.length < COMPACT_THRESHOLD) return;
  await table.optimize({ cleanupOlderThan: new Date(Date.now() - GRACE_MS) });
}

/**
 * Result of a compaction call. The disk delta alone can't tell users whether
 * the bytes are real reclaim or pure manifest churn from the optimize() call
 * itself (which writes a new manifest version every time it runs and prunes
 * the prior one — ~400 B of noise per call). The compaction stats let callers
 * separate those signals.
 */
export interface CompactResult {
  /** max(0, dirSize before - dirSize after) — measured on disk. Includes manifest churn. */
  bytesFreed: number;
  /** True iff compaction merged or wrote fragments, or pruned >1 manifest version. */
  hadRealWork: boolean;
  /** Number of small fragments retired by compaction (CompactionStats.fragmentsRemoved). */
  fragmentsMerged: number;
  /** Number of manifest versions pruned. ≥1 every call (the optimize call self-prunes); >1 means real catch-up. */
  versionsPruned: number;
}

const EMPTY_COMPACT_RESULT: CompactResult = {
  bytesFreed: 0, hadRealWork: false, fragmentsMerged: 0, versionsPruned: 0,
};

/**
 * End-of-burst compaction — fires unconditionally (no version threshold) but
 * keeps the grace window. Called after each indexing run to clean up fragments
 * accumulated during the burst without disturbing concurrent readers.
 */
export async function compactTableWithGrace(tableName: string): Promise<CompactResult> {
  const table = await openExistingTable(tableName);
  if (!table) return EMPTY_COMPACT_RESULT;
  const before = dirSizeBytes(tableName);
  const stats = await table.optimize({ cleanupOlderThan: new Date(Date.now() - GRACE_MS) });
  const after = dirSizeBytes(tableName);
  return classify(before, after, stats);
}

/**
 * Full-purge compaction — removes all old versions with no grace period.
 * Called by `scrybe gc` where the user explicitly requested maximum reclaim.
 * Lance's `OptimizeStats.prune.bytesRemoved` is unreliable — it counts bytes
 * referenced by the dropped manifest version, not bytes physically deleted —
 * so the disk delta is measured directly. Compaction stats are returned so
 * callers can distinguish real reclaim from manifest-rewrite noise.
 */
export async function compactTable(tableName: string): Promise<CompactResult> {
  const table = await openExistingTable(tableName);
  if (!table) return EMPTY_COMPACT_RESULT;
  const before = dirSizeBytes(tableName);
  const stats = await table.optimize({ cleanupOlderThan: new Date() });
  const after = dirSizeBytes(tableName);
  return classify(before, after, stats);
}

function classify(
  before: number,
  after: number,
  stats: { compaction: { fragmentsRemoved: number; fragmentsAdded: number; filesRemoved: number; filesAdded: number }; prune: { oldVersionsRemoved: number } }
): CompactResult {
  const hadRealWork =
    stats.compaction.filesRemoved > 0 ||
    stats.compaction.filesAdded > 0 ||
    stats.prune.oldVersionsRemoved > 1;
  return {
    bytesFreed: Math.max(0, before - after),
    hadRealWork,
    fragmentsMerged: stats.compaction.fragmentsRemoved,
    versionsPruned: stats.prune.oldVersionsRemoved,
  };
}

/**
 * Return size (bytes) and version count for a table.
 * Size is computed by walking the .lance directory on disk.
 */
export async function getTableStats(tableName: string): Promise<{ sizeBytes: number; versionCount: number }> {
  const table = await openExistingTable(tableName);
  const versionCount = table ? (await table.listVersions()).length : 0;
  return { sizeBytes: dirSizeBytes(tableName), versionCount };
}

// ─── Table lifecycle ──────────────────────────────────────────────────────────

/**
 * Returns all chunk_ids for a project in a table.
 * Used by `scrybe gc` to find orphan chunks.
 */
export async function listChunkIds(projectId: string, tableName: string): Promise<string[]> {
  const table = await openExistingTable(tableName);
  if (!table) return [];
  const rows = await table
    .query()
    .select(["chunk_id"])
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(Number.MAX_SAFE_INTEGER)
    .toArray();
  return rows.map((r) => String(r.chunk_id));
}

/**
 * Deletes specific chunks by chunk_id from a table.
 * Used by `scrybe gc` to remove orphan chunks.
 */
export async function deleteChunks(chunkIds: string[], tableName: string): Promise<void> {
  if (chunkIds.length === 0) return;
  const existing = await openExistingTable(tableName);
  if (!existing) return;
  const ids = chunkIds.map((id) => `'${escapeSql(id)}'`).join(", ");
  await writeWithRetry(tableName, async (t) => {
    await t.delete(`chunk_id IN (${ids})`);
    await maybeCompact(t);
  });
}

/** Count rows in a named table. Returns 0 if table doesn't exist. */
export async function countTableRows(tableName: string): Promise<number> {
  try {
    const table = await openExistingTable(tableName);
    if (!table) return 0;
    return await table.countRows();
  } catch {
    return 0;
  }
}

/** Drop a named table entirely (used by removeSource / removeProject). */
export async function dropTable(tableName: string): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(tableName)) {
    await db.dropTable(tableName);
  }
  _tableCache.delete(tableName);
}
