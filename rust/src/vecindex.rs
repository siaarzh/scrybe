//! Vector index upkeep. Mirrors `src/daemon/vector-index-backfill.ts`: a project that has been quiet for a while
//! has its tables checked for a missing index, one table at a time, and tables that have grown since their last
//! build are rebuilt the same way.
use crate::jobs::{now_iso, Queue};
use crate::registry;
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// The master gate is the same switch that lets queries use the index.
fn enabled() -> bool {
    std::env::var("SCRYBE_VECTOR_INDEX").map_or(true, |v| v != "false")
}

fn pos_env(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0).unwrap_or(default)
}

fn idle_ms() -> f64 {
    pos_env("SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS", 300_000.0)
}

fn rebuild_rows() -> usize {
    pos_env("SCRYBE_VECTOR_INDEX_REBUILD_ROWS", 1000.0) as usize
}

#[derive(Default)]
struct Cadence {
    rows_since_build: HashMap<String, usize>,
    pending_force: HashSet<String>,
}

// Process-local and not persisted: a restart only delays the next rebuild.
static CADENCE: LazyLock<Mutex<Cadence>> = LazyLock::new(|| Mutex::new(Cadence::default()));

fn cadence() -> std::sync::MutexGuard<'static, Cadence> {
    CADENCE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Flags a table for a forced rebuild the next time it is swept.
pub fn mark_table_for_rebuild(table: &str) {
    if enabled() {
        cadence().pending_force.insert(table.to_string());
    }
}

/// `recordUpsertForRebuildCadence`: net row growth since the last build, against max(floor, 20% of the table).
pub fn record_upsert(table: &str, rows_added: usize, rows_after: usize) {
    if !enabled() || rows_added == 0 {
        return;
    }
    let mut c = cadence();
    let accumulated = c.rows_since_build.get(table).copied().unwrap_or(0) + rows_added;
    let threshold = rebuild_rows().max(rows_after / 5);
    if accumulated >= threshold {
        c.rows_since_build.insert(table.to_string(), 0);
        drop(c);
        mark_table_for_rebuild(table);
    } else {
        c.rows_since_build.insert(table.to_string(), accumulated);
    }
}

/// `markFullReindexForRebuild`.
pub fn mark_full_reindex(table: &str) {
    cadence().rows_since_build.insert(table.to_string(), 0);
    mark_table_for_rebuild(table);
}

#[derive(Default)]
struct Fifo {
    queue: VecDeque<String>,
    queued: HashSet<String>,
    processing: bool,
}

pub struct Backfill {
    queue: Arc<Queue>,
    idle: Duration,
    deadlines: Mutex<HashMap<String, Instant>>,
    wake: Condvar,
    fifo: Mutex<Fifo>,
}

impl Backfill {
    pub fn new(queue: Arc<Queue>) -> Arc<Self> {
        let idle = Duration::from_secs_f64(idle_ms().min(3.0e11) / 1000.0);
        Arc::new(Backfill { queue, idle, deadlines: Mutex::new(HashMap::new()), wake: Condvar::new(), fifo: Mutex::new(Fifo::default()) })
    }

    fn reset(&self, project: &str) {
        self.deadlines.lock().unwrap().insert(project.to_string(), Instant::now() + self.idle);
        self.wake.notify_all();
    }

    /// Stops a removed project's timer.
    pub fn cancel(&self, project: &str) {
        self.deadlines.lock().unwrap().remove(project);
    }

