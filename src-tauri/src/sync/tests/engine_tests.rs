//! TDD coverage for #419 sync engine + WriteIgnoreList invariant.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ed25519_dalek::SigningKey;
use rand_core::RngCore;
use tempfile::TempDir;

use crate::sync::capability::{Capability, CapabilityBody, Scope};
use crate::sync::clock::TestClock;
use crate::sync::engine::{
    BatchOutcome, InboundDecision, RejectReason, SyncBatchGate, SyncEngine,
    BATCH_REBUILD_THRESHOLD,
};
use crate::sync::history::HistoryConfig;
use crate::sync::protocol::{ChangeEvent, ChangeKind};
use crate::sync::state::{PeerTrust, SyncState};
use crate::sync::VersionVector;
use crate::WriteIgnoreList;

const SELF_PEER: &str = "SELFDEVICEIDXXXX";
const REMOTE_PEER: &str = "PEERDEVICEIDXXXX";
const VAULT: &str = "vault-uuid";

fn fresh_signing_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    SigningKey::from_bytes(&bytes)
}

fn h(byte: u8) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[0] = byte;
    o
}

fn build_engine(tmp: &TempDir) -> (SyncEngine, Arc<SyncState>, Arc<Mutex<WriteIgnoreList>>) {
    let metadata = tmp.path().join(".vaultcore");
    std::fs::create_dir_all(&metadata).unwrap();
    let state = Arc::new(
        SyncState::open_with(
            &metadata,
            SELF_PEER.to_string(),
            Arc::new(TestClock::new(1_700_000_000)),
            HistoryConfig::default(),
        )
        .unwrap(),
    );
    let wi = Arc::new(Mutex::new(WriteIgnoreList::default()));
    let engine = SyncEngine::new(state.clone(), wi.clone());
    engine.set_vault_root(tmp.path().to_path_buf()).unwrap();
    (engine, state, wi)
}

/// Persist a peer + a ReadWrite capability so the engine accepts events
/// from `REMOTE_PEER`. Returns the owner key (caller may issue more
/// capabilities later).
fn pair_peer_with_grant(state: &SyncState) -> SigningKey {
    let owner = fresh_signing_key();
    let pk = owner.verifying_key().to_bytes();
    state
        .upsert_peer(REMOTE_PEER, &pk, "Remote", PeerTrust::Trusted)
        .unwrap();
    let body = CapabilityBody::issue_v1(VAULT, REMOTE_PEER, "remote-vault", Scope::ReadWrite);
    let cap = Capability::sign(&body, &owner);
    state.upsert_vault_grant(&cap).unwrap();
    owner
}

fn evt_upsert(content: &[u8], hash: [u8; 32], vv: VersionVector) -> ChangeEvent {
    ChangeEvent {
        vault_id: VAULT.into(),
        path: PathBuf::from("notes/a.md"),
        kind: ChangeKind::Upserted {
            content: content.to_vec(),
        },
        source_peer: REMOTE_PEER.into(),
        version_vector: vv,
        content_hash: hash,
    }
}

#[test]
fn engine_discards_dominated_remote_event() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    pair_peer_with_grant(&state);

    // Bring local up to {self: 2}.
    state
        .record_local_write(VAULT, "notes/a.md", h(0x10), b"v1")
        .unwrap();
    state
        .record_local_write(VAULT, "notes/a.md", h(0x11), b"v2")
        .unwrap();

    // Remote arrives with stale {self: 1}.
    let stale_vv = VersionVector(
        [(SELF_PEER.into(), 1u64)].into_iter().collect(),
    );
    let evt = evt_upsert(b"stale", h(0xEE), stale_vv);
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    assert_eq!(decision, InboundDecision::Discard);

    // No write-ignore was registered (no disk write would happen).
    let abs = tmp.path().join("notes/a.md");
    assert!(!engine.is_write_ignored(&abs).unwrap());
}

#[test]
fn engine_fast_forwards_when_remote_dominates() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    pair_peer_with_grant(&state);

    state
        .record_local_write(VAULT, "notes/a.md", h(0x10), b"v1")
        .unwrap();

    // Remote dominates: includes self's counter and adds its own.
    let mut remote_vv = VersionVector(
        [(SELF_PEER.into(), 1u64)].into_iter().collect(),
    );
    remote_vv.0.insert(REMOTE_PEER.into(), 5);
    let evt = evt_upsert(b"newer", h(0x22), remote_vv);
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    let abs = tmp.path().join("notes/a.md");
    match decision {
        InboundDecision::FastForward { path, content, content_hash } => {
            assert_eq!(path, abs);
            assert_eq!(content, b"newer");
            assert_eq!(content_hash, h(0x22));
        }
        other => panic!("expected FastForward, got {other:?}"),
    }

    // CRITICAL invariant: write_ignore was registered BEFORE the disk
    // write would happen (the engine returns the path with it pre-set).
    assert!(
        engine.is_write_ignored(&abs).unwrap(),
        "write_ignore must be registered before sync-pull write (D-12)"
    );
}

