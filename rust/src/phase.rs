//! Per-phase memory records for an indexing job, written to `phase-log.jsonl`. Mirrors `src/daemon/phase-telemetry.ts`.
//! A phase writes its record the moment it ends, so a process killed mid-job still leaves the earlier phases on disk.
use crate::config::data_dir;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

/// `parseInt` semantics: a leading integer, anything after it ignored; negative or unparsable falls back.
fn env_int(name: &str, fallback: u64) -> u64 {
    let raw = std::env::var(name).unwrap_or_default();
    let s = raw.trim_start();
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return fallback;
    }
    let value = digits.bytes().fold(0u64, |n, d| n.saturating_mul(10).saturating_add(u64::from(d - b'0')));
    if negative && value != 0 { fallback } else { value }
}

fn cached(cell: &'static OnceLock<u64>, name: &str, fallback: u64) -> u64 {
    *cell.get_or_init(|| env_int(name, fallback))
}

/// RSS poll cadence while a phase is in flight. 0 disables the poll thread.
fn poll_ms() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    cached(&V, "SCRYBE_PHASE_RSS_POLL_MS", 250)
}

/// How long a segmented phase runs before it flushes an interim record. 0 disables segmenting.
fn segment_ms() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    cached(&V, "SCRYBE_PHASE_SEGMENT_MS", 15_000)
}

fn log_max_bytes() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    cached(&V, "SCRYBE_PHASE_LOG_MAX_BYTES", 16 * 1024 * 1024)
}

fn log_backups() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    cached(&V, "SCRYBE_PHASE_LOG_BACKUPS", 3)
}

fn enabled() -> bool {
    std::env::var("SCRYBE_PHASE_TELEMETRY").map_or(true, |v| v != "0")
}

fn log_path() -> PathBuf {
    std::env::var_os("SCRYBE_PHASE_LOG_PATH").map_or_else(|| data_dir().join("phase-log.jsonl"), PathBuf::from)
}

/// Resident set size of this process, or None where it can't be read.
#[cfg(target_os = "linux")]
pub fn rss_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: sysconf has no preconditions.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(page).ok().map(|p| pages * p)
}

#[cfg(not(target_os = "linux"))]
pub fn rss_bytes() -> Option<u64> {
    None
}

/// Same rotation as the daemon log, with this sink's own limits. Best effort.
fn rotate_if_needed(path: &Path, max_bytes: u64, backups: u64) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() < max_bytes {
        return;
    }
    let numbered = |i: u64| PathBuf::from(format!("{}.{i}", path.display()));
    let _ = std::fs::remove_file(numbered(backups));
    for i in (1..backups).rev() {
        let _ = std::fs::rename(numbered(i), numbered(i + 1));
    }
    let _ = std::fs::rename(path, numbered(1));
}

fn stamp(record: Value) -> String {
    let mut line = Map::new();
    line.insert("ts".into(), json!(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()));
    line.insert("pid".into(), json!(std::process::id()));
    if let Value::Object(fields) = record {
        line.extend(fields);
    }
    Value::Object(line).to_string()
}

fn emit_to(path: &Path, record: Value) {
    rotate_if_needed(path, log_max_bytes(), log_backups());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", stamp(record));
    }
}

fn emit(record: Value) {
    if enabled() {
        emit_to(&log_path(), record);
    }
}

/// Identity carried on every record of one indexing job, so records can be joined.
#[derive(Clone)]
pub struct Ctx {
    pub project_id: String,
    pub source_id: String,
    pub job_id: Option<String>,
    pub branch: String,
    pub mode: &'static str,
}

/// What a job was told to do: `started` before the scan, `planned` after the diff.
pub fn emit_job_intent(ctx: &Ctx, stage: &str, detail: Value) {
    let mut record = json!({
        "event": "indexer.job.intent",
        "level": "info",
        "projectId": ctx.project_id,
        "sourceId": ctx.source_id,
        "jobId": ctx.job_id,
        "branch": ctx.branch,
        "mode": ctx.mode,
        "stage": stage,
        "rssBytes": rss_bytes(),
    });
    if let (Some(r), Value::Object(d)) = (record.as_object_mut(), detail) {
        r.extend(d);
    }
    emit(record);
}

