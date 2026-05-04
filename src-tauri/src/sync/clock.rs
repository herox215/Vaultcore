//! Injectable wall clock for time-dependent code paths (PIN expiry,
//! tombstone TTL, history retention timestamps). Production uses
//! `SystemClock`; tests use `TestClock` and call `advance` instead of
//! `std::thread::sleep`.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Wall time in seconds since UNIX epoch. Seconds (not millis) match
    /// the SQLite `INTEGER` columns in epic #73's schema (`paired_at`,
    /// `last_seen`, `expires_at`, `retained_at`, `last_synced_wall_time`).
    fn now_secs(&self) -> i64;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
}

/// Test-only clock with manual advance. Internally locked so a `&Clock`
/// reference shared across threads still observes a monotonic value
/// after `advance`.
#[derive(Debug)]
pub struct TestClock {
    secs: Mutex<i64>,
}

impl TestClock {
    pub fn new(initial_secs: i64) -> Self {
        Self {
            secs: Mutex::new(initial_secs),
        }
    }

    pub fn advance(&self, by: Duration) {
        let mut g = self.secs.lock().expect("test clock mutex");
        *g += by.as_secs() as i64;
    }

    pub fn set(&self, secs: i64) {
        *self.secs.lock().expect("test clock mutex") = secs;
    }
}

impl Clock for TestClock {
    fn now_secs(&self) -> i64 {
        *self.secs.lock().expect("test clock mutex")
    }
}