#[test]
fn engine_marks_concurrent_for_merge() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    pair_peer_with_grant(&state);

    state
        .record_local_write(VAULT, "notes/a.md", h(0x10), b"local")
        .unwrap();
    let remote_vv = VersionVector(
        [(REMOTE_PEER.into(), 1u64)].into_iter().collect(),
    );
    let evt = evt_upsert(b"remote", h(0x33), remote_vv);
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    let abs = tmp.path().join("notes/a.md");
    match decision {
        InboundDecision::NeedsMerge {
            path,
            remote_content,
            remote_hash,
        } => {
            assert_eq!(path, abs);
            assert_eq!(remote_content, b"remote");
            assert_eq!(remote_hash, h(0x33));
        }
        other => panic!("expected NeedsMerge, got {other:?}"),
    }

    // Concurrent path does NOT register write_ignore — merge runs in
    // the editor and the merge result will register on its own write.
    assert!(!engine.is_write_ignored(&abs).unwrap());
}

#[test]
fn capability_required_to_accept_event() {
    let tmp = TempDir::new().unwrap();
    let (engine, _state, _wi) = build_engine(&tmp);
    // No peer paired, no grant issued.

    let vv = VersionVector(
        [(REMOTE_PEER.into(), 1u64)].into_iter().collect(),
    );
    let evt = evt_upsert(b"unauthorized", h(0x44), vv);
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    assert_eq!(
        decision,
        InboundDecision::Rejected {
            reason: RejectReason::NoGrant
        }
    );
}

#[test]
fn capability_with_wrong_signature_rejected() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);

    // Peer paired under one Ed25519 key but capability signed under another.
    let peer_key = fresh_signing_key();
    let pk = peer_key.verifying_key().to_bytes();
    state
        .upsert_peer(REMOTE_PEER, &pk, "Remote", PeerTrust::Trusted)
        .unwrap();
    let attacker_key = fresh_signing_key();
    let body = CapabilityBody::issue_v1(VAULT, REMOTE_PEER, "remote-vault", Scope::ReadWrite);
    let cap = Capability::sign(&body, &attacker_key);
    state.upsert_vault_grant(&cap).unwrap();

    let vv = VersionVector(
        [(REMOTE_PEER.into(), 1u64)].into_iter().collect(),
    );
    let evt = evt_upsert(b"forged", h(0x55), vv);
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    assert_eq!(
        decision,
        InboundDecision::Rejected {
            reason: RejectReason::InvalidSignature
        }
    );
}

#[test]
fn read_only_grant_rejects_write_event() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    let owner = fresh_signing_key();
    state
        .upsert_peer(
            REMOTE_PEER,
            &owner.verifying_key().to_bytes(),
            "Remote",
            PeerTrust::Trusted,
        )
        .unwrap();
    // Read-only grant.
    let body = CapabilityBody::issue_v1(VAULT, REMOTE_PEER, "remote-vault", Scope::Read);
    let cap = Capability::sign(&body, &owner);
    state.upsert_vault_grant(&cap).unwrap();

    let vv = VersionVector(
        [(REMOTE_PEER.into(), 1u64)].into_iter().collect(),
    );
    let evt = evt_upsert(b"writeattempt", h(0x66), vv);
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    assert_eq!(
        decision,
        InboundDecision::Rejected {
            reason: RejectReason::ScopeInsufficient
        }
    );
}