pub enum Outcome {
    Ok,
    Error,
    Cancelled,
}

impl Outcome {
    fn name(&self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Cancelled => "cancelled",
        }
    }

    pub fn of(err: &anyhow::Error) -> Self {
        if err.to_string() == crate::index::CANCELLED { Outcome::Cancelled } else { Outcome::Error }
    }
}

/// One instrumented phase. Dropping it unfinished records an error, so an early return still leaves a record.
pub struct Phase {
    ctx: Ctx,
    name: &'static str,
    seq: u64,
    ended: bool,
    start_rss: Option<u64>,
    started: Instant,
    peak: Arc<AtomicU64>,
    poller: Option<mpsc::Sender<()>>,
    work: Map<String, Value>,
    segment_work: Map<String, Value>,
}

impl Phase {
    pub fn begin(ctx: &Ctx, name: &'static str) -> Self {
        let start_rss = rss_bytes();
        let peak = Arc::new(AtomicU64::new(start_rss.unwrap_or(0)));
        let poller = spawn_poller(&peak, start_rss.is_some());
        Phase { ctx: ctx.clone(), name, seq: 0, ended: false, start_rss, started: Instant::now(), peak, poller, work: Map::new(), segment_work: Map::new() }
    }

    /// Fold a fresh RSS reading into this phase's peak.
    pub fn sample(&self) -> Option<u64> {
        let rss = rss_bytes()?;
        self.peak.fetch_max(rss, Ordering::Relaxed);
        Some(rss)
    }

    /// Merge phase-specific counters into the record emitted at the end of the phase or segment.
    pub fn set_work(&mut self, work: Value) {
        if let Value::Object(fields) = work {
            self.work.extend(fields);
        }
    }

    /// Add to the current segment's running counters, reset at each segment boundary.
    pub fn add_work(&mut self, delta: &[(&str, u64)]) {
        for (key, add) in delta {
            let have = self.segment_work.get(*key).and_then(Value::as_u64).unwrap_or(0);
            self.segment_work.insert((*key).to_string(), json!(have + add));
        }
    }

    /// Flush an interim record once the segment has run longer than the segment length. Call between batches only.
    pub fn maybe_roll(&mut self) {
        let limit = segment_ms();
        if self.ended || limit == 0 || self.started.elapsed() < Duration::from_millis(limit) {
            return;
        }
        self.flush(false, Outcome::Ok);
    }

    /// Write the final record and stop polling. Idempotent.
    pub fn end(&mut self, outcome: Outcome) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.poller = None;
        self.flush(true, outcome);
    }

    fn flush(&mut self, last: bool, outcome: Outcome) {
        let record = self.roll(last, outcome);
        emit(record);
    }

    /// Builds the record for the segment that just ended and starts the next one.
    fn roll(&mut self, last: bool, outcome: Outcome) -> Value {
        let end_rss = self.sample();
        let peak = self.start_rss.map(|_| self.peak.load(Ordering::Relaxed));
        let mut work = self.work.clone();
        work.extend(self.segment_work.clone());
        let record = json!({
            "event": "indexer.phase",
            "level": "info",
            "projectId": self.ctx.project_id,
            "sourceId": self.ctx.source_id,
            "jobId": self.ctx.job_id,
            "branch": self.ctx.branch,
            "mode": self.ctx.mode,
            "phase": self.name,
            "seq": self.seq,
            "final": last,
            "outcome": outcome.name(),
            "startRssBytes": self.start_rss,
            "peakRssBytes": peak,
            "endRssBytes": end_rss,
            "durationMs": u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "work": work,
        });
        self.seq += 1;
        // Each segment keeps its own peak, not the running maximum of the whole phase.
        self.start_rss = end_rss;
        self.started = Instant::now();
        self.peak.store(end_rss.unwrap_or(0), Ordering::Relaxed);
        self.segment_work.clear();
        record
    }
}

