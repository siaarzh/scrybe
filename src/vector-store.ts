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
  const table = await openExistingTable(tableName);
  if (!table) return;
  await table.delete(`project_id = '${escapeSql(projectId)}'`);
  await maybeCompact(table);
}

export async function deleteFileChunks(
  projectId: string,
  filePath: string,
  tableName: string
): Promise<void> {
  const table = await openExistingTable(tableName);
  if (!table) return;
  await table.delete(
    `project_id = '${escapeSql(projectId)}' AND file_path = '${escapeSql(filePath)}'`
  );
  await maybeCompact(table);
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
  const table = await openExistingTable(tableName);
  if (!table) return;
  await table.delete(`project_id = '${escapeSql(projectId)}'`);
  await maybeCompact(table);
}

export async function deleteKnowledgeSource(
  projectId: string,
  sourcePath: string,
  tableName: string
): Promise<void> {
  const table = await openExistingTable(tableName);
  if (!table) return;
  await table.delete(
    `project_id = '${escapeSql(projectId)}' AND source_path = '${escapeSql(sourcePath)}'`
  );
  await maybeCompact(table);
}

// ─── Compaction ───────────────────────────────────────────────────────────────

export const COMPACT_THRESHOLD = parseInt(process.env.SCRYBE_LANCE_COMPACT_THRESHOLD ?? "10", 10);
const ONE_HOUR_MS = 3_600_000;

/**
 * Compact a table when version count exceeds the threshold.
 * Keeps a 1h grace window so concurrent daemon readers still see their snapshot.
 */
async function maybeCompact(table: lancedb.Table): Promise<void> {
  const versions = await table.listVersions();
  if (versions.length < COMPACT_THRESHOLD) return;
  await table.optimize({ cleanupOlderThan: new Date(Date.now() - ONE_HOUR_MS) });
}

/**
 * Full-purge compaction — removes all old versions with no grace period.
 * Called by `scrybe gc` where the user explicitly requested maximum reclaim.
 * Returns bytes reclaimed by the prune step (0 if table missing or nothing to reclaim).
 */
export async function compactTable(tableName: string): Promise<number> {
  const table = await openExistingTable(tableName);
  if (!table) return 0;
  const stats = await table.optimize({ cleanupOlderThan: new Date() });
  return stats.prune?.bytesRemoved ?? 0;
}

/**
 * Return size (bytes) and version count for a table.
 * Size is computed by walking the .lance directory on disk.
 */
export async function getTableStats(tableName: string): Promise<{ sizeBytes: number; versionCount: number }> {
  const table = await openExistingTable(tableName);
  const versionCount = table ? (await table.listVersions()).length : 0;

  const tableDir = join(DB_PATH, `${tableName}.lance`);
  let sizeBytes = 0;
  if (existsSync(tableDir)) {
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        } else {
          try { sizeBytes += statSync(full).size; } catch { /* ignore races */ }
        }
      }
    };
    walkDir(tableDir);
  }

  return { sizeBytes, versionCount };
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
  const table = await openExistingTable(tableName);
  if (!table) return;
  const ids = chunkIds.map((id) => `'${escapeSql(id)}'`).join(", ");
  await table.delete(`chunk_id IN (${ids})`);
  await maybeCompact(table);
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