    /// Resets a project's timer on every queue event, arms one per project, and starts the timer thread.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        self.queue.add_hook(Arc::new(move |_, item| {
            if enabled() {
                me.reset(&item.project);
            }
        }));
        if enabled() {
            for p in registry::list_projects() {
                self.reset(&p.id);
            }
        }
        let me = self.clone();
        let _ = std::thread::Builder::new().name("vector-index".into()).stack_size(512 << 10).spawn(move || me.run());
    }

    fn run(self: Arc<Self>) {
        let mut deadlines = self.deadlines.lock().unwrap();
        loop {
            let now = Instant::now();
            let due: Vec<String> = deadlines.iter().filter(|(_, at)| **at <= now).map(|(p, _)| p.clone()).collect();
            for p in &due {
                deadlines.remove(p);
            }
            if !due.is_empty() {
                drop(deadlines);
                for project in due {
                    self.sweep(&project);
                }
                deadlines = self.deadlines.lock().unwrap();
                continue;
            }
            let wait = deadlines.values().min().map_or(Duration::from_secs(3600), |at| at.saturating_duration_since(now));
            deadlines = self.wake.wait_timeout(deadlines, wait).unwrap().0;
        }
    }

    /// `runIdleSweep`: every table the project's sources use, code and knowledge alike.
    fn sweep(self: &Arc<Self>, project: &str) {
        if !enabled() {
            return;
        }
        let Some(p) = registry::get_project(project) else { return };
        let mut added = false;
        {
            let mut f = self.fifo.lock().unwrap();
            for table in p.sources.iter().filter_map(|s| s.table_name.clone()) {
                if f.queued.insert(table.clone()) {
                    f.queue.push_back(table);
                }
            }
            if !f.queue.is_empty() && !f.processing {
                f.processing = true;
                added = true;
            }
        }
        if added {
            let me = self.clone();
            self.queue.spawn(async move { me.process().await });
        }
    }

    /// Drains the queue one table at a time. A table stays in `queued` until its build settles.
    async fn process(self: Arc<Self>) {
        loop {
            let table = {
                let mut f = self.fifo.lock().unwrap();
                match f.queue.pop_front() {
                    Some(t) => t,
                    None => {
                        f.processing = false;
                        return;
                    }
                }
            };
            let started = Instant::now();
            let forced = cadence().pending_force.remove(&table);
            let event = match self.queue.store().create_vector_index(&table, forced).await {
                Ok(()) => json!({ "ts": now_iso(), "level": "info", "event": "vector-index.completed", "detail": { "tableName": table, "durationMs": started.elapsed().as_millis() as u64, "forced": forced } }),
                Err(e) => json!({ "ts": now_iso(), "level": "warn", "event": "vector-index.failed", "detail": { "tableName": table, "error": format!("{e:#}") } }),
            };
            self.queue.push(event);
            self.fifo.lock().unwrap().queued.remove(&table);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Called from the one test below: both read process-wide env vars.
    fn growth_crosses_the_larger_of_the_floor_and_a_fifth() {
        std::env::remove_var("SCRYBE_VECTOR_INDEX");
        std::env::set_var("SCRYBE_VECTOR_INDEX_REBUILD_ROWS", "10");
        record_upsert("t_a", 4, 100);
        record_upsert("t_a", 15, 100);
        assert!(!cadence().pending_force.contains("t_a"));
        record_upsert("t_a", 1, 100);
        assert!(cadence().pending_force.contains("t_a"));
        assert_eq!(cadence().rows_since_build["t_a"], 0);
        record_upsert("t_b", 9, 50);
        assert!(!cadence().pending_force.contains("t_b"));
        record_upsert("t_c", 0, 50);
        assert!(!cadence().rows_since_build.contains_key("t_c"));
        std::env::remove_var("SCRYBE_VECTOR_INDEX_REBUILD_ROWS");
    }

    #[test]
    fn cadence_rules_and_the_master_gate() {
        std::env::remove_var("SCRYBE_VECTOR_INDEX");
        std::env::remove_var("SCRYBE_VECTOR_INDEX_REBUILD_ROWS");
        growth_crosses_the_larger_of_the_floor_and_a_fifth();
        mark_full_reindex("t_full");
        assert!(cadence().pending_force.contains("t_full"));
        std::env::set_var("SCRYBE_VECTOR_INDEX", "false");
        mark_table_for_rebuild("t_off");
        record_upsert("t_off", 5000, 10);
        assert!(!cadence().pending_force.contains("t_off"));
        std::env::remove_var("SCRYBE_VECTOR_INDEX");
    }
}
