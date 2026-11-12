//! Keeps ticket sources fresh. Mirrors `src/daemon/ticket-poller.ts`: a timer per source queues an
//! incremental run, and the run itself does the fetching.
use crate::index_ticket::load_cursor;
use crate::jobs::{now_iso, Queue, Request};
use crate::registry::{self, Project, Source};
use crate::watch::{env_ms, Idle};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_CONCURRENT: usize = 2;
const RETRY_BASE: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(600);
const BUSY_RETRY: Duration = Duration::from_secs(5);
const UNSET_VAR_HINT: &str = "Set the missing env var where your scrybe calls run or in <DATA_DIR>/.env, then run `scrybe daemon stop` so the next scrybe call starts a daemon that has it";

fn has_env_ref(token: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\$\{[A-Z_][A-Z0-9_]*\}").unwrap()).is_match(token)
}

/// `new URL(base).host`, or a per-source stand-in when it doesn't parse.
fn host_of(base_url: &str, source_id: &str) -> String {
    match reqwest::Url::parse(base_url) {
        Ok(u) if u.host_str().is_some() => match u.port() {
            Some(port) => format!("{}:{port}", u.host_str().unwrap_or_default()),
            None => u.host_str().unwrap_or_default().to_string(),
        },
        _ => format!("unknown:{source_id}"),
    }
}

/// A source never indexed is polled at once; the rest wait their turn so a restart doesn't hit every tracker.
fn first_delay(has_cursor: bool, hot: bool, active: Duration, idle: Duration) -> Duration {
    if !has_cursor { Duration::ZERO } else if hot { active } else { idle }
}

fn next_delay(hot: bool, active: Duration, idle: Duration) -> Duration {
    if hot { active } else { idle }
}

/// 30 s, doubling, up to 10 min. `retries` counts failures so far, at least 1.
fn failure_delay(retries: u32) -> Duration {
    RETRY_BASE.saturating_mul(2u32.saturating_pow(retries.saturating_sub(1))).min(RETRY_MAX)
}

#[derive(Debug, PartialEq)]
enum Failure {
    UnsetVar,
    Auth,
    Other,
}

fn classify(msg: &str) -> Failure {
    if msg.contains("not set") && (msg.contains("env var") || msg.contains("references env var")) {
        Failure::UnsetVar
    } else if msg.contains("expired or invalid") {
        Failure::Auth
    } else {
        Failure::Other
    }
}

#[derive(Default)]
struct TimerState {
    due: Option<Instant>,
    stopped: bool,
}

struct Poller {
    project: String,
    source: String,
    host: String,
    timer: Mutex<TimerState>,
    wake: Condvar,
}

impl Poller {
    /// Replaces any wait already set, like clearing a timeout and setting another.
    fn schedule(&self, delay: Duration) {
        self.timer.lock().unwrap().due = Some(Instant::now() + delay);
        self.wake.notify_all();
    }

    fn stop(&self) {
        self.timer.lock().unwrap().stopped = true;
        self.wake.notify_all();
    }

    /// Blocks until the timer is due. False once stopped.
    fn wait_due(&self) -> bool {
        let mut t = self.timer.lock().unwrap();
        loop {
            if t.stopped {
                return false;
            }
            match t.due {
                None => t = self.wake.wait(t).unwrap(),
                Some(due) => {
                    let now = Instant::now();
                    if due <= now {
                        t.due = None;
                        return true;
                    }
                    t = self.wake.wait_timeout(t, due - now).unwrap().0;
                }
            }
        }
    }
}

pub struct TicketPoller {
    queue: Arc<Queue>,
    idle: Arc<Idle>,
    active: Duration,
    idle_for: Duration,
    pollers: Mutex<HashMap<String, Arc<Poller>>>,
    warned_literal: Mutex<HashSet<String>>,
    polls_running: AtomicUsize,
    hosts_busy: Mutex<HashSet<String>>,
}

/// Starts a poller for every ticket source and keeps them in step with the registry.
pub fn start(queue: Arc<Queue>, idle: Arc<Idle>, projects: &[Project]) {
    if std::env::var("SCRYBE_DAEMON_NO_TICKET_FETCH").as_deref() == Ok("1") {
        return;
    }
    let me = Arc::new(TicketPoller {
        queue: queue.clone(),
        idle: idle.clone(),
        active: env_ms("SCRYBE_DAEMON_TICKET_ACTIVE_MS", 15 * 60_000),
        idle_for: env_ms("SCRYBE_DAEMON_TICKET_IDLE_MS", 60 * 60_000),
        pollers: Mutex::new(HashMap::new()),
        warned_literal: Mutex::new(HashSet::new()),
        polls_running: AtomicUsize::new(0),
        hosts_busy: Mutex::new(HashSet::new()),
    });
    let hook = me.clone();
    queue.add_hook(Arc::new(move |event, item| hook.on_job_event(event, item)));
    let hot = me.clone();
    idle.set_on_hot(Arc::new(move || hot.on_hot()));
    for project in projects {
        for source in project.sources.iter().filter(|s| s.kind() == "ticket") {
            me.register(project, source);
        }
    }
}

