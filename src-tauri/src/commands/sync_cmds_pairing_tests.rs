//! UI-1.6 — IPC pairing-engine integration tests.
//!
//! Two `SyncRuntime`s, both backed by `MemoryKeyStore`, paired over real
//! loopback TCP through the Tauri IPC surface. No mocks: the same
//! `pairing_step` / `pairing_confirm` / `pairing_grant_vault` entry points
//! the UI calls drive PAKE → Noise XX → long-term-key attestation →
//! capability exchange end-to-end.
//!
//! The initiator's pairing listener binds an ephemeral port (passed in
//! through the test-only `bind_port_override` arg on `pairing_start_initiator`)
//! and the responder's worker dials it directly via `peer_addr_override`.
//! Production resolves the same address via mDNS — the test bypass keeps
//! the suite mDNS-free while exercising the same crypto + state machine.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use crate::commands::sync_cmds::SyncRuntime;
use crate::sync::capability::Scope;
use crate::sync::clock::TestClock;
use crate::sync::history::HistoryConfig;
use crate::sync::pairing::LOCKOUT_AFTER_ATTEMPTS;
use crate::sync::state::SyncState;

/// PAKE+attestation completes well under a second on loopback; allow 5 s
/// for slow CI. If it ever takes longer the test fails fast rather than
/// hanging the suite.
const PAIR_DEADLINE: Duration = Duration::from_secs(5);

fn build_runtime() -> Arc<SyncRuntime> {
    Arc::new(SyncRuntime::new_for_test().expect("runtime"))
}

fn open_active_state(rt: &SyncRuntime, tmp: &TempDir) -> Arc<SyncState> {
    let metadata = tmp.path().join(".vaultcore");
    std::fs::create_dir_all(&metadata).unwrap();
    let state = Arc::new(
        SyncState::open_with(
            &metadata,
            rt.self_identity().device_id,
            Arc::new(TestClock::new(1_700_000_000)),
            HistoryConfig::default(),
        )
        .expect("open sync state"),
    );
    rt.set_active_sync_state(Some(Arc::clone(&state))).unwrap();
    state
}

