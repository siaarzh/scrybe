//! Locks that keep two servers off one data dir. Mirrors `src/daemon/data-dir-lock.ts`: a lock is an open write
//! transaction in a small SQLite file, so it ends with the process and is never stale.
use crate::config::data_dir;
use crate::jobs::now_ms;
use rusqlite::{Connection, ErrorCode};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const OWNER: &str = "daemon-owner.lock.db";
pub const SPAWN: &str = "daemon-spawn.lock.db";

pub struct Held {
    conn: Option<Connection>,
    path: PathBuf,
    /// When the lock was taken: rows older than this belong to an earlier server.
    pub at_ms: i64,
}

pub enum Lock {
    Acquired(Held),
    /// Someone alive holds it; the pid is what they advertised, for logs only.
    Contended(Option<i64>),
    /// This data dir can't hold a lock at all, so the caller goes on unprotected.
    Unavailable(String),
}

fn sidecar(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".owner");
    PathBuf::from(name)
}

fn begin(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::ZERO)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    Ok(conn)
}

fn code(e: &rusqlite::Error) -> Option<ErrorCode> {
    match e {
        rusqlite::Error::SqliteFailure(f, _) => Some(f.code),
        _ => None,
    }
}

fn acquire_at(path: PathBuf) -> Lock {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut attempt = begin(&path);
    // A lock file holds no data, so one that isn't a database is thrown away.
    if attempt.as_ref().is_err_and(|e| matches!(code(e), Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt))) {
        let _ = std::fs::remove_file(&path);
        attempt = begin(&path);
    }
    match attempt {
        Ok(conn) => {
            let at_ms = now_ms();
            let _ = std::fs::write(sidecar(&path), json!({ "pid": std::process::id() }).to_string());
            Lock::Acquired(Held { conn: Some(conn), path, at_ms })
        }
        Err(e) if code(&e) == Some(ErrorCode::DatabaseBusy) => {
            let holder = std::fs::read_to_string(sidecar(&path)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["pid"].as_i64()).filter(|p| *p > 0);
            Lock::Contended(holder)
        }
        Err(e) => Lock::Unavailable(e.to_string()),
    }
}

pub fn acquire(name: &str) -> Lock {
    acquire_at(data_dir().join(name))
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        let _ = std::fs::remove_file(sidecar(&self.path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scrybe-locks-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_held_lock_is_contended_and_names_its_holder_until_released() {
        let dir = scratch("held");
        let path = dir.join(OWNER);
        let Lock::Acquired(held) = acquire_at(path.clone()) else { panic!("a fresh data dir must be lockable") };
        assert!(held.at_ms > 0);
        assert!(matches!(acquire_at(path.clone()), Lock::Contended(Some(pid)) if pid == i64::from(std::process::id())));
        assert!(matches!(acquire_at(dir.join(SPAWN)), Lock::Acquired(_)), "the two locks are separate");
        drop(held);
        assert!(!sidecar(&path).exists());
        assert!(matches!(acquire_at(path), Lock::Acquired(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lock_file_that_is_not_a_database_is_thrown_away() {
        let dir = scratch("junk");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(OWNER), "not a database, and long enough to have a header of its own.".repeat(20)).unwrap();
        assert!(matches!(acquire_at(dir.join(OWNER)), Lock::Acquired(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_data_dir_that_cannot_hold_a_lock_is_unavailable_not_contended() {
        let dir = scratch("dir");
        std::fs::create_dir_all(dir.join(OWNER)).unwrap();
        assert!(matches!(acquire_at(dir.join(OWNER)), Lock::Unavailable(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