impl TicketPoller {
    fn emit(&self, level: &str, project: &str, detail: Value) {
        self.queue.emit(json!({ "ts": now_iso(), "level": level, "event": "watcher.event", "projectId": project, "detail": detail }));
    }

    fn register(self: &Arc<Self>, project: &Project, source: &Source) {
        let key = format!("{}:{}", project.id, source.source_id);
        let field = |k: &str| source.source_config.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let token = field("token");
        let mut pollers = self.pollers.lock().unwrap();
        if pollers.contains_key(&key) {
            return;
        }
        if !has_env_ref(&token) && !token.is_empty() && self.warned_literal.lock().unwrap().insert(key.clone()) {
            self.emit("warn", &project.id, json!({
                "phase": "ticket-poller.literal-token",
                "sourceId": source.source_id,
                "literalTokenWarn": true,
                "message": format!("Source \"{}\" uses a literal token. Store the token in an env var (e.g. SCRYBE_GITLAB_TOKEN) and reference it as ${{SCRYBE_GITLAB_TOKEN}} to avoid exposing credentials in projects.json.", source.source_id),
            }));
        }
        let poller = Arc::new(Poller {
            project: project.id.clone(),
            source: source.source_id.clone(),
            host: host_of(&field("base_url"), &source.source_id),
            timer: Mutex::new(TimerState::default()),
            wake: Condvar::new(),
        });
        pollers.insert(key.clone(), poller.clone());
        drop(pollers);
        let has_cursor = load_cursor(&project.id, &source.source_id).is_some();
        poller.schedule(first_delay(has_cursor, self.idle.is_hot(), self.active, self.idle_for));
        let me = self.clone();
        let spawned = std::thread::Builder::new().name(format!("ticket-{key}")).stack_size(512 << 10).spawn(move || me.run(poller));
        if spawned.is_err() {
            self.pollers.lock().unwrap().remove(&key);
        }
    }

    /// Registers sources added since the last look and drops those that are gone.
    fn reconcile(self: &Arc<Self>) {
        let (projects, registry_exists) = match registry::read_projects() {
            Err(_) => return,
            Ok(None) => (vec![], false),
            Ok(Some(p)) => (p, true),
        };
        let mut live = HashSet::new();
        for project in &projects {
            for source in project.sources.iter().filter(|s| s.kind() == "ticket") {
                live.insert(format!("{}:{}", project.id, source.source_id));
                self.register(project, source);
            }
        }
        if registry_exists {
            let mut pollers = self.pollers.lock().unwrap();
            pollers.retain(|key, p| {
                let keep = live.contains(key);
                if !keep {
                    p.stop();
                    self.warned_literal.lock().unwrap().remove(key);
                }
                keep
            });
        }
    }

    fn on_hot(self: &Arc<Self>) {
        self.reconcile();
        let all: Vec<Arc<Poller>> = self.pollers.lock().unwrap().values().cloned().collect();
        for p in all {
            p.schedule(Duration::ZERO);
        }
    }

    fn on_job_event(self: &Arc<Self>, event: crate::jobs::JobEvent, item: &crate::jobs::Item) {
        if event != crate::jobs::JobEvent::Submitted || item.gc_purge.is_some() {
            return;
        }
        let Some(source) = &item.source else { return };
        let is_ticket = registry::get_project(&item.project).and_then(|p| p.sources.into_iter().find(|s| s.source_id == *source)).is_some_and(|s| s.kind() == "ticket");
        if is_ticket {
            self.reconcile();
        }
    }

    fn run(self: Arc<Self>, p: Arc<Poller>) {
        let (mut retries, mut warned_auth, mut warned_unset) = (0u32, false, false);
        while p.wait_due() {
            if self.polls_running.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT {
                self.polls_running.fetch_sub(1, Ordering::SeqCst);
                p.schedule(BUSY_RETRY);
                continue;
            }
            if !self.hosts_busy.lock().unwrap().insert(p.host.clone()) {
                self.polls_running.fetch_sub(1, Ordering::SeqCst);
                p.schedule(BUSY_RETRY);
                continue;
            }
            let result = self.poll(&p);
            self.hosts_busy.lock().unwrap().remove(&p.host);
            self.polls_running.fetch_sub(1, Ordering::SeqCst);
            match result {
                Ok(()) => {
                    retries = 0;
                    warned_auth = false;
                    warned_unset = false;
                    p.schedule(next_delay(self.idle.is_hot(), self.active, self.idle_for));
                }
                Err(msg) => match classify(&msg) {
                    Failure::UnsetVar => {
                        if !warned_unset {
                            self.emit("warn", &p.project, json!({ "phase": "ticket-poller", "sourceId": p.source, "error": msg, "hint": UNSET_VAR_HINT }));
                            warned_unset = true;
                        }
                        p.schedule(self.idle_for);
                    }
                    kind => {
                        if kind == Failure::Auth && !warned_auth {
                            let hint = format!("Update the token with: scrybe update-source --project-id {} --source-id {} --gitlab-token <new-token>", p.project, p.source);
                            self.emit("warn", &p.project, json!({ "phase": "ticket-poller", "sourceId": p.source, "error": msg, "hint": hint }));
                            warned_auth = true;
                        }
                        retries += 1;
                        self.emit("warn", &p.project, json!({ "phase": "ticket-poller", "sourceId": p.source, "error": msg, "retries": retries }));
                        p.schedule(failure_delay(retries));
                    }
                },
            }
        }
    }

