//! TDD coverage for #418 PAKE pairing + capability tokens.

use std::sync::Arc;

use ed25519_dalek::SigningKey;
use rand_core::RngCore;

use crate::sync::capability::{Capability, CapabilityBody, Scope};
use crate::sync::clock::TestClock;
use crate::sync::pairing::{
    finalize_with_confirmation, key_confirmation_mac, respond, start_initiator, validate_pin,
    PairError, PairingSession, LOCKOUT_AFTER_ATTEMPTS, PIN_EXPIRY_SECS,
};

const ID_A: &str = "DEVICEAAAAAAAAAA";
const ID_B: &str = "DEVICEBBBBBBBBBB";

fn fresh_signing_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    SigningKey::from_bytes(&bytes)
}

#[test]
fn matching_pin_derives_identical_session_key() {
    let pin = "123456";

    let initiator = start_initiator(pin, ID_A, ID_B).expect("start");
    let s1 = initiator.step1_packet();

    let responder = respond(&s1, pin, ID_A, ID_B).expect("respond");
    let s2 = responder.step2_packet();

    let raw_init = initiator.step3(&s2).expect("step3");
    let raw_resp = responder.raw_keys;

    // Both sides derive the same k1 + k2.
    assert_eq!(raw_init.k1, raw_resp.k1);
    assert_eq!(raw_init.k2, raw_resp.k2);

    // Key-confirmation MAC matches across sides.
    let mac_init = key_confirmation_mac(&raw_init.k2, ID_A, ID_B);
    let mac_resp = key_confirmation_mac(&raw_resp.k2, ID_A, ID_B);
    assert_eq!(mac_init, mac_resp);
}

#[test]
fn mismatched_pin_fails_at_key_confirmation_not_at_pake() {
    let initiator = start_initiator("123456", ID_A, ID_B).expect("start");
    let s1 = initiator.step1_packet();
    // Responder uses a *different* PIN — PAKE itself completes (no error
    // at step3), but k2 silently diverges.
    let responder = respond(&s1, "654321", ID_A, ID_B).expect("respond");
    let s2 = responder.step2_packet();
    let raw_init = initiator.step3(&s2).expect("step3 — PAKE itself does NOT error on wrong PIN");

    // Key confirmation MUST catch the divergence.
    let session = PairingSession::with_clock(Arc::new(TestClock::new(1_700_000_000)));
    session.issue_pin().unwrap();
    let peer_mac = key_confirmation_mac(&responder.raw_keys.k2, ID_A, ID_B);
    let result = finalize_with_confirmation(&raw_init, &peer_mac, &session);
    assert_eq!(result.err(), Some(PairError::KeyConfirmationFailed));

    // Failure must bump the lockout counter.
    assert_eq!(session.failed_count().unwrap(), 1);
}

#[test]
fn pin_expires_after_60_seconds_via_mock_clock() {
    let t0: i64 = 1_700_000_000;
    let clock = Arc::new(TestClock::new(t0));
    let session = PairingSession::with_clock(clock.clone());
    session.issue_pin().unwrap();
    assert!(session.pin_valid().unwrap());

    // Just before expiry → still valid.
    clock.set(t0 + PIN_EXPIRY_SECS - 1);
    assert!(session.pin_valid().unwrap());

    // At 60s → expired.
    clock.set(t0 + PIN_EXPIRY_SECS);
    assert!(!session.pin_valid().unwrap());

    // PinExpired surfaces from finalize_with_confirmation even with a
    // matching MAC.
    let initiator = start_initiator("123456", ID_A, ID_B).unwrap();
    let s1 = initiator.step1_packet();
    let responder = respond(&s1, "123456", ID_A, ID_B).unwrap();
    let s2 = responder.step2_packet();
    let raw = initiator.step3(&s2).unwrap();
    let mac = key_confirmation_mac(&raw.k2, ID_A, ID_B);
    let res = finalize_with_confirmation(&raw, &mac, &session);
    assert_eq!(res.err(), Some(PairError::PinExpired));
}

