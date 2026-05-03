//! TDD coverage for #420 conflict resolution + tombstone propagation
//! + rename dispatch.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ed25519_dalek::SigningKey;
use rand_core::RngCore;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use crate::sync::capability::{Capability, CapabilityBody, Scope};
use crate::sync::clock::TestClock;
use crate::sync::conflict::{conflict_copy_path, resolve, ResolveOutcome};
use crate::sync::engine::{InboundDecision, SyncEngine};
use crate::sync::history::HistoryConfig;
use crate::sync::protocol::{ChangeEvent, ChangeKind};
use crate::sync::state::{PeerTrust, SyncState};
use crate::sync::tombstone::TOMBSTONE_TTL_SECS;
use crate::sync::{ContentHash, VersionVector};
use crate::WriteIgnoreList;

const SELF_PEER: &str = "SELFPEER";
const REMOTE_PEER: &str = "PEER";
const VAULT: &str = "vault-uuid";

fn h(content: &[u8]) -> ContentHash {
    let d = Sha256::digest(content);
    let mut o: ContentHash = [0; 32];
    o.copy_from_slice(&d);
    o
}

fn fresh_signing_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    SigningKey::from_bytes(&bytes)
}

fn build_state(tmp: &TempDir, t0: i64) -> Arc<SyncState> {
    let metadata = tmp.path().join(".vaultcore");
    std::fs::create_dir_all(&metadata).unwrap();
    Arc::new(
        SyncState::open_with(
            &metadata,
            SELF_PEER.into(),
            Arc::new(TestClock::new(t0)),
            HistoryConfig::default(),
        )
        .unwrap(),
    )
}

#[test]
fn conflict_three_way_merge_uses_history_gca() {
    let tmp = TempDir::new().unwrap();
    let state = build_state(&tmp, 1_700_000_000);
    let path = "notes/a.md";

    // Establish a base via local write — creates VV {self:1} and stores
    // base bytes in history.
    let base = "alpha\nbeta\ngamma\n";
    state
        .record_local_write(VAULT, path, h(base.as_bytes()), base.as_bytes())
        .unwrap();

    // Local edit (left): VV {self:2}.
    let left = "alpha edited locally\nbeta\ngamma\n";
    state
        .record_local_write(VAULT, path, h(left.as_bytes()), left.as_bytes())
        .unwrap();

    // Remote edit (right) concurrent w/ first local: VV {self:1, remote:1}
    // — the GCA is therefore {self:1}, which is still in history.
    let right = "alpha\nbeta\ngamma edited remotely\n";
    let remote_vv = VersionVector(
        [(SELF_PEER.into(), 1u64), (REMOTE_PEER.into(), 1u64)]
            .into_iter()
            .collect(),
    );

    let local_record = state.get_file(VAULT, path).unwrap().unwrap();
    let outcome = resolve(
        &state,
        VAULT,
        Path::new(path),
        &local_record,
        left.as_bytes(),
        right.as_bytes(),
        &remote_vv,
        "Bob",
    )
    .unwrap();

    match outcome {
        ResolveOutcome::Merged { merged_content, merged_vv } => {
            assert!(merged_content.contains("alpha edited locally"));
            assert!(merged_content.contains("gamma edited remotely"));
            // Merged VV must dominate both inputs.
            assert!(merged_vv.dominates(&local_record.version_vector));
            assert!(merged_vv.dominates(&remote_vv));
        }
        other => panic!("expected Merged, got {other:?}"),
    }
}

#[test]
fn conflict_copy_named_obsidian_compatible_when_gca_missing() {
    let tmp = TempDir::new().unwrap();
    // Pin clock to a known instant so we can assert the formatted stamp
    // exactly. 2026-05-03 14:22 UTC = 1_777_818_120.
    let t0: i64 = 1_777_818_120;
    let state = build_state(&tmp, t0);
    let path = "notes/work.md";

    // Local write at VV {self:1}, but we DON'T retain history old enough
    // to satisfy the GCA — push two extra writes so v1 falls out of the
    // last-2 LRU window.
    state
        .record_local_write(VAULT, path, h(b"v1"), b"v1")
        .unwrap();
    state
        .record_local_write(VAULT, path, h(b"v2"), b"v2")
        .unwrap();
    state
        .record_local_write(VAULT, path, h(b"v3"), b"v3")
        .unwrap();
    let local_record = state.get_file(VAULT, path).unwrap().unwrap();
    // Ask for resolution against a remote whose VV's GCA points at v1 —
    // which is no longer in history.
    let remote_vv = VersionVector(
        [(SELF_PEER.into(), 1u64), (REMOTE_PEER.into(), 1u64)]
            .into_iter()
            .collect(),
    );

    let outcome = resolve(
        &state,
        VAULT,
        Path::new(path),
        &local_record,
        b"v3",
        b"divergent",
        &remote_vv,
        "Bob",
    )
    .unwrap();

    match outcome {
        ResolveOutcome::NoBaseInHistory { copy_path, copy_content } => {
            // Obsidian-compatible filename per epic #73 lock.
            let s = copy_path.to_string_lossy().to_string();
            assert!(s.starts_with("notes/work (conflict from Bob "), "got: {s}");
            assert!(s.contains("2026-05-03"), "stamp must be 2026-05-03, got: {s}");
            assert!(s.contains("14:22"), "stamp must be 14:22, got: {s}");
            assert!(s.ends_with(").md"), "must preserve extension, got: {s}");
            assert_eq!(copy_content, b"divergent");
        }
        other => panic!("expected NoBaseInHistory, got {other:?}"),
    }
}