/// Block until `pairing_step` reports `kind == expected`, or `deadline`
/// elapses. Polls every 25 ms — fast enough to feel real-time, slow enough
/// to keep CI CPU usage trivial.
fn wait_for_kind(
    rt: &SyncRuntime,
    session_id: &str,
    expected: &str,
    deadline: Duration,
) -> bool {
    let stop_at = Instant::now() + deadline;
    while Instant::now() < stop_at {
        if let Ok(step) = rt.pairing_step(session_id, None) {
            if step.kind == expected {
                return true;
            }
            if step.kind == "failed" && expected != "failed" {
                return false;
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Bring up two runtimes, kick off pairing on both sides, return
/// (initiator_session_id, responder_session_id, port). Both sides must
/// reach `awaiting_confirmation` before the helper returns.
fn pair_through_ipc(
    a: &Arc<SyncRuntime>,
    b: &Arc<SyncRuntime>,
    pin: &str,
) -> (String, String, u16) {
    // Bind an ephemeral pairing port on A (test-port=0) so multiple test
    // cases can run in parallel without clashing on DEFAULT_PAIRING_PORT.
    let init_dto = a
        .pairing_start_initiator(Some(pin.into()), Some(0))
        .expect("start initiator");
    let port = pairing_listener_port(a, &init_dto.session_id);
    let dial_addr: SocketAddr = ([127, 0, 0, 1], port).into();

    let resp_dto = b
        .pairing_start_responder(
            pin,
            Some(a.self_identity().device_id),
            Some(dial_addr),
        )
        .expect("start responder");
    (init_dto.session_id, resp_dto.session_id, port)
}

/// Test-only: dig the bound listener port out of the initiator session.
/// We re-export the listener Arc through a public test-helper on
/// SyncRuntime to avoid leaking PairingFlow internals.
fn pairing_listener_port(rt: &SyncRuntime, session_id: &str) -> u16 {
    rt.pairing_listener_port_for_test(session_id)
        .expect("listener port available immediately after start")
}

#[test]
fn two_runtimes_pair_via_ipc_round_trip() {
    let a = build_runtime();
    let b = build_runtime();
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    let state_a = open_active_state(&a, &tmp_a);
    let state_b = open_active_state(&b, &tmp_b);

    let (sid_a, sid_b, _port) = pair_through_ipc(&a, &b, "246810");

    // Both workers must converge to awaiting_confirmation.
    assert!(
        wait_for_kind(&a, &sid_a, "awaiting_confirmation", PAIR_DEADLINE),
        "initiator must reach awaiting_confirmation"
    );
    assert!(
        wait_for_kind(&b, &sid_b, "awaiting_confirmation", PAIR_DEADLINE),
        "responder must reach awaiting_confirmation"
    );

    // Fingerprint surfaces on both sides.
    let step_a = a.pairing_step(&sid_a, None).unwrap();
    let step_b = b.pairing_step(&sid_b, None).unwrap();
    assert!(
        step_a.peer_fingerprint.as_deref().map(|s| s.len() == 8).unwrap_or(false),
        "initiator fingerprint must be 8-char base32 prefix, got {:?}",
        step_a.peer_fingerprint
    );
    assert!(step_b.peer_fingerprint.is_some());

    // Engine has already persisted both peer rows under PeerTrust::Trusted.
    let pk_b_on_a = state_a
        .peer_pubkey(&b.self_identity().device_id)
        .unwrap()
        .expect("B's pubkey on A");
    assert_eq!(pk_b_on_a.len(), 32);
    let pk_a_on_b = state_b
        .peer_pubkey(&a.self_identity().device_id)
        .unwrap()
        .expect("A's pubkey on B");
    assert_eq!(pk_a_on_b.len(), 32);

    // User confirms on both sides → both transition to `complete`.
    let _ = a.pairing_confirm(&sid_a).unwrap();
    let _ = b.pairing_confirm(&sid_b).unwrap();
    assert_eq!(a.pairing_step(&sid_a, None).unwrap().kind, "complete");
    assert_eq!(b.pairing_step(&sid_b, None).unwrap().kind, "complete");

    a.pairing_cancel(&sid_a).unwrap();
    b.pairing_cancel(&sid_b).unwrap();
}

#[test]
fn mismatched_pin_increments_lockout_via_ipc() {
    let a = build_runtime();
    let b = build_runtime();
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    let _state_a = open_active_state(&a, &tmp_a);
    let _state_b = open_active_state(&b, &tmp_b);

    // Initiator uses "111111", responder uses "222222" — PAKE itself
    // succeeds (it doesn't error on wrong PIN, keys silently diverge),
    // but the key-confirmation MAC must fail.
    let init_dto = a
        .pairing_start_initiator(Some("111111".into()), Some(0))
        .expect("start initiator");
    let port = pairing_listener_port(&a, &init_dto.session_id);
    let dial_addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let resp_dto = b
        .pairing_start_responder(
            "222222",
            Some(a.self_identity().device_id),
            Some(dial_addr),
        )
        .expect("start responder");

    // Both sides must reach `failed` (key-confirmation mismatch).
    assert!(
        wait_for_kind(&a, &init_dto.session_id, "failed", PAIR_DEADLINE),
        "initiator must reach failed on PIN mismatch"
    );
    let step_a = a.pairing_step(&init_dto.session_id, None).unwrap();
    assert_eq!(step_a.kind, "failed");
    // After one failure, attempts_remaining must have decreased from
    // LOCKOUT_AFTER_ATTEMPTS (3) to 2.
    assert_eq!(
        step_a.attempts_remaining,
        Some(LOCKOUT_AFTER_ATTEMPTS - 1),
        "first failure must consume one attempt"
    );

    a.pairing_cancel(&init_dto.session_id).unwrap();
    b.pairing_cancel(&resp_dto.session_id).unwrap();
}

#[test]
fn three_failed_attempts_locks_out_pairing_step() {
    let a = build_runtime();
    let init_dto = a
        .pairing_start_initiator(Some("111111".into()), Some(0))
        .expect("start initiator");
    // Drive the underlying PairingSession to lockout via the test-only
    // helper. `pairing_tests::three_failed_attempts_locks_out` already
    // covers the wire-driven lockout path at the unit-test level — this
    // test focuses on whether `pairing_step` correctly surfaces a
    // locked-out session through the IPC.
    a.force_lockout_for_test(&init_dto.session_id)
        .expect("force lockout");
    let step = a.pairing_step(&init_dto.session_id, None).unwrap();
    assert_eq!(step.kind, "failed");
    assert_eq!(step.attempts_remaining, Some(0));
    a.pairing_cancel(&init_dto.session_id).unwrap();
}

#[test]
fn pairing_cancel_closes_stream_and_drops_session() {
    let a = build_runtime();
    let tmp_a = TempDir::new().unwrap();
    let _state_a = open_active_state(&a, &tmp_a);
    let init_dto = a
        .pairing_start_initiator(Some("314159".into()), Some(0))
        .expect("start initiator");
    a.pairing_cancel(&init_dto.session_id).unwrap();
    // Session must be gone — pairing_step returns "unknown".
    let err = a
        .pairing_step(&init_dto.session_id, None)
        .expect_err("session must be dropped");
    match err {
        crate::error::VaultError::SyncState { msg } => assert!(msg.contains("unknown")),
        other => panic!("wrong error: {other:?}"),
    }
}

#[test]
fn grant_vault_after_pair_persists_capability_on_both_sides() {
    let a = build_runtime();
    let b = build_runtime();
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    let state_a = open_active_state(&a, &tmp_a);
    let state_b = open_active_state(&b, &tmp_b);

    let (sid_a, sid_b, _port) = pair_through_ipc(&a, &b, "424242");

    assert!(wait_for_kind(&a, &sid_a, "awaiting_confirmation", PAIR_DEADLINE));
    assert!(wait_for_kind(&b, &sid_b, "awaiting_confirmation", PAIR_DEADLINE));

    // Confirm before the grant to mirror the UI flow (user clicks
    // "Bestätigen", then grant exchange runs).
    let _ = a.pairing_confirm(&sid_a).unwrap();
    let _ = b.pairing_confirm(&sid_b).unwrap();

    // Run the grant exchange in two threads so initiator-send-first /
    // responder-recv-first don't deadlock on the same IPC thread.
    let b_t = Arc::clone(&b);
    let sid_b_t = sid_b.clone();
    let h_b = std::thread::spawn(move || {
        b_t.pairing_grant_vault(&sid_b_t, "vault-shared", Scope::ReadWrite)
            .expect("b grant")
    });
    a.pairing_grant_vault(&sid_a, "vault-shared", Scope::ReadWrite)
        .expect("a grant");
    h_b.join().expect("b thread");

    // Each side now holds the *peer's* signed cap for "vault-shared".
    let cap_a = state_a
        .vault_grant("vault-shared", &b.self_identity().device_id)
        .unwrap()
        .expect("A holds B's cap");
    let cap_b = state_b
        .vault_grant("vault-shared", &a.self_identity().device_id)
        .unwrap()
        .expect("B holds A's cap");
    assert!(!cap_a.signature.is_empty());
    assert!(!cap_b.signature.is_empty());

    a.pairing_cancel(&sid_a).unwrap();
    b.pairing_cancel(&sid_b).unwrap();
}
