//! Two background timers. Mirrors `src/daemon/auto-gc.ts` and `ephemeral-sweep.ts`: a project that has been
//! quiet for a while, or whose last index left many orphans, gets a gc job; leaked `_ephemeral/` labels are
//! reclaimed once at start.
use crate::index;
use crate::jobs::{now_iso, now_ms, Item, JobEvent, Queue, Request};
use crate::registry;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

fn enabled() -> bool {
    std::env::var("SCRYBE_AUTO_GC").map_or(true, |v| v != "0")
}

fn env_ms(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0).unwrap_or(default)
}

pub struct AutoGc {
    queue: Arc<Queue>,
    idle: Duration,
    deadlines: Mutex<HashMap<String, Instant>>,
    wake: Condvar,
}

impl AutoGc {
    pub fn new(queue: Arc<Queue>) -> Arc<Self> {
        let idle = Duration::from_secs_f64(env_ms("SCRYBE_AUTO_GC_IDLE_MS", 300_000.0).min(3.0e11) / 1000.0);
        Arc::new(AutoGc { queue, idle, deadlines: Mutex::new(HashMap::new()), wake: Condvar::new() })
    }

    /// Start (or restart) a project's idle timer.
    pub fn reset(&self, project: &str) {
        self.deadlines.lock().unwrap().insert(project.to_string(), Instant::now() + self.idle);
        self.wake.notify_all();
    }

    fn cancel(&self, project: &str) {
        self.deadlines.lock().unwrap().remove(project);
    }

    /// Hooks into every queue event, arms a timer for each project and starts the timer thread.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        self.queue.set_hook(Arc::new(move |event, item| {
            if enabled() {
                me.reset(&item.project);
            }
            if event == JobEvent::Completed && item.gc_purge.is_none() {
                let (me, project, source) = (me.clone(), item.project.clone(), item.source.clone());
                me.queue.clone().spawn(async move { me.evaluate_ratio(&project, source.as_deref()).await });
            }
        }));
        if enabled() {
            for p in registry::list_projects() {
                self.reset(&p.id);
            }
        }
        let me = self.clone();
        let _ = std::thread::Builder::new().name("auto-gc".into()).stack_size(512 << 10).spawn(move || me.run());
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
                    let me = self.clone();
                    self.queue.spawn(async move { me.on_idle(&project).await });
                }
                deadlines = self.deadlines.lock().unwrap();
                continue;
            }
            let wait = deadlines.values().min().map_or(Duration::from_secs(3600), |at| at.saturating_duration_since(now));
            deadlines = self.wake.wait_timeout(deadlines, wait).unwrap().0;
        }
    }

    fn event(&self, project: &str, name: &str, detail: serde_json::Value) {
        self.queue.push(json!({ "ts": now_iso(), "level": "info", "event": name, "projectId": project, "detail": detail }));
    }

    async fn on_idle(&self, project: &str) {
        if !enabled() {
            return;
        }
        if self.has_orphans(project).await {
            self.enqueue(project, "idle");
        } else {
            self.event(project, "auto-gc.skipped", json!({ "trigger": "idle", "reason": "no-orphans" }));
        }
    }

    /// Any code source whose table holds more rows than its branches tag.
    async fn has_orphans(&self, project: &str) -> bool {
        let Some(p) = registry::get_project(project) else { return false };
        for source in p.sources.iter().filter(|s| s.kind() == "code") {
            let Some(table) = &source.table_name else { continue };
            let lance = self.queue.store().count_rows(table).await.unwrap_or(0);
            if lance > self.queue.rows.tagged_chunk_ids(project, &source.source_id).len() {
                return true;
            }
        }
        false
    }

    /// After an index job: queue a gc if the orphan share is over the threshold and the last gc is old enough.
    async fn evaluate_ratio(&self, project: &str, source: Option<&str>) {
        if !enabled() {
            return;
        }
        let Some(p) = registry::get_project(project) else { return };
        let threshold = env_ms("SCRYBE_AUTO_GC_RATIO", 0.15);
        let debounce = env_ms("SCRYBE_AUTO_GC_RATIO_DEBOUNCE_MS", 1_800_000.0);
        let (mut lance, mut tagged) = (0usize, 0usize);
        for s in p.sources.iter().filter(|s| s.kind() == "code" && source.is_none_or(|want| want == s.source_id)) {
            let Some(table) = &s.table_name else { continue };
            if let Ok(ids) = self.queue.store().list_chunk_ids(table, project).await {
                lance += ids.len();
                tagged += self.queue.rows.tagged_chunk_ids(project, &s.source_id).len();
            }
        }
        if lance == 0 || (lance as f64 - tagged as f64) / lance as f64 <= threshold {
            return;
        }
        if self.queue.rows.last_gc_time(project).is_some_and(|at| ((now_ms() - at) as f64) < debounce) {
            return;
        }
        self.enqueue(project, "ratio");
    }

    fn enqueue(&self, project: &str, trigger: &str) {
        if !enabled() {
            return;
        }
        if registry::get_project(project).is_none() {
            self.cancel(project);
            self.event(project, "auto-gc.skipped", json!({ "trigger": trigger, "reason": "project_not_found" }));
            return;
        }
        self.event(project, "auto-gc.scheduled", json!({ "trigger": trigger }));
        self.queue.submit(Request { project: project.to_string(), gc_purge: Some(false), ..Default::default() });
    }
}

