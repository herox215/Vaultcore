//! TDD coverage for #418/UI-1.5 pairing engine integration.
//!
//! Each test runs two real in-process devices over loopback TCP — no
//! mocks. The initiator side of each scenario `connect`s to the listener
//! the responder thread spawns, so timing is identical to what UI-6
//! manual UAT will exercise. This file exclusively drives the new
//! engine entry points; the legacy inline `pair_and_connect` in
//! `tests/sync_e2e.rs` is the regression check after the same logic is
//! folded into the engine.

use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

use ed25519_dalek::SigningKey;
use rand_core::RngCore;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use crate::sync::capability::{CapabilityBody, Scope};
use crate::sync::clock::TestClock;
use crate::sync::history::HistoryConfig;
use crate::sync::pairing::{
    finalize_with_confirmation, key_confirmation_mac, respond, start_initiator, PairingSession,
};
use crate::sync::pairing_engine::{
    drive_initiator_after_pake, drive_responder_after_pake, exchange_vault_grant_initiator,
    exchange_vault_grant_responder, PairingEngineError, ALREADY_PAIRED,
};
use crate::sync::state::SyncState;
use crate::sync::transport::{generate_static_keypair, NoiseKeypair};

const PIN: &str = "246810";
const VAULT_A: &str = "vault-uuid-a";
const VAULT_B: &str = "vault-uuid-b";

/// One end of an in-process pair. Carries the long-term Ed25519 key
/// (used to sign the long-term-key-attestation MAC + the cap), the
/// Curve25519 noise static (used by the XX handshake), the device id,
/// and an open `SyncState` rooted at a tempdir.
struct Side {
    device_id: String,
    signing_key: SigningKey,
    noise_kp: NoiseKeypair,
    state: Arc<SyncState>,
    _tmp: TempDir,
}

impl Side {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let metadata = tmp.path().join(".vaultcore");
        std::fs::create_dir_all(&metadata).unwrap();
        let signing_key = fresh_signing_key();
        let device_id = derive_device_id(&signing_key);
        let noise_kp = generate_static_keypair().unwrap();
        let state = Arc::new(
            SyncState::open_with(
                &metadata,
                device_id.clone(),
                Arc::new(TestClock::new(1_700_000_000)),
                HistoryConfig::default(),
            )
            .unwrap(),
        );
        Self {
            device_id,
            signing_key,
            noise_kp,
            state,
            _tmp: tmp,
        }
    }
}

fn fresh_signing_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    SigningKey::from_bytes(&bytes)
}

fn derive_device_id(sk: &SigningKey) -> String {
    use data_encoding::BASE32_NOPAD;
    let pubkey = sk.verifying_key().to_bytes();
    let digest = Sha256::digest(pubkey);
    BASE32_NOPAD.encode(&digest[..16])
}

/// Run PAKE in-process between two sides. Returns `(k2_a, k2_b)` so each
/// side can produce its own MAC and then finalize. PAKE itself is
/// already covered by `pairing_tests`; this helper just stages the
/// post-PAKE state the engine driver consumes.
fn run_pake(a: &Side, b: &Side) -> ([u8; 32], [u8; 32]) {
    let session_a = PairingSession::new();
    let session_b = PairingSession::new();
    session_a.issue_pin().unwrap();
    session_b.issue_pin().unwrap();

    let initiator = start_initiator(PIN, &a.device_id, &b.device_id).unwrap();
    let s1 = initiator.step1_packet();
    let responder = respond(&s1, PIN, &a.device_id, &b.device_id).unwrap();
    let s2 = responder.step2_packet();
    let raw_a = initiator.step3(&s2).unwrap();
    let raw_b = responder.raw_keys;

    let mac_b = key_confirmation_mac(&raw_b.k2, &a.device_id, &b.device_id);
    let mac_a = key_confirmation_mac(&raw_a.k2, &a.device_id, &b.device_id);
    finalize_with_confirmation(&raw_a, &mac_b, &session_a).unwrap();
    finalize_with_confirmation(&raw_b, &mac_a, &session_b).unwrap();

    (raw_a.k2, raw_b.k2)
}

