import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";
import { getSource } from "./registry.js";
import type { SourceConfig } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BranchTag {
  filePath: string;
  chunkId: string;
  startLine: number;
  endLine: number;
}

export type FileOutcome =
  | { kind: "embedded"; hash: string; tags: BranchTag[] }
  | { kind: "removed" }
  | { kind: "stale-tags-only" };

export interface BranchSession {
  /** File-path → hash map from the previous run (read-only). */
  readonly priorHashes: Readonly<Record<string, string>>;
  /** All chunk IDs currently in LanceDB for this source (any branch). Updated by applyFile. */
  readonly knownChunkIds: ReadonlySet<string>;
  /** Apply a per-file outcome: update hashes + branch tags atomically. */
  applyFile(path: string, outcome: FileOutcome): void;
  /** Delete all tags + hashes for the branch (full-reindex reset). */
  wipeBranch(): void;
  /** Return chunk IDs currently tagged for a file on this branch (for diagnostics). */
  snapshotChunkIdsForFile(path: string): string[];
}

export interface OpenSessionInput {
  projectId: string;
  sourceId: string;
  /** If omitted, auto-resolved from HEAD at rootPath. */
  branch?: string;
  /** Repo root path — used for branch auto-resolution when branch is omitted. */
  rootPath?: string;
  mode: "incremental" | "full";
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function slugifyBranch(branch: string): string {
  if (branch === "*") return "_all_";
  return branch.replace(/\//g, "__");
}

function normalizePath(filePath: string): string {
  const fwd = filePath.replace(/\\/g, "/");
  return process.platform === "win32" ? fwd.toLowerCase() : fwd;
}

function hashesDir(): string {
  return join(config.dataDir, "hashes");
}

function branchHashesPath(projectId: string, sourceId: string, branch: string): string {
  return join(hashesDir(), `${projectId}__${sourceId}__${slugifyBranch(branch)}.json`);
}

function loadBranchHashes(projectId: string, sourceId: string, branch: string): Record<string, string> {
  const p = branchHashesPath(projectId, sourceId, branch);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveBranchHashesAtomic(
  projectId: string,
  sourceId: string,
  branch: string,
  hashes: Record<string, string>
): void {
  mkdirSync(hashesDir(), { recursive: true });
  const target = branchHashesPath(projectId, sourceId, branch);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(hashes, null, 2), "utf8");
  renameSync(tmp, target);
}

function deleteBranchHashesFile(projectId: string, sourceId: string, branch: string): void {
  const p = branchHashesPath(projectId, sourceId, branch);
  if (existsSync(p)) unlinkSync(p);
}

// ─── SQLite DB ────────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null;

export function getDB(): DatabaseSync {
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
    CREATE TABLE IF NOT EXISTS jobs (
      job_id        TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      source_id     TEXT,
      branch        TEXT,
      mode          TEXT NOT NULL,
      status        TEXT NOT NULL,
      phase         TEXT,
      queued_at     INTEGER NOT NULL,
      started_at    INTEGER,
      finished_at   INTEGER,
      error_message TEXT,
      origin        TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'reindex',
      result        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_project_status
      ON jobs(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_queued_at
      ON jobs(queued_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_type_project
      ON jobs(type, project_id);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('version','1')").run();

  _db = db;
  return db;
}

/**
 * Close the SQLite handle and reset internal state.
 * Used by schema migration (to delete the DB file) and by test isolation.
 */
export function closeDB(): void {
  _db?.close();
  _db = null;
}

// ─── Branch resolution ────────────────────────────────────────────────────────

/** Resolve the current HEAD branch name from a git repo at repoPath. */
export function resolveBranchForPath(repoPath: string): string {
  try {
    const gitPath = join(repoPath, ".git");
    if (!existsSync(gitPath)) return "*";

    let headPath: string;
    const stat = lstatSync(gitPath);
    if (stat.isDirectory()) {
      headPath = join(gitPath, "HEAD");
    } else if (stat.isFile()) {
      // git worktree: .git file contains "gitdir: /path/to/actual/.git/worktrees/X"
      const ptr = readFileSync(gitPath, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/.exec(ptr);
      if (!m) return "*";
      headPath = join(resolve(repoPath, m[1].trim()), "HEAD");
    } else {
      return "*";
    }

    if (!existsSync(headPath)) return "*";
    const head = readFileSync(headPath, "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 12); // detached HEAD
    return head.slice("ref: ".length).replace(/^refs\/heads\//, "");
  } catch {
    return "*";
  }
}

/** Resolve the effective branch for a (project, source) pair. Returns "*" for non-code sources. */
export function resolveBranch(projectId: string, sourceId: string): string {
  const source = getSource(projectId, sourceId);
  if (!source) return "*";
  const cfg = source.source_config;
  if (cfg.type === "code") {
    const rootPath = (cfg as Extract<SourceConfig, { type: "code" }>).root_path;
    return resolveBranchForPath(rootPath);
  }
  return "*";
}

// ─── Standalone reads ─────────────────────────────────────────────────────────

/** List branches that have been indexed for a source. */
export function listBranches(projectId: string, sourceId: string): string[] {
  const rows = getDB().prepare(
    "SELECT DISTINCT branch FROM branch_tags WHERE project_id=? AND source_id=?"
  ).all(projectId, sourceId) as { branch: string }[];
  return rows.map((r) => r.branch);
}

/** Return the set of chunk IDs tagged for a specific branch. */
export function getChunkIdsForBranch(projectId: string, sourceId: string, branch: string): Set<string> {
  const rows = getDB().prepare(
    "SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?"
  ).all(projectId, sourceId, branch) as { chunk_id: string }[];
  return new Set(rows.map((r) => r.chunk_id));
}

/** Return the set of all chunk IDs tagged for any branch of this (project, source). */
export function getAllChunkIdsForSource(projectId: string, sourceId: string): Set<string> {
  const rows = getDB().prepare(
    "SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=?"
  ).all(projectId, sourceId) as { chunk_id: string }[];
  return new Set(rows.map((r) => r.chunk_id));
}

/** Delete all tags and hashes for a branch (orphan cleanup after branch deletion). */
export function deleteBranch(projectId: string, sourceId: string, branch: string): void {
  getDB().prepare(
    "DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?"
  ).run(projectId, sourceId, branch);
  deleteBranchHashesFile(projectId, sourceId, branch);
}

/**
 * Delete ALL branch_tags rows + ALL hash files for every branch of a (project, source).
 * Called by removeProject/removeSource before dropping the LanceDB table, so that a
 * subsequent project re-add + --full index starts with a clean slate (no stale
 * knownChunkIds that would cause the skip-embed fast-path to fire on every chunk).
 */
export function wipeSource(projectId: string, sourceId: string): void {
  getDB().prepare(
    "DELETE FROM branch_tags WHERE project_id=? AND source_id=?"
  ).run(projectId, sourceId);

  const dir = hashesDir();
  if (!existsSync(dir)) return;
  const prefix = `${projectId}__${sourceId}__`;
  for (const file of readdirSync(dir)) {
    if (file.startsWith(prefix) && file.endsWith(".json")) {
      try { unlinkSync(join(dir, file)); } catch { /* ignore ENOENT races */ }
    }
  }
}

/**
 * Reverse lookup: for each chunk_id, return all branches it's tagged on
 * across the given (project, source). Empty array for unknown chunk_ids.
 *
 * Uses idx_branch_tags_chunk. Single IN-query — no batching needed
 * (top-K caps at ~50, SQLite host-param limit is 32766+).
 *
 * Sort order: master/main first, then alphabetical.
 */
export function getBranchesForChunks(
  projectId: string,
  sourceId: string,
  chunkIds: string[]
): Map<string, string[]> {
  if (chunkIds.length === 0) return new Map();

  const placeholders = chunkIds.map(() => "?").join(", ");
  const rows = getDB().prepare(
    `SELECT chunk_id, branch FROM branch_tags WHERE project_id=? AND source_id=? AND chunk_id IN (${placeholders})`
  ).all(projectId, sourceId, ...chunkIds) as { chunk_id: string; branch: string }[];

  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (!map.has(row.chunk_id)) map.set(row.chunk_id, []);
    map.get(row.chunk_id)!.push(row.branch);
  }

  // Sort: master/main first, then alphabetical
  for (const [cid, branches] of map) {
    map.set(cid, branches.sort((a, b) => {
      const aPriority = (a === "master" || a === "main") ? 0 : 1;
      const bPriority = (b === "master" || b === "main") ? 0 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.localeCompare(b);
    }));
  }

  return map;
}

/** Count how many branch-tag rows reference a chunk (used to detect orphans). */
export function countTagsForChunk(chunkId: string): number {
  const row = getDB().prepare(
    "SELECT COUNT(*) AS n FROM branch_tags WHERE chunk_id=?"
  ).get(chunkId) as { n: number };
  return row.n;
}

// ─── Session implementation ───────────────────────────────────────────────────

class BranchSessionImpl implements BranchSession {
  readonly priorHashes: Readonly<Record<string, string>>;
  readonly knownChunkIds: Set<string>;

  private _hashes: Record<string, string>;
  private readonly _projectId: string;
  private readonly _sourceId: string;
  private readonly _branch: string;

  constructor(
    projectId: string,
    sourceId: string,
    branch: string,
    mode: "incremental" | "full"
  ) {
    this._projectId = projectId;
    this._sourceId = sourceId;
    this._branch = branch;

    this._hashes = mode === "full" ? {} : loadBranchHashes(projectId, sourceId, branch);
    this.priorHashes = Object.freeze({ ...this._hashes });
    // Pre-fetch at session open — "preserved from removals" benefit is free
    // because we snapshot before any tags are deleted.
    // Full mode: table was just wiped → knownChunkIds must be empty so that every
    // chunk is treated as new and actually sent to the embedder / written to LanceDB.
    this.knownChunkIds = mode === "full" ? new Set() : getAllChunkIdsForSource(projectId, sourceId);
  }

  applyFile(path: string, outcome: FileOutcome): void {
    const normPath = normalizePath(path);
    const db = getDB();

    if (outcome.kind === "removed") {
      db.prepare(
        "DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
      ).run(this._projectId, this._sourceId, this._branch, normPath);
      delete this._hashes[path];
      saveBranchHashesAtomic(this._projectId, this._sourceId, this._branch, this._hashes);

    } else if (outcome.kind === "stale-tags-only") {
      db.prepare(
        "DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
      ).run(this._projectId, this._sourceId, this._branch, normPath);
      // Hash is not updated here — it will be overwritten by a subsequent "embedded" outcome.

    } else { // "embedded"
      const { hash, tags } = outcome;

      if (tags.length > 0) {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO branch_tags
             (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        db.exec("BEGIN");
        try {
          for (const t of tags) {
            stmt.run(
              this._projectId, this._sourceId, this._branch,
              normPath, t.chunkId, t.startLine, t.endLine
            );
            this.knownChunkIds.add(t.chunkId);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }

      this._hashes[path] = hash;
      saveBranchHashesAtomic(this._projectId, this._sourceId, this._branch, this._hashes);
    }
  }

  wipeBranch(): void {
    getDB().prepare(
      "DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?"
    ).run(this._projectId, this._sourceId, this._branch);
    this._hashes = {};
    saveBranchHashesAtomic(this._projectId, this._sourceId, this._branch, this._hashes);
  }

  snapshotChunkIdsForFile(path: string): string[] {
    const rows = getDB().prepare(
      "SELECT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?"
    ).all(
      this._projectId, this._sourceId, this._branch, normalizePath(path)
    ) as { chunk_id: string }[];
    return rows.map((r) => r.chunk_id);
  }
}

export async function withBranchSession<T>(
  input: OpenSessionInput,
  fn: (session: BranchSession, branch: string) => Promise<T>
): Promise<T> {
  const { projectId, sourceId, mode } = input;

  const branch = input.branch !== undefined
    ? input.branch
    : input.rootPath
      ? resolveBranchForPath(input.rootPath)
      : resolveBranch(projectId, sourceId);

  const session = new BranchSessionImpl(projectId, sourceId, branch, mode);
  return fn(session, branch);
}