#[test]
fn conflict_copy_path_format_round_trips() {
    let tmp = TempDir::new().unwrap();
    // 2026-05-03 14:22 UTC.
    let state = build_state(&tmp, 1_777_818_120);
    let p = conflict_copy_path(Path::new("a/b/note.md"), "Lucas's iPhone", &state);
    assert_eq!(
        p,
        PathBuf::from("a/b/note (conflict from Lucas's iPhone 2026-05-03 14:22).md")
    );

    let p2 = conflict_copy_path(Path::new("toplevel.md"), "Bob", &state);
    assert_eq!(
        p2,
        PathBuf::from("toplevel (conflict from Bob 2026-05-03 14:22).md")
    );
}

#[test]
fn tombstone_propagation_persists_with_30d_expiry() {
    let tmp = TempDir::new().unwrap();
    let t0: i64 = 1_700_000_000;
    let state = build_state(&tmp, t0);
    let mut vv = VersionVector::new();
    vv.increment(SELF_PEER);
    state
        .tombstones()
        .record_delete(VAULT, "deleted.md", &vv)
        .unwrap();

    // Row is live, expires_at is +30d.
    assert!(state.tombstones().is_tombstoned(VAULT, "deleted.md").unwrap());

    // Direct DB inspection: expires_at = t0 + 30d.
    let conn = state.lock_conn().unwrap();
    let expires_at: i64 = conn
        .query_row(
            "SELECT expires_at FROM sync_tombstones WHERE vault_id = ?1 AND path = ?2",
            rusqlite::params![VAULT, "deleted.md"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(expires_at, t0 + TOMBSTONE_TTL_SECS);
}

#[test]
fn tombstone_gc_removes_expired() {
    let tmp = TempDir::new().unwrap();
    let t0: i64 = 1_700_000_000;
    let clock = Arc::new(TestClock::new(t0));
    let state = Arc::new(
        SyncState::open_with(
            &tmp.path().join(".vaultcore"),
            SELF_PEER.into(),
            clock.clone(),
            HistoryConfig::default(),
        )
        .unwrap(),
    );
    let mut vv = VersionVector::new();
    vv.increment(SELF_PEER);
    state.tombstones().record_delete(VAULT, "a.md", &vv).unwrap();
    state.tombstones().record_delete(VAULT, "b.md", &vv).unwrap();

    // Advance to past TTL — both should GC.
    clock.set(t0 + TOMBSTONE_TTL_SECS + 1);
    let removed = state.tombstones().gc().unwrap();
    assert_eq!(removed, 2);
    assert!(!state.tombstones().is_tombstoned(VAULT, "a.md").unwrap());
    assert!(!state.tombstones().is_tombstoned(VAULT, "b.md").unwrap());
}

#[test]
fn rename_dispatches_single_renamekind() {
    // Spec: a single Renamed event must produce a single Rename
    // decision (not a Delete + Create pair). Verifies the engine's
    // ChangeKind::Renamed branch.
    let tmp = TempDir::new().unwrap();
    let state = build_state(&tmp, 1_700_000_000);
    let owner = fresh_signing_key();
    state
        .upsert_peer(
            REMOTE_PEER,
            &owner.verifying_key().to_bytes(),
            "Remote",
            PeerTrust::Trusted,
        )
        .unwrap();
    let body = CapabilityBody::issue_v1(VAULT, REMOTE_PEER, "remote-vault", Scope::ReadWrite);
    let cap = Capability::sign(&body, &owner);
    state.upsert_vault_grant(&cap).unwrap();

    let wi = Arc::new(Mutex::new(WriteIgnoreList::default()));
    let engine = SyncEngine::new(state, wi);
    engine.set_vault_root(tmp.path().to_path_buf()).unwrap();

    let mut vv = VersionVector::new();
    vv.increment(REMOTE_PEER);
    let evt = ChangeEvent {
        vault_id: VAULT.into(),
        path: PathBuf::from("renamed/new.md"),
        kind: ChangeKind::Renamed {
            from: PathBuf::from("renamed/old.md"),
        },
        source_peer: REMOTE_PEER.into(),
        version_vector: vv,
        content_hash: h(b"renamed-content"),
    };
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    match decision {
        InboundDecision::Rename { from, to } => {
            assert_eq!(from, tmp.path().join("renamed/old.md"));
            assert_eq!(to, tmp.path().join("renamed/new.md"));
        }
        other => panic!("expected single Rename decision, got {other:?}"),
    }
}