#[test]
fn two_in_process_devices_complete_full_pairing_handshake() {
    let a = Arc::new(Side::new());
    let b = Arc::new(Side::new());
    let (k2_a, k2_b) = run_pake(&a, &b);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let b_for_thread = Arc::clone(&b);
    let a_id_for_thread = a.device_id.clone();
    let resp = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        drive_responder_after_pake(
            &mut stream,
            &b_for_thread.noise_kp,
            &b_for_thread.signing_key,
            &b_for_thread.device_id,
            &a_id_for_thread,
            &k2_b,
            &b_for_thread.state,
        )
        .unwrap();
    });

    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let outcome = drive_initiator_after_pake(
        &mut stream,
        &a.noise_kp,
        &a.signing_key,
        &a.device_id,
        &b.device_id,
        &k2_a,
        &a.state,
    )
    .unwrap();
    resp.join().unwrap();

    assert!(!outcome.short_circuited);
    // A's DB now has B's long-term Ed25519 pubkey under PeerTrust::Trusted.
    let stored_pk = a.state.peer_pubkey(&b.device_id).unwrap().unwrap();
    assert_eq!(stored_pk, b.signing_key.verifying_key().to_bytes());
}

#[test]
fn pairing_persists_peer_trust_after_xx_bootstrap_on_both_sides() {
    let a = Arc::new(Side::new());
    let b = Arc::new(Side::new());
    let (k2_a, k2_b) = run_pake(&a, &b);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let b_t = Arc::clone(&b);
    let a_id_t = a.device_id.clone();
    let resp = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        drive_responder_after_pake(
            &mut stream,
            &b_t.noise_kp,
            &b_t.signing_key,
            &b_t.device_id,
            &a_id_t,
            &k2_b,
            &b_t.state,
        )
        .unwrap();
    });
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    drive_initiator_after_pake(
        &mut stream,
        &a.noise_kp,
        &a.signing_key,
        &a.device_id,
        &b.device_id,
        &k2_a,
        &a.state,
    )
    .unwrap();
    resp.join().unwrap();

    // Each side has the *peer's* long-term Ed25519 pubkey persisted under
    // PeerTrust::Trusted. peer_pubkey returns Some only for trusted rows.
    let pk_b_on_a = a.state.peer_pubkey(&b.device_id).unwrap().unwrap();
    assert_eq!(pk_b_on_a, b.signing_key.verifying_key().to_bytes());
    let pk_a_on_b = b.state.peer_pubkey(&a.device_id).unwrap().unwrap();
    assert_eq!(pk_a_on_b, a.signing_key.verifying_key().to_bytes());
}

#[test]
fn pairing_grant_exchange_persists_caps_on_both_sides() {
    let a = Arc::new(Side::new());
    let b = Arc::new(Side::new());
    let (k2_a, k2_b) = run_pake(&a, &b);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let b_t = Arc::clone(&b);
    let a_id_t = a.device_id.clone();
    let resp = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut session = drive_responder_after_pake(
            &mut stream,
            &b_t.noise_kp,
            &b_t.signing_key,
            &b_t.device_id,
            &a_id_t,
            &k2_b,
            &b_t.state,
        )
        .unwrap();
        // After bootstrap, B grants A access to VAULT_B and waits for A's
        // matching grant. Both rows land in the local DB.
        let body = CapabilityBody::issue_v1(VAULT_B, &b_t.device_id, VAULT_B, Scope::ReadWrite);
        exchange_vault_grant_responder(
            &mut session,
            &b_t.signing_key,
            &body,
            &a_id_t,
            &b_t.state,
        )
        .unwrap();
    });
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut session = drive_initiator_after_pake(
        &mut stream,
        &a.noise_kp,
        &a.signing_key,
        &a.device_id,
        &b.device_id,
        &k2_a,
        &a.state,
    )
    .unwrap();
    let body = CapabilityBody::issue_v1(VAULT_A, &a.device_id, VAULT_A, Scope::ReadWrite);
    exchange_vault_grant_initiator(
        &mut session,
        &a.signing_key,
        &body,
        &b.device_id,
        &a.state,
    )
    .unwrap();
    resp.join().unwrap();

    // A holds the cap B issued (signed under B's key, body identifies B as
    // the peer_device_id of the issuer — matches engine_tests::pair_peer_with_grant).
    let cap_on_a = a.state.vault_grant(VAULT_B, &b.device_id).unwrap().unwrap();
    let body_on_a = cap_on_a.verify(&b.signing_key.verifying_key()).unwrap();
    assert_eq!(body_on_a.local_vault_id, VAULT_B);
    assert_eq!(body_on_a.peer_device_id, b.device_id);

    // B holds the cap A issued.
    let cap_on_b = b.state.vault_grant(VAULT_A, &a.device_id).unwrap().unwrap();
    let body_on_b = cap_on_b.verify(&a.signing_key.verifying_key()).unwrap();
    assert_eq!(body_on_b.local_vault_id, VAULT_A);
    assert_eq!(body_on_b.peer_device_id, a.device_id);
}