impl Drop for Phase {
    fn drop(&mut self) {
        self.end(Outcome::Error);
    }
}

fn spawn_poller(peak: &Arc<AtomicU64>, readable: bool) -> Option<mpsc::Sender<()>> {
    let every = poll_ms();
    if every == 0 || !readable {
        return None;
    }
    let (stop, stopped) = mpsc::channel::<()>();
    let peak = peak.clone();
    std::thread::Builder::new()
        .name("phase-rss".into())
        .spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(Duration::from_millis(every)) {
                if let Some(rss) = rss_bytes() {
                    peak.fetch_max(rss, Ordering::Relaxed);
                }
            }
        })
        .ok()?;
    Some(stop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scrybe-phase-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn env_int_reads_a_leading_integer_like_parse_int() {
        std::env::set_var("PHASE_TEST_A", "12abc");
        std::env::set_var("PHASE_TEST_B", "-5");
        std::env::set_var("PHASE_TEST_C", "x");
        std::env::set_var("PHASE_TEST_D", "0");
        assert_eq!(env_int("PHASE_TEST_A", 7), 12);
        assert_eq!(env_int("PHASE_TEST_B", 7), 7);
        assert_eq!(env_int("PHASE_TEST_C", 7), 7);
        assert_eq!(env_int("PHASE_TEST_D", 7), 0);
        assert_eq!(env_int("PHASE_TEST_UNSET", 7), 7);
    }

    #[test]
    fn rotation_shifts_numbered_copies_and_drops_the_oldest() {
        let dir = scratch("rotate");
        let log = dir.join("phase-log.jsonl");
        std::fs::write(&log, "current").unwrap();
        std::fs::write(dir.join("phase-log.jsonl.1"), "one").unwrap();
        std::fs::write(dir.join("phase-log.jsonl.2"), "two").unwrap();
        rotate_if_needed(&log, 3, 2);
        assert!(!log.exists());
        assert_eq!(std::fs::read_to_string(dir.join("phase-log.jsonl.1")).unwrap(), "current");
        assert_eq!(std::fs::read_to_string(dir.join("phase-log.jsonl.2")).unwrap(), "one");
        std::fs::write(&log, "small").unwrap();
        rotate_if_needed(&log, 100, 2);
        assert!(log.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_line_carries_ts_and_pid_before_the_record() {
        let dir = scratch("line");
        let log = dir.join("phase-log.jsonl");
        emit_to(&log, json!({ "event": "indexer.phase", "work": {} }));
        let line: Value = serde_json::from_str(std::fs::read_to_string(&log).unwrap().trim()).unwrap();
        assert_eq!(line["event"], "indexer.phase");
        assert_eq!(line["pid"], std::process::id());
        assert!(line["ts"].as_str().unwrap().ends_with('Z'));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rss_is_readable_on_linux() {
        assert!(rss_bytes().unwrap() > 1_000_000);
    }

    #[test]
    fn segment_work_resets_and_static_work_stays() {
        let ctx = Ctx { project_id: "p".into(), source_id: "s".into(), job_id: None, branch: "b".into(), mode: "full" };
        let mut phase = Phase::begin(&ctx, "chunk_embed");
        phase.ended = true;
        phase.set_work(json!({ "batch_size": 100 }));
        phase.add_work(&[("batches", 1), ("chunks_prepared", 5)]);
        phase.add_work(&[("batches", 1)]);
        assert_eq!(phase.segment_work["batches"], 2);
        let record = phase.roll(false, Outcome::Ok);
        assert_eq!(record["work"]["batches"], 2);
        assert_eq!(record["work"]["batch_size"], 100);
        assert_eq!(record["final"], false);
        assert!(phase.segment_work.is_empty());
        assert_eq!(phase.work["batch_size"], 100);
        assert_eq!(phase.seq, 1);
    }
}
