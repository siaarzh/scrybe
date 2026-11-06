//! How long the server stays up. Mirrors `src/daemon/lifecycle.ts`, with the clock passed in so the
//! rules can be tested without waiting. Unless told to stay on, it leaves when no client ever came, or
//! a grace period after the last one went, and never while a reindex is running.
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Leave {
    NoClientEver,
    Grace,
}

impl Leave {
    pub fn as_str(self) -> &'static str {
        match self {
            Leave::NoClientEver => "no-client-ever",
            Leave::Grace => "grace",
        }
    }
}

pub struct Lifecycle {
    keep_alive: bool,
    stale: Duration,
    grace: Duration,
    no_client: Duration,
    clients: HashMap<String, Instant>,
    had_client: bool,
    no_client_deadline: Option<Instant>,
    grace_started: Option<Instant>,
}

fn env_ms(name: &str, default: u64) -> Duration {
    Duration::from_millis(std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default))
}

impl Lifecycle {
    pub fn from_env(now: Instant) -> Self {
        Self::new(
            std::env::var("SCRYBE_DAEMON_KEEP_ALIVE").as_deref() == Ok("1"),
            env_ms("SCRYBE_DAEMON_HEARTBEAT_STALE_MS", 60_000),
            env_ms("SCRYBE_DAEMON_IDLE_GRACE_MS", 600_000),
            env_ms("SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS", 900_000),
            now,
        )
    }

    pub fn new(keep_alive: bool, stale: Duration, grace: Duration, no_client: Duration, now: Instant) -> Self {
        Lifecycle { keep_alive, stale, grace, no_client, clients: HashMap::new(), had_client: false, no_client_deadline: (!keep_alive).then_some(now + no_client), grace_started: None }
    }

    pub fn always_on(&self) -> bool {
        self.keep_alive
    }

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn heartbeat(&mut self, client: &str, now: Instant) {
        self.clients.insert(client.to_string(), now);
        self.had_client = true;
        self.no_client_deadline = None;
        self.grace_started = None;
    }

    pub fn unregister(&mut self, client: &str, now: Instant) {
        self.clients.remove(client);
        self.maybe_start_grace(now);
    }

    fn maybe_start_grace(&mut self, now: Instant) {
        if !self.keep_alive && self.clients.is_empty() && self.had_client && self.grace_started.is_none() {
            self.grace_started = Some(now);
        }
    }

    pub fn grace_remaining(&self, now: Instant) -> Option<Duration> {
        self.grace_started.map(|t| self.grace.saturating_sub(now.saturating_duration_since(t)))
    }

    /// Called about once a second. A running reindex puts off leaving by one more full period.
    pub fn tick(&mut self, now: Instant, active_reindex: usize) -> Option<Leave> {
        let stale = self.stale;
        self.clients.retain(|_, seen| now.saturating_duration_since(*seen) < stale);
        self.maybe_start_grace(now);
        if self.keep_alive {
            return None;
        }
        if let Some(deadline) = self.no_client_deadline {
            if now >= deadline {
                if active_reindex > 0 {
                    self.no_client_deadline = Some(now + self.no_client);
                } else if self.clients.is_empty() && !self.had_client {
                    return Some(Leave::NoClientEver);
                }
            }
        }
        if let Some(started) = self.grace_started {
            if now.saturating_duration_since(started) >= self.grace {
                if active_reindex > 0 {
                    self.grace_started = Some(now);
                } else {
                    return Some(Leave::Grace);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_secs;

    fn on_demand(now: Instant) -> Lifecycle {
        Lifecycle::new(false, S(10), S(15), S(25), now)
    }

    #[test]
    fn with_no_client_ever_it_leaves_at_the_limit_unless_reindexing() {
        let t = Instant::now();
        let mut l = on_demand(t);
        assert_eq!(l.tick(t + S(24), 0), None);
        assert_eq!(l.tick(t + S(25), 1), None, "a reindex puts it off");
        assert_eq!(l.tick(t + S(49), 0), None);
        assert_eq!(l.tick(t + S(50), 0), Some(Leave::NoClientEver));
    }

    #[test]
    fn a_heartbeat_cancels_the_no_client_limit() {
        let t = Instant::now();
        let mut l = on_demand(t);
        l.heartbeat("a", t + S(1));
        assert_eq!(l.tick(t + S(5), 0), None);
        for s in (6..60).step_by(5) {
            l.heartbeat("a", t + S(s));
            assert_eq!(l.tick(t + S(s), 0), None);
        }
    }

    #[test]
    fn the_grace_period_starts_when_the_last_client_goes() {
        let t = Instant::now();
        let mut l = on_demand(t);
        l.heartbeat("a", t);
        l.heartbeat("b", t);
        l.unregister("a", t + S(1));
        assert_eq!(l.grace_remaining(t + S(1)), None);
        l.unregister("b", t + S(2));
        assert_eq!(l.grace_remaining(t + S(2)), Some(S(15)));
        assert_eq!(l.tick(t + S(16), 0), None);
        assert_eq!(l.tick(t + S(17), 1), None, "a reindex re-arms it");
        assert_eq!(l.tick(t + S(31), 0), None);
        assert_eq!(l.tick(t + S(32), 0), Some(Leave::Grace));
    }

    #[test]
    fn a_client_that_stops_beating_goes_stale_and_a_return_cancels_grace() {
        let t = Instant::now();
        let mut l = on_demand(t);
        l.heartbeat("a", t);
        assert_eq!(l.tick(t + S(9), 0), None);
        assert_eq!(l.client_count(), 1);
        assert_eq!(l.tick(t + S(10), 0), None);
        assert_eq!(l.client_count(), 0);
        assert_eq!(l.grace_remaining(t + S(10)), Some(S(15)));
        l.heartbeat("a", t + S(12));
        assert_eq!(l.grace_remaining(t + S(12)), None);
    }

    #[test]
    fn keep_alive_never_leaves() {
        let t = Instant::now();
        let mut l = Lifecycle::new(true, S(1), S(1), S(1), t);
        assert_eq!(l.tick(t + S(1000), 0), None);
        l.heartbeat("a", t + S(1000));
        l.unregister("a", t + S(1000));
        assert_eq!(l.tick(t + S(2000), 0), None);
        assert!(l.always_on());
    }
}
