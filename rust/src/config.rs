//! Environment and data-dir resolution. Mirrors the read-side subset of `src/config.ts`.
use crate::jsstr::{env_int, env_pos_int, js_trim};
use std::collections::HashSet;
use std::env;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub const VERSION: &str = "0.54.0-rs.1";

pub fn data_dir() -> PathBuf {
    if let Ok(d) = env::var("SCRYBE_DATA_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = PathBuf::from(env::var("HOME").or_else(|_| env::var("USERPROFILE")).unwrap_or_default());
    if cfg!(target_os = "windows") {
        let base = env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home.join("AppData/Local"));
        base.join("scrybe").join("scrybe")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/scrybe")
    } else {
        env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".local/share")).join("scrybe")
    }
}

/// `getPidfilePath`.
pub fn pidfile_path() -> PathBuf {
    env::var_os("SCRYBE_DAEMON_PIDFILE").map_or_else(|| data_dir().join("daemon.pid"), PathBuf::from)
}

/// Sent on every request to a tracker, a model host or an API: some refuse a request that names no client.
pub const USER_AGENT: &str = "node";

static DOT_ENV_KEYS: OnceLock<HashSet<String>> = OnceLock::new();
static IN_SERVER: AtomicBool = AtomicBool::new(false);

/// Keys `<data dir>/.env` defines; every server loads that file itself at start.
pub fn in_dot_env(key: &str) -> bool {
    DOT_ENV_KEYS.get().is_some_and(|k| k.contains(key))
}

/// From here on this process is the server, so errors can name the server-specific remedy.
pub fn mark_server() {
    IN_SERVER.store(true, Ordering::Relaxed);
}

pub fn in_server() -> bool {
    IN_SERVER.load(Ordering::Relaxed)
}

/// The `KEY=value` lines of a `.env` file. Quotes are part of the value.
fn env_lines(text: &str) -> Vec<(&str, &str)> {
    let lines = text.split('\n').map(js_trim).filter(|l| !l.is_empty() && !l.starts_with('#'));
    lines.filter_map(|l| l.split_once('=')).map(|(k, v)| (js_trim(k), js_trim(v))).filter(|(k, _)| !k.is_empty()).collect()
}

/// Load `<data dir>/.env`. OS env always wins. No rewriting: the read path never writes.
pub fn load_env_file() {
    let Ok(bytes) = std::fs::read(data_dir().join(".env")) else { return };
    let text = String::from_utf8_lossy(&bytes);
    let mut keys = HashSet::new();
    for (k, v) in env_lines(&text) {
        // No environment can hold a NUL.
        if k.contains('\0') || v.contains('\0') {
            continue;
        }
        keys.insert(k.to_string());
        if env::var_os(k).is_none() {
            // Safe: runs in main before any thread starts.
            unsafe { env::set_var(k, v) };
        }
    }
    let _ = DOT_ENV_KEYS.set(keys);
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub hybrid_enabled: bool,
    pub rrf_k: f64,
    pub vector_index_enabled: bool,
    pub vector_index_min_rows: usize,
    pub vector_refine_factor: u32,
    pub vector_ef: usize,
    pub skip_branch_filter: bool,
}

fn pos_int(name: &str, fallback: u64) -> u64 {
    env_pos_int(name).filter(|n| n.is_finite()).map_or(fallback, |n| n as u64)
}

impl Settings {
    pub fn from_env() -> Self {
        Settings {
            hybrid_enabled: env::var("SCRYBE_HYBRID").as_deref() != Ok("false"),
            rrf_k: env_int("SCRYBE_RRF_K").unwrap_or(60.0),
            vector_index_enabled: env::var("SCRYBE_VECTOR_INDEX").as_deref() != Ok("false"),
            vector_index_min_rows: pos_int("SCRYBE_VECTOR_INDEX_MIN_ROWS", 10000) as usize,
            vector_refine_factor: pos_int("SCRYBE_VECTOR_REFINE_FACTOR", 10) as u32,
            vector_ef: pos_int("SCRYBE_VECTOR_EF", 600) as usize,
            skip_branch_filter: env::var("SCRYBE_SKIP_MIGRATION").as_deref() == Ok("1"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_files_keep_quotes_and_skip_what_has_no_name() {
        let text = "\u{FEFF}A=1\r\n# no\n  B = \"x y\" \r\n=nameless\nC='q'\nD=\nno equals\nE=a=b#c\n\u{A0}F=2\u{A0}";
        assert_eq!(env_lines(text), [("A", "1"), ("B", "\"x y\""), ("C", "'q'"), ("D", ""), ("E", "a=b#c"), ("F", "2")]);
    }
}
