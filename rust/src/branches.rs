//! Read-only view of `branch-tags.db`. Mirrors the read side of `src/branch-state.ts`.
use crate::collate::locale_compare;
use crate::chunk::Chunk;
use crate::config::data_dir;
use crate::registry::Source;
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

fn db() -> Result<&'static Mutex<Connection>> {
    if let Some(c) = DB.get() {
        return Ok(c);
    }
    let path = data_dir().join("branch-tags.db");
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(DB.get_or_init(|| Mutex::new(conn)))
}

pub fn resolve_branch_for_path(repo: &Path) -> String {
    let git = repo.join(".git");
    let Ok(meta) = std::fs::symlink_metadata(&git) else { return "*".into() };
    let head_path = if meta.is_dir() {
        git.join("HEAD")
    } else if meta.is_file() {
        let Ok(ptr) = std::fs::read_to_string(&git) else { return "*".into() };
        let Some(dir) = ptr.trim().strip_prefix("gitdir:") else { return "*".into() };
        repo.join(dir.trim()).join("HEAD")
    } else {
        return "*".into();
    };
    let Ok(head) = std::fs::read_to_string(head_path) else { return "*".into() };
    let head = head.trim();
    match head.strip_prefix("ref: ") {
        Some(r) => r.strip_prefix("refs/heads/").unwrap_or(r).to_string(),
        None => head.chars().take(12).collect(),
    }
}

pub fn resolve_branch(source: &Source) -> String {
    match (source.kind(), source.root_path()) {
        ("code", Some(root)) => resolve_branch_for_path(Path::new(root)),
        _ => "*".into(),
    }
}

pub fn chunk_ids_for_branch(project: &str, source: &str, branch: &str) -> Result<Vec<String>> {
    let conn = db()?.lock().unwrap();
    let mut stmt = conn.prepare_cached("SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?")?;
    let rows = stmt.query_map([project, source, branch], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Returns the branch form stored in `branch_tags` plus its chunk ids, or None.
pub fn resolve_for_search(project: &str, source: &str, supplied: &str) -> Result<Option<(String, Vec<String>)>> {
    let ids = chunk_ids_for_branch(project, source, supplied)?;
    if !ids.is_empty() {
        return Ok(Some((supplied.to_string(), ids)));
    }
    let flipped = match supplied.strip_prefix("origin/") {
        Some(s) => s.to_string(),
        None => format!("origin/{supplied}"),
    };
    let ids = chunk_ids_for_branch(project, source, &flipped)?;
    Ok(if ids.is_empty() { None } else { Some((flipped, ids)) })
}

pub fn branches_for_chunks(project: &str, source: &str, chunk_ids: &[String]) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if chunk_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; chunk_ids.len()].join(", ");
    let sql = format!("SELECT chunk_id, branch FROM branch_tags WHERE project_id=? AND source_id=? AND chunk_id IN ({placeholders})");
    let conn = db()?.lock().unwrap();
    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<&str> = vec![project, source];
    params.extend(chunk_ids.iter().map(String::as_str));
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (cid, branch) = row?;
        map.entry(cid).or_default().push(branch);
    }
    for branches in map.values_mut() {
        branches.sort_by(|a, b| {
            let pa = !(a == "master" || a == "main");
            let pb = !(b == "master" || b == "main");
            pa.cmp(&pb).then_with(|| locale_compare(a, b))
        });
    }
    Ok(map)
}

const SCHEMA: &str = "
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
    CREATE INDEX IF NOT EXISTS idx_branch_tags_chunk ON branch_tags(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_branch_tags_lookup ON branch_tags(project_id, source_id, branch);
    CREATE INDEX IF NOT EXISTS idx_branch_tags_file ON branch_tags(project_id, source_id, branch, file_path);
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON jobs(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_queued_at ON jobs(queued_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_type_project ON jobs(type, project_id);
    CREATE TABLE IF NOT EXISTS branch_state (
      project_id        TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      branch            TEXT NOT NULL,
      last_indexed_sha  TEXT NOT NULL,
      last_indexed_at   INTEGER,
      PRIMARY KEY (project_id, source_id, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_state_lookup ON branch_state(project_id, source_id);
    INSERT OR IGNORE INTO schema_meta(key,value) VALUES('version','1');
";

/// Read-write side, used only by the indexer. Same schema and statements as `src/branch-state.ts`.
pub struct Writer {
    conn: Connection,
    project: String,
    source: String,
    branch: String,
}

impl Writer {
    pub fn open(project: &str, source: &str, branch: &str) -> Result<Self> {
        let conn = Connection::open(data_dir().join("branch-tags.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Writer { conn, project: project.into(), source: source.into(), branch: branch.into() })
    }

    pub fn wipe_branch(&mut self) -> Result<()> {
        let params = [&self.project, &self.source, &self.branch];
        self.conn.execute("DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?", params)?;
        self.conn.execute("DELETE FROM branch_state WHERE project_id=? AND source_id=? AND branch=?", params)?;
        Ok(())
    }

    pub fn remove_file(&mut self, path: &str) -> Result<()> {
        self.conn.execute("DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=?", [&self.project, &self.source, &self.branch, &path.to_string()])?;
        Ok(())
    }

    pub fn add_tags(&mut self, path: &str, chunks: &[Chunk]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("INSERT OR IGNORE INTO branch_tags (project_id, source_id, branch, file_path, chunk_id, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)")?;
            for c in chunks {
                stmt.execute(rusqlite::params![self.project, self.source, self.branch, path, c.chunk_id, c.start_line, c.end_line])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_last_indexed_sha(&mut self, sha: &str) -> Result<()> {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as i64;
        self.conn.execute(
            "INSERT INTO branch_state (project_id, source_id, branch, last_indexed_sha, last_indexed_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project_id, source_id, branch) DO UPDATE SET last_indexed_sha=excluded.last_indexed_sha, last_indexed_at=excluded.last_indexed_at",
            rusqlite::params![self.project, self.source, self.branch, sha, at],
        )?;
        Ok(())
    }
}

pub fn all_chunk_ids_for_source(writer: &Writer, project: &str, source: &str) -> Result<std::collections::HashSet<String>> {
    let mut stmt = writer.conn.prepare("SELECT DISTINCT chunk_id FROM branch_tags WHERE project_id=? AND source_id=?")?;
    let rows = stmt.query_map([project, source], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}
