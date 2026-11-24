//! What a piece of work did to the server's memory, for the `activity-span` records in the server log.
use crate::phase::rss_bytes;
use serde_json::{json, Map, Value};
use std::future::Future;
use std::time::{Duration, Instant};

pub struct Span {
    started: Instant,
    start: Option<u64>,
    peak: Option<u64>,
}

impl Span {
    pub fn start() -> Self {
        let now = rss_bytes();
        Span { started: Instant::now(), start: now, peak: now }
    }

    pub fn sample(&mut self) -> Option<u64> {
        let now = rss_bytes();
        self.peak = self.peak.max(now);
        now
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Runs `work`, sampling while it waits.
    pub async fn watch<T>(&mut self, every: Duration, work: impl Future<Output = T>) -> T {
        let mut work = std::pin::pin!(work);
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                done = &mut work => return done,
                _ = tick.tick() => { self.sample(); }
            }
        }
    }

    /// Adds the three readings to a record; null where memory can't be read.
    pub fn close(&mut self, record: &mut Map<String, Value>) {
        let end = self.sample();
        record.insert("startRssBytes".into(), json!(self.start));
        record.insert("peakRssBytes".into(), json!(self.peak));
        record.insert("endRssBytes".into(), json!(end));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_peak_is_never_below_either_end() {
        let mut span = Span::start();
        assert_eq!(span.watch(Duration::from_millis(5), async { tokio::time::sleep(Duration::from_millis(20)).await; 7 }).await, 7);
        let mut r = Map::new();
        span.close(&mut r);
        assert_eq!(r.keys().collect::<Vec<_>>(), ["startRssBytes", "peakRssBytes", "endRssBytes"]);
        assert!(r["peakRssBytes"].as_u64() >= r["startRssBytes"].as_u64() && r["peakRssBytes"].as_u64() >= r["endRssBytes"].as_u64());
    }
}
