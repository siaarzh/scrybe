import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, Int32, Float32, FixedSizeList } from "apache-arrow";
import { mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import type { CodeChunk, SearchResult, KnowledgeChunk, KnowledgeSearchResult } from "./types.js";

const DB_PATH = join(config.dataDir, "lancedb");
const TABLE_NAME = "code_chunks";
const KNOWLEDGE_TABLE_NAME = "knowledge_chunks";

function makeSchema(): Schema {
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
      new FixedSizeList(
        config.embeddingDimensions,
        new Field("item", new Float32(), false)
      ),
      false
    ),
  ]);
}

function makeKnowledgeSchema(): Schema {
  return new Schema([
    new Field("chunk_id", new Utf8(), false),
    new Field("project_id", new Utf8(), false),
    new Field("source_path", new Utf8(), false),
    new Field("source_url", new Utf8(), false),
    new Field("source_type", new Utf8(), false),
    new Field("author", new Utf8(), false),
    new Field("timestamp", new Utf8(), false),
    new Field("content", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(
        config.textEmbeddingDimensions,
        new Field("item", new Float32(), false)
      ),
      false
    ),
  ]);
}

let _db: lancedb.Connection | null = null;
let _table: lancedb.Table | null = null;
let _knowledgeTable: lancedb.Table | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    mkdirSync(DB_PATH, { recursive: true });
    _db = await lancedb.connect(DB_PATH);
  }
  return _db;
}

export async function getTable(): Promise<lancedb.Table> {
  if (_table) return _table;
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(TABLE_NAME)) {
    _table = await db.openTable(TABLE_NAME);
  } else {
    _table = await db.createEmptyTable(TABLE_NAME, makeSchema());
  }
  return _table;
}

/** Drop and recreate the table (used when switching embedding dimensions). */
export async function resetTable(): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME);
  }
  _table = await db.createEmptyTable(TABLE_NAME, makeSchema());
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export async function upsert(
  chunks: CodeChunk[],
  vectors: number[][]
): Promise<void> {
  if (chunks.length === 0) return;
  const table = await getTable();
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
  topK: number
): Promise<SearchResult[]> {
  const table = await getTable();
  const rows = await table
    .search(Float32Array.from(queryVector))
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();

  return rows.map((row) => ({
    chunk_id: String(row.chunk_id),
    // LanceDB default is L2 distance. For unit-normalized embeddings:
    // cosine_similarity = 1 - (L2_dist^2 / 2)
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
  topK: number
): Promise<SearchResult[]> {
  const table = await getTable();
  const rows = await (table.search(query, "fts", "content") as lancedb.Query)
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();
  return rows.map((row) => ({
    chunk_id: String(row.chunk_id),
    score: 0, // rank implied by array order; RRF assigns final score
    project_id: String(row.project_id),
    file_path: String(row.file_path),
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    language: String(row.language),
    symbol_name: String(row.symbol_name),
    content: String(row.content),
  }));
}

export async function createFtsIndex(): Promise<void> {
  const table = await getTable();
  if ((await table.countRows()) === 0) return;
  await table.createIndex("content", {
    config: lancedb.Index.fts({ stem: false, lowercase: true }),
    replace: true,
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  const table = await getTable();
  await table.delete(`project_id = '${escapeSql(projectId)}'`);
}

export async function deleteFileChunks(
  projectId: string,
  filePath: string
): Promise<void> {
  const table = await getTable();
  await table.delete(
    `project_id = '${escapeSql(projectId)}' AND file_path = '${escapeSql(filePath)}'`
  );
}

// ─── Knowledge table ────────────────────────────────────────────────────────

export async function getKnowledgeTable(): Promise<lancedb.Table> {
  if (_knowledgeTable) return _knowledgeTable;
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(KNOWLEDGE_TABLE_NAME)) {
    _knowledgeTable = await db.openTable(KNOWLEDGE_TABLE_NAME);
  } else {
    _knowledgeTable = await db.createEmptyTable(KNOWLEDGE_TABLE_NAME, makeKnowledgeSchema());
  }
  return _knowledgeTable;
}

/** Drop and recreate the knowledge table (used when switching text embedding dimensions). */
export async function resetKnowledgeTable(): Promise<void> {
  const db = await getDb();
  const names = await db.tableNames();
  if (names.includes(KNOWLEDGE_TABLE_NAME)) {
    await db.dropTable(KNOWLEDGE_TABLE_NAME);
  }
  _knowledgeTable = await db.createEmptyTable(KNOWLEDGE_TABLE_NAME, makeKnowledgeSchema());
}

export async function upsertKnowledge(
  chunks: KnowledgeChunk[],
  vectors: number[][]
): Promise<void> {
  if (chunks.length === 0) return;
  const table = await getKnowledgeTable();
  const rows = chunks.map((chunk, i) => ({
    chunk_id: chunk.chunk_id,
    project_id: chunk.project_id,
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
  topK: number
): Promise<KnowledgeSearchResult[]> {
  const table = await getKnowledgeTable();
  const rows = await table
    .search(Float32Array.from(queryVector))
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();

  return rows.map((row) => ({
    score: 1 - (Number(row._distance ?? 0) ** 2) / 2,
    project_id: String(row.project_id),
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
  topK: number
): Promise<KnowledgeSearchResult[]> {
  const table = await getKnowledgeTable();
  const rows = await (table.search(query, "fts", "content") as lancedb.Query)
    .where(`project_id = '${escapeSql(projectId)}'`)
    .limit(topK)
    .toArray();
  return rows.map((row) => ({
    score: 0,
    project_id: String(row.project_id),
    source_path: String(row.source_path),
    source_url: String(row.source_url),
    source_type: String(row.source_type),
    author: String(row.author),
    timestamp: String(row.timestamp),
    content: String(row.content),
  }));
}

export async function createKnowledgeFtsIndex(): Promise<void> {
  const table = await getKnowledgeTable();
  if ((await table.countRows()) === 0) return;
  await table.createIndex("content", {
    config: lancedb.Index.fts({ stem: false, lowercase: true }),
    replace: true,
  });
}

export async function deleteKnowledgeProject(projectId: string): Promise<void> {
  const table = await getKnowledgeTable();
  await table.delete(`project_id = '${escapeSql(projectId)}'`);
}

export async function deleteKnowledgeSource(
  projectId: string,
  sourcePath: string
): Promise<void> {
  const table = await getKnowledgeTable();
  await table.delete(
    `project_id = '${escapeSql(projectId)}' AND source_path = '${escapeSql(sourcePath)}'`
  );
}