/// Once at start, in the background: forget every `_ephemeral/` label a crashed review left behind
/// and remove the rows only it used.
pub fn sweep_ephemeral(queue: &Arc<Queue>) {
    let q = queue.clone();
    queue.spawn(async move {
        let mut swept = vec![];
        for p in registry::list_projects() {
            for s in p.sources.iter().filter(|s| s.kind() == "code") {
                for label in q.rows.ephemeral_branches(&p.id, &s.source_id) {
                    if q.rows.delete_branch(&p.id, &s.source_id, &label).is_err() {
                        continue;
                    }
                    let _ = std::fs::remove_file(index::hashes_path(&p.id, &s.source_id, &label));
                    let item = Item { job_id: String::new(), project: p.id.clone(), source: Some(s.source_id.clone()), branch: None, content_ref: None, mode: index::Mode::Incremental, gc_purge: Some(true) };
                    if let Ok((orphans, freed)) = q.collect_garbage(&item, true).await {
                        swept.push(json!({ "projectId": p.id, "sourceId": s.source_id, "label": label, "orphansDeleted": orphans, "bytesFreed": freed }));
                    }
                }
            }
        }
        if !swept.is_empty() {
            let names: Vec<String> = swept.iter().map(|e| format!("{}/{}:{}", e["projectId"].as_str().unwrap_or(""), e["sourceId"].as_str().unwrap_or(""), e["label"].as_str().unwrap_or(""))).collect();
            eprintln!("[scrybe daemon] ephemeral sweep: reclaimed {} leaked '_ephemeral/*' label(s): {}", swept.len(), names.join(", "));
            q.push(json!({ "ts": now_iso(), "level": "info", "event": "ephemeral.swept", "detail": { "count": swept.len(), "entries": swept } }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_zero_turns_it_off() {
        std::env::remove_var("SCRYBE_AUTO_GC");
        assert!(enabled());
        std::env::set_var("SCRYBE_AUTO_GC", "false");
        assert!(enabled());
        std::env::set_var("SCRYBE_AUTO_GC", "0");
        assert!(!enabled());
        std::env::remove_var("SCRYBE_AUTO_GC");
    }

    #[test]
    fn bad_numbers_fall_back() {
        std::env::set_var("SCRYBE_TEST_MS", "-5");
        assert_eq!(env_ms("SCRYBE_TEST_MS", 7.0), 7.0);
        std::env::set_var("SCRYBE_TEST_MS", "250.5");
        assert_eq!(env_ms("SCRYBE_TEST_MS", 7.0), 250.5);
        std::env::remove_var("SCRYBE_TEST_MS");
    }
}