#[test]
fn three_failed_attempts_locks_out() {
    let session = PairingSession::with_clock(Arc::new(TestClock::new(1_700_000_000)));
    session.issue_pin().unwrap();

    for i in 0..LOCKOUT_AFTER_ATTEMPTS {
        let initiator = start_initiator("123456", ID_A, ID_B).unwrap();
        let s1 = initiator.step1_packet();
        let responder = respond(&s1, "999999", ID_A, ID_B).unwrap();
        let s2 = responder.step2_packet();
        let raw = initiator.step3(&s2).unwrap();
        let bad_mac = key_confirmation_mac(&responder.raw_keys.k2, ID_A, ID_B);
        let res = finalize_with_confirmation(&raw, &bad_mac, &session);
        if i < LOCKOUT_AFTER_ATTEMPTS - 1 {
            assert_eq!(res.err(), Some(PairError::KeyConfirmationFailed));
            assert!(!session.is_locked().unwrap());
        } else {
            // Third strike: still reported as KCF this round, then locked.
            assert_eq!(res.err(), Some(PairError::KeyConfirmationFailed));
            assert!(session.is_locked().unwrap());
        }
    }

    // Subsequent attempts return LockedOut even with a matching MAC.
    let initiator = start_initiator("123456", ID_A, ID_B).unwrap();
    let s1 = initiator.step1_packet();
    let responder = respond(&s1, "123456", ID_A, ID_B).unwrap();
    let s2 = responder.step2_packet();
    let raw = initiator.step3(&s2).unwrap();
    let good_mac = key_confirmation_mac(&raw.k2, ID_A, ID_B);
    let res = finalize_with_confirmation(&raw, &good_mac, &session);
    assert_eq!(res.err(), Some(PairError::LockedOut));
}

#[test]
fn non_six_digit_pin_rejected_before_pake() {
    // App-layer validation: rejected before any PAKE state is allocated.
    assert_eq!(validate_pin("12345"), Err(PairError::InvalidPin));
    assert_eq!(validate_pin("1234567"), Err(PairError::InvalidPin));
    assert_eq!(validate_pin("12345a"), Err(PairError::InvalidPin));
    assert_eq!(validate_pin(""), Err(PairError::InvalidPin));
    assert!(validate_pin("123456").is_ok());

    // start_initiator and respond also enforce the gate at the entry
    // point so a malformed wire frame never reaches PAKE.
    assert_eq!(
        start_initiator("12345", ID_A, ID_B).err(),
        Some(PairError::InvalidPin)
    );
    let dummy_step1 = [0u8; pake_cpace::STEP1_PACKET_BYTES];
    assert_eq!(
        respond(&dummy_step1, "abc", ID_A, ID_B).err(),
        Some(PairError::InvalidPin)
    );
}

#[test]
fn capability_token_verifies_under_owner_key() {
    let owner_key = fresh_signing_key();
    let pubkey = owner_key.verifying_key();

    let body = CapabilityBody::issue_v1(
        "vault-local",
        "peer-device",
        "vault-peer",
        Scope::ReadWrite,
    );
    let cap = Capability::sign(&body, &owner_key);

    let verified = cap.verify(&pubkey).expect("verify under owner key");
    assert_eq!(verified, body);
    // Reserved fields land on the wire in v1 form.
    assert_eq!(verified.format_version, 1);
    assert_eq!(verified.requires_unlock, 0);
    assert!(verified.wrapped_key.is_none());
    assert!(verified.expires_at.is_none());

    // Round-trips through to_bytes / from_bytes.
    let bytes = cap.to_bytes();
    let cap2 = Capability::from_bytes(&bytes).unwrap();
    let verified2 = cap2.verify(&pubkey).unwrap();
    assert_eq!(verified2, body);
}

#[test]
fn capability_token_fails_under_other_key() {
    let owner_key = fresh_signing_key();
    let attacker_key = fresh_signing_key();

    let body = CapabilityBody::issue_v1("v", "p", "vp", Scope::Read);
    let cap = Capability::sign(&body, &owner_key);

    let res = cap.verify(&attacker_key.verifying_key());
    assert!(res.is_err(), "must reject signature from non-owner key");
}
