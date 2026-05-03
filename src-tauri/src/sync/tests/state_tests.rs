//! TDD coverage for #416 sync-state metadata + history blob store.
//! Test names are spec-prescribed — do not rename.

use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;

use crate::sync::clock::TestClock;
use crate::sync::history::HistoryConfig;
use crate::sync::state::{SyncState, SCHEMA_VERSION};
use crate::sync::tombstone::TOMBSTONE_TTL_SECS;
use crate::sync::{ApplyOutcome, ContentHash, VersionVector};

const PEER_SELF: &str = "selfpeer-aaaaaaaaaaaaaaaa";
const PEER_OTHER: &str = "otherpeer-bbbbbbbbbbbbbbbb";
const VAULT: &str = "vault-uuid-0000";

fn h(byte: u8) -> ContentHash {
    let mut out = [0u8; 32];
    out[0] = byte;
    out
}

fn open_state(dir: &TempDir, clock: Arc<TestClock>) -> SyncState {
    SyncState::open_with(
        dir.path(),
        PEER_SELF.to_string(),
        clock,
        HistoryConfig::default(),
    )
    .expect("open sync state")
}

#[test]
fn schema_creates_with_user_version_1() {
    let tmp = TempDir::new().unwrap();
    let clock = Arc::new(TestClock::new(1_700_000_000));
    let state = open_state(&tmp, clock);

    assert_eq!(state.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 1);

    // Sanity: every spec'd table exists.
    let conn = state.lock_conn().unwrap();
    for table in [
        "sync_files",
        "sync_peers",
        "sync_vault_grants",
        "sync_history",
        "sync_tombstones",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "table {table} must exist");
    }

    for index in ["idx_tombstones_expires", "idx_history_retained"] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                rusqlite::params![index],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "index {index} must exist");
    }

    // Re-opening must be idempotent and preserve user_version.
    drop(conn);
    drop(state);
    let clock2 = Arc::new(TestClock::new(1_700_000_100));
    let state2 = open_state(&tmp, clock2);
    assert_eq!(state2.schema_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn record_local_write_increments_self_counter() {
    let tmp = TempDir::new().unwrap();
    let clock = Arc::new(TestClock::new(1_700_000_000));
    let state = open_state(&tmp, clock);

    let vv1 = state
        .record_local_write(VAULT, "notes/a.md", h(0xAA), b"hello v1")
        .unwrap();
    assert_eq!(vv1.0.get(PEER_SELF).copied(), Some(1));

    let vv2 = state
        .record_local_write(VAULT, "notes/a.md", h(0xAB), b"hello v2")
        .unwrap();
    assert_eq!(vv2.0.get(PEER_SELF).copied(), Some(2));

    // Persisted state matches the latest write.
    let row = state.get_file(VAULT, "notes/a.md").unwrap().unwrap();
    assert_eq!(row.content_hash, h(0xAB));
    assert_eq!(row.version_vector.0.get(PEER_SELF).copied(), Some(2));

    // Other peers must remain untouched.
    assert!(!row.version_vector.0.contains_key(PEER_OTHER));
}

#[test]
fn apply_remote_write_dominates_when_vv_strictly_greater() {
    let tmp = TempDir::new().unwrap();
    let clock = Arc::new(TestClock::new(1_700_000_000));
    let state = open_state(&tmp, clock);

    // Bring up local file at vv {self: 1}.
    let local_vv = state
        .record_local_write(VAULT, "notes/a.md", h(0x01), b"local v1")
        .unwrap();
    assert_eq!(local_vv.0.get(PEER_SELF).copied(), Some(1));

    // Remote arrives with strictly-greater vv {self: 1, other: 2} — fast-forward.
    let mut remote_vv = local_vv.clone();
    remote_vv.0.insert(PEER_OTHER.to_string(), 2);
    let outcome = state
        .apply_remote_write(VAULT, "notes/a.md", h(0x02), remote_vv.clone(), b"remote v2")
        .unwrap();
    assert_eq!(outcome, ApplyOutcome::FastForward);

    let row = state.get_file(VAULT, "notes/a.md").unwrap().unwrap();
    assert_eq!(row.content_hash, h(0x02));
    assert_eq!(row.version_vector, remote_vv);

    // Stale remote that's strictly dominated by current → discard, no-op.
    let stale = VersionVector(
        [(PEER_SELF.to_string(), 1u64)].into_iter().collect(),
    );
    let outcome2 = state
        .apply_remote_write(VAULT, "notes/a.md", h(0x99), stale, b"stale")
        .unwrap();
    assert_eq!(outcome2, ApplyOutcome::Discard);
    let row2 = state.get_file(VAULT, "notes/a.md").unwrap().unwrap();
    assert_eq!(row2.content_hash, h(0x02));
}

#[test]
fn apply_remote_write_concurrent_returns_conflict() {
    let tmp = TempDir::new().unwrap();
    let clock = Arc::new(TestClock::new(1_700_000_000));
    let state = open_state(&tmp, clock);

    // Local: {self: 1}
    state
        .record_local_write(VAULT, "notes/a.md", h(0x01), b"local")
        .unwrap();
    // Remote: {other: 1} — neither dominates → concurrent.
    let remote_vv = VersionVector(
        [(PEER_OTHER.to_string(), 1u64)].into_iter().collect(),
    );

    let outcome = state
        .apply_remote_write(VAULT, "notes/a.md", h(0x02), remote_vv.clone(), b"remote")
        .unwrap();
    assert_eq!(outcome, ApplyOutcome::Conflict);

    // Conflict must NOT mutate sync_files (caller decides what to do).
    let row = state.get_file(VAULT, "notes/a.md").unwrap().unwrap();
    assert_eq!(row.content_hash, h(0x01));
    assert_eq!(row.version_vector.0.get(PEER_SELF).copied(), Some(1));
    assert!(!row.version_vector.0.contains_key(PEER_OTHER));

    // But the remote version must be retained in history so the
    // 3-way merge call site can fetch the bytes by hash.
    let bytes = state
        .get_history(VAULT, "notes/a.md", &h(0x02))
        .unwrap()
        .expect("conflict path stashes the remote blob");
    assert_eq!(bytes, b"remote");
}

#[test]
fn history_keeps_last_2_versions_lru() {
    let tmp = TempDir::new().unwrap();
    let clock = Arc::new(TestClock::new(1_700_000_000));
    let state = open_state(&tmp, clock.clone());

    // Three successive local writes — history must keep only the last 2.
    state
        .record_local_write(VAULT, "n.md", h(0x01), b"v1")
        .unwrap();
    clock.advance(Duration::from_secs(1));
    state
        .record_local_write(VAULT, "n.md", h(0x02), b"v2")
        .unwrap();
    clock.advance(Duration::from_secs(1));
    state
        .record_local_write(VAULT, "n.md", h(0x03), b"v3")
        .unwrap();

    // Oldest version evicted from the index.
    assert!(
        state.get_history(VAULT, "n.md", &h(0x01)).unwrap().is_none(),
        "v1 must be LRU-evicted"
    );
    // Two most-recent versions retained.
    assert_eq!(
        state.get_history(VAULT, "n.md", &h(0x02)).unwrap(),
        Some(b"v2".to_vec())
    );
    assert_eq!(
        state.get_history(VAULT, "n.md", &h(0x03)).unwrap(),
        Some(b"v3".to_vec())
    );

    // Per-file scoping: a different path keeps its own 2-version window.
    state
        .record_local_write(VAULT, "other.md", h(0xAA), b"o1")
        .unwrap();
    assert_eq!(
        state.get_history(VAULT, "other.md", &h(0xAA)).unwrap(),
        Some(b"o1".to_vec())
    );
    // ...without disturbing n.md's window.
    assert_eq!(
        state.get_history(VAULT, "n.md", &h(0x03)).unwrap(),
        Some(b"v3".to_vec())
    );
}

#[test]
fn tombstones_expire_after_30_days() {
    let tmp = TempDir::new().unwrap();
    let t0: i64 = 1_700_000_000;
    let clock = Arc::new(TestClock::new(t0));
    let state = open_state(&tmp, clock.clone());

    let vv = VersionVector(
        [(PEER_SELF.to_string(), 1u64)].into_iter().collect(),
    );
    state
        .tombstones()
        .record_delete(VAULT, "deleted.md", &vv)
        .unwrap();

    assert!(state.tombstones().is_tombstoned(VAULT, "deleted.md").unwrap());
    assert_eq!(state.tombstones().count().unwrap(), 1);

    // Just before TTL → still live.
    clock.set(t0 + TOMBSTONE_TTL_SECS - 1);
    assert!(state.tombstones().is_tombstoned(VAULT, "deleted.md").unwrap());
    let removed = state.tombstones().gc().unwrap();
    assert_eq!(removed, 0);
    assert_eq!(state.tombstones().count().unwrap(), 1);

    // At-or-past TTL → expired and GC'able.
    clock.set(t0 + TOMBSTONE_TTL_SECS);
    assert!(!state.tombstones().is_tombstoned(VAULT, "deleted.md").unwrap());
    let removed = state.tombstones().gc().unwrap();
    assert_eq!(removed, 1);
    assert_eq!(state.tombstones().count().unwrap(), 0);

    // Sanity: TTL constant matches "30 days" per the locked decision.
    assert_eq!(TOMBSTONE_TTL_SECS, 30 * 24 * 60 * 60);
}
