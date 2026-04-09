import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { mkdirSync } from "fs";
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
}

export async function search(
  queryVector: number[],
  projectId: string,
  topK: number,
  tableName: string,
  dimensions: number
): Promise<SearchResult[]> {
  const table = await getProjectTable(tableName, dimensions, "code");
  const rows = await table
    .search(Float32Array.from(queryVector))
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();

  return rows.map((row) => ({
    chunk_id: String(row.chunk_id),
    score: 1 - (Number(row._distance ?? 0) ** 2) / 2,
    project_id: String(row.project_id),
    file_path: String(row.file_path),
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    language: String(row.language),
    symbol_name: String(row.symbol_name),
    content: String(row.content),
  }));
}

export async function ftsSearch(
  query: string,
  projectId: string,
  topK: number,
  tableName: string
): Promise<SearchResult[]> {
  const table = _tableCache.get(tableName);
  if (!table) return [];
  const rows = await (table.search(query, "fts", "content") as lancedb.Query)
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();
  return rows.map((row) => ({
    chunk_id: String(row.chunk_id),
    score: 0,
    project_id: String(row.project_id),
    file_path: String(row.file_path),
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    language: String(row.language),
    symbol_name: String(row.symbol_name),
    content: String(row.content),
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
}

export async function deleteProject(projectId: string, tableName: string): Promise<void> {
  const table = await openExistingTable(tableName);
  if (!table) return;
  await table.delete(`project_id = '${escapeSql(projectId)}'`);
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
}

export async function deleteKnowledgeProject(projectId: string, tableName: string): Promise<void> {
  const table = await openExistingTable(tableName);
  if (!table) return;
  await table.delete(`project_id = '${escapeSql(projectId)}'`);
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
}

// ─── Table lifecycle ──────────────────────────────────────────────────────────

/** Drop a named table entirely (used by removeSource / removeProject). */
export async function dropTable(tableName: string): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(tableName)) {
    await db.dropTable(tableName);
  }
  _tableCache.delete(tableName);
}