    /// Queues one incremental run and waits for it to leave the queue. Only a full queue is an error here.
    fn poll(&self, p: &Poller) -> Result<(), String> {
        let sub = self.queue.submit(Request { project: p.project.clone(), source: Some(p.source.clone()), ..Default::default() });
        if sub.status == "rejected" {
            let (pending, max) = self.queue.depth();
            return Err(format!("Queue at capacity ({pending}/{max})"));
        }
        while self.queue.rows.get(&sub.job_id).is_some_and(|row| row["status"] == "queued") {
            std::thread::sleep(Duration::from_millis(200));
        }
        self.emit("info", &p.project, json!({ "phase": "ticket-poller", "sourceId": p.source, "enqueued": true }));
        if std::env::var("SCRYBE_DEBUG_TICKET_POLLER").as_deref() == Ok("1") {
            self.emit("info", &p.project, json!({ "phase": "ticket-poller.tick", "sourceId": p.source, "host": p.host }));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_back_off_from_thirty_seconds_to_ten_minutes() {
        let secs: Vec<u64> = (1..=7).map(|n| failure_delay(n).as_secs()).collect();
        assert_eq!(secs, [30, 60, 120, 240, 480, 600, 600]);
        assert_eq!(failure_delay(200), RETRY_MAX);
    }

    #[test]
    fn a_never_indexed_source_is_polled_at_once_and_the_rest_wait() {
        let (active, idle) = (Duration::from_secs(900), Duration::from_secs(3600));
        assert_eq!(first_delay(false, true, active, idle), Duration::ZERO);
        assert_eq!(first_delay(false, false, active, idle), Duration::ZERO);
        assert_eq!(first_delay(true, true, active, idle), active);
        assert_eq!(first_delay(true, false, active, idle), idle);
        assert_eq!(next_delay(true, active, idle), active);
        assert_eq!(next_delay(false, active, idle), idle);
    }

    #[test]
    fn the_host_keeps_its_port_and_a_bad_url_gets_a_stand_in() {
        assert_eq!(host_of("https://gitlab.example.invalid", "a"), "gitlab.example.invalid");
        assert_eq!(host_of("http://127.0.0.1:8080/x", "a"), "127.0.0.1:8080");
        assert_eq!(host_of("https://gitlab.example.invalid:443", "a"), "gitlab.example.invalid");
        assert_eq!(host_of("", "issues"), "unknown:issues");
        assert_eq!(host_of("not a url", "issues"), "unknown:issues");
    }

    #[test]
    fn only_a_reference_counts_as_stored_in_the_environment() {
        assert!(has_env_ref("${SCRYBE_GITLAB_TOKEN}"));
        assert!(has_env_ref("Bearer ${A_1}"));
        assert!(!has_env_ref("glpat-abc"));
        assert!(!has_env_ref("${lower}"));
        assert!(!has_env_ref(""));
    }

    #[test]
    fn failures_are_told_apart_by_their_text() {
        assert_eq!(classify("env var X not set (referenced in scrybe config)"), Failure::UnsetVar);
        assert_eq!(classify("Token for GitHub source \"a/b\" references env var X which is not set."), Failure::UnsetVar);
        assert_eq!(classify("GitLab token for project \"demo\" is expired or invalid (HTTP 401). Update it"), Failure::Auth);
        assert_eq!(classify("Queue at capacity (1000/1000)"), Failure::Other);
    }

    #[test]
    fn a_stopped_timer_wakes_and_ends() {
        let p = Arc::new(Poller { project: "p".into(), source: "s".into(), host: "h".into(), timer: Mutex::new(TimerState::default()), wake: Condvar::new() });
        p.schedule(Duration::ZERO);
        assert!(p.wait_due());
        let waiting = p.clone();
        let t = std::thread::spawn(move || waiting.wait_due());
        std::thread::sleep(Duration::from_millis(50));
        p.stop();
        assert!(!t.join().unwrap());
    }

    #[test]
    fn a_later_schedule_replaces_an_earlier_one() {
        let p = Poller { project: "p".into(), source: "s".into(), host: "h".into(), timer: Mutex::new(TimerState::default()), wake: Condvar::new() };
        p.schedule(Duration::from_secs(3600));
        p.schedule(Duration::ZERO);
        assert!(p.wait_due());
    }
}
