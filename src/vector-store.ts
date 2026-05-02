import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { mkdirSync, statSync, readdirSync, existsSync, rmSync, readFileSync } from "fs";
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
  const schema = await table.schema();
  const rows = chunks.map((chunk, i) => ({
    chunk_id: chunk.chunk_id,
    project_id: chunk.project_id,
    file_path: chunk.file_path,
    content: chunk.content,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    language: chunk.language,
    symbol_name: chunk.symbol_name,
    vector: Array.from(vectors[i]),
  }));
  // Build a schema-typed Arrow Table so that mergeInsert.execute() gets correct
  // column types (non-nullable fields, int32 for line numbers, FixedSizeList for vector).
  // mergeInsert.execute() calls fromDataToBuffer without schema, which infers nullable=true
  // and double for integers — passing an ArrowTable with the table schema avoids the mismatch.
  const arrowTable = lancedb.makeArrowTable(rows, { schema });
  await table.mergeInsert(["chunk_id"])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(arrowTable);
  // maybeCompact removed — end-of-run compactTableWithGrace handles housekeeping.
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

async function ftsIndexExists(table: lancedb.Table, tableName: string, column: string): Promise<boolean> {
  const indices = await table.listIndices();
  const inManifest = indices.some(
    (idx) => idx.indexType.toUpperCase().includes("FTS") && idx.columns.includes(column),
  );
  if (!inManifest) return false;
  // Verify the UUID dirs actually exist — manifest can reference a UUID that was deleted.
  const indicesDir = join(DB_PATH, `${tableName}.lance`, "_indices");
  if (!existsSync(indicesDir)) return false;
  return readdirSync(indicesDir, { withFileTypes: true }).some((e) => e.isDirectory());
}

export async function createFtsIndex(tableName: string): Promise<void> {
  const table = await openExistingTable(tableName);
  if (!table) return;
  if ((await table.countRows()) === 0) return;
  if (await ftsIndexExists(table, tableName, "content")) return;
  await writeWithRetry(tableName, async (t) => {
    await t.createIndex("content", {
      config: lancedb.Index.fts({ stem: false, lowercase: true }),
      replace: true,
    });
    await maybeCompact(t);
  });
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
  const schema = await table.schema();
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
    vector: Array.from(vectors[i]),
  }));
  // Same schema-typing approach as upsert() — see comment there.
  const arrowTable = lancedb.makeArrowTable(rows, { schema });
  await table.mergeInsert(["chunk_id"])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(arrowTable);
  // maybeCompact removed — end-of-run compactTableWithGrace handles housekeeping.
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
  const table = await openExistingTable(tableName);
  if (!table) return;
  if ((await table.countRows()) === 0) return;
  if (await ftsIndexExists(table, tableName, "content")) return;
  await writeWithRetry(tableName, async (t) => {
    await t.createIndex("content", {
      config: lancedb.Index.fts({ stem: false, lowercase: true }),
      replace: true,
    });
    await maybeCompact(t);
  });
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

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { total += statSync(full).size; } catch { /* ignore races */ } }
    }
  };
  walk(dir);
  return total;
}

function dirSizeBytes(tableName: string): number {
  return dirBytes(join(DB_PATH, `${tableName}.lance`));
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

/**
 * Delete `_indices/` UUID directories not referenced by any retained manifest version.
 * Lance's `optimize()` prunes manifest versions but leaves their UUID subdirs behind.
 *
 * Lance stores index UUIDs as raw 16-byte binary in Protobuf manifests (field tag 0x0a,
 * length 0x10). We scan every retained manifest for `\x0a\x10` + 16 bytes sequences and
 * convert to hyphenated UUID strings to match against `_indices/` subdirectory names.
 * We over-collect (any 0x0a10+16b match) — safe because false positives only mean we
 * retain extra dirs, never delete live ones.
 *
 * Returns zero on any filesystem error rather than risking wrong deletions.
 */
export async function pruneIndexOrphans(
  tableName: string,
): Promise<{ removed: number; bytesFreed: number }> {
  const tableDir = join(DB_PATH, `${tableName}.lance`);
  const indicesDir = join(tableDir, "_indices");
  const versionsDir = join(tableDir, "_versions");
  if (!existsSync(indicesDir) || !existsSync(versionsDir)) return { removed: 0, bytesFreed: 0 };

  // Collect UUIDs referenced by any retained manifest.
  const referenced = new Set<string>();
  for (const f of readdirSync(versionsDir)) {
    try {
      const buf = readFileSync(join(versionsDir, f));
      for (let i = 0; i < buf.length - 17; i++) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x10) {
          const hex = buf.slice(i + 2, i + 18).toString("hex");
          referenced.add(
            `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
          );
        }
      }
    } catch { /* skip — better to keep orphans than delete live ones */ }
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const entry of readdirSync(indicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (referenced.has(entry.name)) continue;
    const dir = join(indicesDir, entry.name);
    try {
      bytesFreed += dirBytes(dir);
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* concurrent writer — skip, next gc will catch it */ }
  }
  return { removed, bytesFreed };
}