/// Property test: every fast-forward / created / delete / rename
/// inbound event registers `WriteIgnoreList` BEFORE the engine returns,
/// for any randomized path-segment composition. Asserts the
/// "BEFORE-the-write, never AFTER" invariant epic #73 calls load-bearing.
#[test]
fn write_ignore_list_registered_before_sync_pull_write() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    pair_peer_with_grant(&state);

    // 30 randomized paths in a single batch — overkill on purpose.
    use rand::Rng;
    let mut rng = rand::thread_rng();
    for i in 0..30u32 {
        let depth: usize = rng.gen_range(0..=3);
        let mut rel = PathBuf::new();
        for _ in 0..depth {
            let seg: u32 = rng.gen();
            rel.push(format!("d{seg}"));
        }
        rel.push(format!("note-{i}.md"));

        let mut vv = VersionVector::new();
        vv.increment(REMOTE_PEER);

        let evt = ChangeEvent {
            vault_id: VAULT.into(),
            path: rel.clone(),
            kind: ChangeKind::Upserted {
                content: vec![i as u8],
            },
            source_peer: REMOTE_PEER.into(),
            version_vector: vv,
            content_hash: h(i as u8),
        };
        let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
        let abs = tmp.path().join(&rel);
        match decision {
            InboundDecision::FastForward { path, .. }
            | InboundDecision::Created { path, .. }
            | InboundDecision::Delete { path } => {
                assert_eq!(path, abs);
                assert!(
                    engine.is_write_ignored(&abs).unwrap(),
                    "abs {abs:?} must be in WriteIgnoreList before disk write (D-12)"
                );
            }
            InboundDecision::Rename { from, to } => {
                assert!(engine.is_write_ignored(&from).unwrap());
                assert!(engine.is_write_ignored(&to).unwrap());
            }
            InboundDecision::NeedsMerge { .. } => {
                // Merge path: no ignore registration (merge result writes
                // through editor + registers itself).
            }
            InboundDecision::Discard | InboundDecision::Rejected { .. } => unreachable!(),
        }
    }
}

#[test]
fn sync_batch_markers_suppress_per_file_indexcmd() {
    let gate = SyncBatchGate::new();
    assert!(!gate.should_suppress_dispatch());

    gate.begin("vault-x").unwrap();
    assert!(gate.should_suppress_dispatch());
    assert_eq!(gate.open_vault().as_deref(), Some("vault-x"));

    for i in 0..50u32 {
        gate.note_change(PathBuf::from(format!("note-{i}.md"))).unwrap();
    }
    let outcome = gate.end().unwrap();
    match outcome {
        BatchOutcome::Bulk(paths) => assert_eq!(paths.len(), 50),
        BatchOutcome::Rebuild { .. } => panic!("50 < threshold; should be Bulk"),
    }
    assert!(!gate.should_suppress_dispatch());

    // Over the threshold → Rebuild.
    gate.begin("vault-y").unwrap();
    for i in 0..(BATCH_REBUILD_THRESHOLD + 1) {
        gate.note_change(PathBuf::from(format!("p{i}.md"))).unwrap();
    }
    let outcome2 = gate.end().unwrap();
    match outcome2 {
        BatchOutcome::Rebuild { affected_count } => {
            assert_eq!(affected_count, BATCH_REBUILD_THRESHOLD + 1);
        }
        BatchOutcome::Bulk(_) => panic!("over threshold should yield Rebuild"),
    }
}

#[test]
fn delete_event_registers_write_ignore_and_returns_path() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    pair_peer_with_grant(&state);

    let mut vv = VersionVector::new();
    vv.increment(REMOTE_PEER);
    let evt = ChangeEvent {
        vault_id: VAULT.into(),
        path: PathBuf::from("gone.md"),
        kind: ChangeKind::Deleted,
        source_peer: REMOTE_PEER.into(),
        version_vector: vv,
        content_hash: h(0x77),
    };
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    let abs = tmp.path().join("gone.md");
    match decision {
        InboundDecision::Delete { path } => assert_eq!(path, abs),
        other => panic!("expected Delete, got {other:?}"),
    }
    assert!(engine.is_write_ignored(&abs).unwrap());
}

#[test]
fn rename_event_registers_both_endpoints() {
    let tmp = TempDir::new().unwrap();
    let (engine, state, _wi) = build_engine(&tmp);
    pair_peer_with_grant(&state);

    let mut vv = VersionVector::new();
    vv.increment(REMOTE_PEER);
    let evt = ChangeEvent {
        vault_id: VAULT.into(),
        path: PathBuf::from("new.md"),
        kind: ChangeKind::Renamed {
            from: PathBuf::from("old.md"),
        },
        source_peer: REMOTE_PEER.into(),
        version_vector: vv,
        content_hash: h(0x88),
    };
    let decision = engine.apply_remote_event(&evt, REMOTE_PEER).unwrap();
    let abs_from = tmp.path().join("old.md");
    let abs_to = tmp.path().join("new.md");
    match decision {
        InboundDecision::Rename { from, to } => {
            assert_eq!(from, abs_from);
            assert_eq!(to, abs_to);
        }
        other => panic!("expected Rename, got {other:?}"),
    }
    assert!(engine.is_write_ignored(&abs_from).unwrap());
    assert!(engine.is_write_ignored(&abs_to).unwrap());
}