#[test]
fn pairing_aborts_cleanly_when_long_term_key_signature_invalid() {
    // The responder will try to attest under a *fresh* k2 (different
    // from the one A used) — the HMAC verifier on the initiator side
    // must reject and return an error rather than persisting trust.
    let a = Arc::new(Side::new());
    let b = Arc::new(Side::new());
    let (k2_a, _k2_b) = run_pake(&a, &b);
    let bogus_k2 = [0xFFu8; 32];

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let b_t = Arc::clone(&b);
    let a_id_t = a.device_id.clone();
    let resp = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        // Run with a wrong k2 — mac verification on the *initiator* side
        // must fail. The responder's own send/recv may complete or error
        // depending on which side detects first; either is fine.
        let _ = drive_responder_after_pake(
            &mut stream,
            &b_t.noise_kp,
            &b_t.signing_key,
            &b_t.device_id,
            &a_id_t,
            &bogus_k2,
            &b_t.state,
        );
    });
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let err = drive_initiator_after_pake(
        &mut stream,
        &a.noise_kp,
        &a.signing_key,
        &a.device_id,
        &b.device_id,
        &k2_a,
        &a.state,
    )
    .expect_err("must abort on attest mismatch");
    let _ = resp.join();
    assert!(matches!(err, PairingEngineError::AttestationMismatch));
    // No peer was persisted on A.
    assert!(a.state.peer_pubkey(&b.device_id).unwrap().is_none());
}

#[test]
fn second_pairing_attempt_with_already_paired_peer_short_circuits_to_one_tap_grant() {
    // Pair once over a real socket so both sides have full peer rows.
    let a = Arc::new(Side::new());
    let b = Arc::new(Side::new());
    let (k2_a, k2_b) = run_pake(&a, &b);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let b_t = Arc::clone(&b);
    let a_id_t = a.device_id.clone();
    let resp = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        drive_responder_after_pake(
            &mut stream,
            &b_t.noise_kp,
            &b_t.signing_key,
            &b_t.device_id,
            &a_id_t,
            &k2_b,
            &b_t.state,
        )
        .unwrap();
    });
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    drive_initiator_after_pake(
        &mut stream,
        &a.noise_kp,
        &a.signing_key,
        &a.device_id,
        &b.device_id,
        &k2_a,
        &a.state,
    )
    .unwrap();
    resp.join().unwrap();
    assert!(a.state.peer_pubkey(&b.device_id).unwrap().is_some());

    // Second attempt — by spec, the engine recognizes the peer is already
    // trusted and returns `short_circuited = true` with reason
    // `ALREADY_PAIRED` *without* tearing down + re-binding peer rows.
    let (k2_a_2, k2_b_2) = run_pake(&a, &b);
    let listener2 = TcpListener::bind("127.0.0.1:0").unwrap();
    let port2 = listener2.local_addr().unwrap().port();
    let b_t2 = Arc::clone(&b);
    let a_id_t2 = a.device_id.clone();
    let resp2 = thread::spawn(move || {
        let (mut stream, _) = listener2.accept().unwrap();
        drive_responder_after_pake(
            &mut stream,
            &b_t2.noise_kp,
            &b_t2.signing_key,
            &b_t2.device_id,
            &a_id_t2,
            &k2_b_2,
            &b_t2.state,
        )
        .unwrap();
    });
    let mut stream2 = TcpStream::connect(("127.0.0.1", port2)).unwrap();
    let outcome = drive_initiator_after_pake(
        &mut stream2,
        &a.noise_kp,
        &a.signing_key,
        &a.device_id,
        &b.device_id,
        &k2_a_2,
        &a.state,
    )
    .unwrap();
    resp2.join().unwrap();
    assert!(outcome.short_circuited);
    assert_eq!(outcome.reason.as_deref(), Some(ALREADY_PAIRED));
    // The persisted pubkey is unchanged (the second flow was a no-op
    // beyond the handshake itself).
    assert_eq!(
        a.state.peer_pubkey(&b.device_id).unwrap().unwrap(),
        b.signing_key.verifying_key().to_bytes()
    );
}
