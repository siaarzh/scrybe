//! The server's own plain-text log, `logs/daemon.log`. Mirrors `daemonLog` and `log-rotate.ts`.
use crate::config::data_dir;
use crate::jobs::now_iso;
use crate::jsstr::parse_int;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: f64 = 10.0 * 1024.0 * 1024.0;
const BACKUPS: f64 = 3.0;

static FILE: Mutex<Option<File>> = Mutex::new(None);

/// `parseInt(env ?? fallback)`: a value that isn't a number is NaN, not the fallback.
fn env_number(name: &str, fallback: f64) -> f64 {
    std::env::var(name).map_or(fallback, |v| parse_int(&v).unwrap_or(f64::NAN))
}

/// `rotateIfNeeded`: `.1` is the newest copy, and the first step that fails ends it.
fn rotate(path: &Path, max_bytes: f64, backups: f64) -> std::io::Result<()> {
    if (std::fs::metadata(path)?.len() as f64) < max_bytes {
        return Ok(());
    }
    let numbered = |n: f64| PathBuf::from(format!("{}.{n}", path.display()));
    if numbered(backups).exists() {
        std::fs::remove_file(numbered(backups))?;
    }
    let mut i = backups - 1.0;
    while i >= 1.0 {
        if numbered(i).exists() {
            std::fs::rename(numbered(i), numbered(i + 1.0))?;
        }
        i -= 1.0;
    }
    std::fs::rename(path, numbered(1.0))
}

/// Opens the log at start, setting an oversized one aside first. Best effort.
pub fn open() {
    let logs = data_dir().join("logs");
    let _ = std::fs::create_dir_all(&logs);
    let path = std::env::var_os("SCRYBE_DAEMON_LOG_PATH").map_or_else(|| logs.join("daemon.log"), PathBuf::from);
    let _ = rotate(&path, env_number("SCRYBE_DAEMON_LOG_MAX_BYTES", MAX_BYTES), env_number("SCRYBE_DAEMON_LOG_BACKUPS", BACKUPS));
    *FILE.lock().unwrap_or_else(|e| e.into_inner()) = OpenOptions::new().create(true).append(true).open(path).ok();
}

fn append(line: &str) {
    if let Some(f) = FILE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
}

/// A line to standard error and the log.
pub fn line(message: &str) {
    let line = format!("{} {message}\n", now_iso());
    let _ = std::io::stderr().write_all(line.as_bytes());
    append(&line);
}

/// A line to the log alone.
pub fn quiet(message: &str) {
    append(&format!("{} {message}\n", now_iso()));
}

/// A line to standard output, which nothing may be reading.
pub fn say(message: &str) {
    let _ = std::io::stdout().write_all(format!("{message}\n").as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oversized_log_is_set_aside_and_the_oldest_copy_dropped() {
        let dir = std::env::temp_dir().join(format!("scrybe-dlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        let read = |suffix: &str| std::fs::read_to_string(format!("{}{suffix}", path.display())).ok();
        assert!(rotate(&path, 1.0, 3.0).is_err(), "no log yet");
        for text in ["one", "two", "three", "four"] {
            std::fs::write(&path, text).unwrap();
            rotate(&path, 10.0, 2.0).unwrap();
            assert_eq!(read("").as_deref(), Some(text), "small enough to keep");
            rotate(&path, 3.0, 2.0).unwrap();
            assert_eq!(read(""), None);
        }
        assert_eq!([read(".1"), read(".2"), read(".3")], [Some("four".to_string()), Some("three".to_string()), None]);
        std::fs::write(&path, "x").unwrap();
        rotate(&path, f64::NAN, f64::NAN).unwrap();
        assert_eq!((read(""), read(".1").as_deref()), (None, Some("x")), "a limit that isn't a number always rotates");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
