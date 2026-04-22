import { DatabaseSync, StatementSync } from "node:sqlite";
import { join } from "path";
import { config } from "./config.js";

export interface BranchTag {
  projectId: string;
  sourceId: string;
  branch: string;
  filePath: string;   // normalized: forward slashes, lowercased on Windows
  chunkId: string;
  startLine: number;
  endLine: number;
}

// Lazy-open handle — re-opens after closeBranchTagsDB() or vi.resetModules()
let _db: DatabaseSync | null = null;

function getDB(): DatabaseSync {
  if (_db) return _db;

  const dbPath = join(config.dataDir, "branch-tags.db");
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_tags (
      project_id  TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      branch      TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      chunk_id    TEXT NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      PRIMARY KEY (project_id, source_id, branch, file_path, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_tags_chunk
      ON branch_tags(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_branch_tags_lookup
      ON branch_tags(project_id, source_id, branch);
    CREATE INDEX IF NOT EXISTS idx_branch_tags_file
      ON branch_tags(project_id, source_id, branch, file_path);
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed schema version if absent
  db.prepare(
    "INSERT OR IGNORE INTO schema_meta(key,value) VALUES('version','1')"
  ).run();

  _db = db;
  return db;
}

/** Close the sqlite handle and null it — required for test isolation with vi.resetModules(). */
export function closeBranchTagsDB(): void {
  _db?.close();
  _db = null;
}

function normalizePath(filePath: string): string {
  const fwd = filePath.replace(/\\/g, "/");
  return process.platform === "win32" ? fwd.toLowerCase() : fwd;
}

export function addTags(tags: BranchTag[]): void {
  if (tags.length === 0) return;
  const db = getDB();
  const stmt: StatementSync = db.prepare(
    `INSERT OR IGNORE INTO branch_tags
       (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    for (const t of tags) {
      stmt.run(
        t.projectId, t.sourceId, t.branch,
        normalizePath(t.filePath), t.chunkId,
        t.startLine, t.endLine
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function removeTagsForFile(
  projectId: string,
  sourceId: string,
  branch: string,
  filePath: string
): void {
  getDB().prepare(
    "DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
  ).run(projectId, sourceId, branch, normalizePath(filePath));
}

export function removeTagsForBranch(
  projectId: string,
  sourceId: string,
  branch: string
): void {
  getDB().prepare(
    "DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?"
  ).run(projectId, sourceId, branch);
}

export function getChunkIdsForBranch(
  projectId: string,
  sourceId: string,
  branch: string
): Set<string> {
  const rows = getDB().prepare(
    "SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?"
  ).all(projectId, sourceId, branch) as { chunk_id: string }[];
  return new Set(rows.map((r) => r.chunk_id));
}

export function getBranchesForSource(
  projectId: string,
  sourceId: string
): string[] {
  const rows = getDB().prepare(
    "SELECT DISTINCT branch FROM branch_tags WHERE project_id=? AND source_id=?"
  ).all(projectId, sourceId) as { branch: string }[];
  return rows.map((r) => r.branch);
}

export function countTagsForChunk(chunkId: string): number {
  const row = getDB().prepare(
    "SELECT COUNT(*) AS n FROM branch_tags WHERE chunk_id=?"
  ).get(chunkId) as { n: number };
  return row.n;
}

/** Returns the set of all chunk_ids tagged for any branch of this (project, source). */
export function getAllChunkIdsForSource(projectId: string, sourceId: string): Set<string> {
  const rows = getDB().prepare(
    "SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=?"
  ).all(projectId, sourceId) as { chunk_id: string }[];
  return new Set(rows.map((r) => r.chunk_id));
}

/** Returns chunk_ids tagged for a specific file on a specific branch. */
export function getChunkIdsForFile(
  projectId: string,
  sourceId: string,
  branch: string,
  filePath: string
): string[] {
  const rows = getDB().prepare(
    "SELECT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
  ).all(projectId, sourceId, branch, normalizePath(filePath)) as { chunk_id: string }[];
  return rows.map((r) => r.chunk_id);
}
