//! PAKE-based device pairing (epic #73 sub-issue #418).
//!
//! Flow per epic and the A2 design note:
//!
//! 1. UI gates: PIN must be 6-digit numeric. Enforced *before* PAKE
//!    because CPace accepts arbitrary input.
//! 2. PAKE three-step. Initiator runs `start_initiator` → step1 packet.
//!    Responder runs `respond` → step2 packet + provisional keys.
//!    Initiator runs `step3` on the step2 packet → final keys.
//! 3. **Key-confirmation (REQUIRED).** Each side computes
//!    `HMAC-SHA256(k2, device_id_a || device_id_b)` and exchanges.
//!    Mismatch → abort + bump lockout. PAKE itself does NOT error on
//!    wrong PIN (keys silently diverge), so without this we'd accept
//!    nonsense session keys.
//!
//! State store: `PairingSession` holds attempt counters + an injectable
//! clock for the 60s expiry / 3-attempt lockout.

use std::sync::{Arc, Mutex};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::error::VaultError;

use super::clock::{Clock, SystemClock};

/// 6-digit numeric PIN. Required by epic — enforced before PAKE.
pub const PIN_LEN: usize = 6;
/// PIN expires 60s after creation.
pub const PIN_EXPIRY_SECS: i64 = 60;
/// Lockout after this many consecutive failed key-confirmations.
pub const LOCKOUT_AFTER_ATTEMPTS: u32 = 3;

type HmacSha256 = Hmac<Sha256>;

/// Reasons pairing can fail. Each maps to a distinct UI copy — the
/// frontend renders "wrong PIN" vs "PIN expired" vs "locked out, wait
/// 60s" differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    InvalidPin,
    PinExpired,
    LockedOut,
    PakeFailed(String),
    KeyConfirmationFailed,
}

impl From<PairError> for VaultError {
    fn from(e: PairError) -> Self {
        VaultError::SyncState {
            msg: format!("pairing: {e:?}"),
        }
    }
}

/// PAKE shared keys after a successful run + key-confirmation. `k1` is
/// reserved for the long-term-key exchange step; `k2` is consumed by
/// the key-confirmation MAC and must NOT be reused after that.
#[derive(Debug, Clone, Copy)]
pub struct ConfirmedKeys {
    pub k1: [u8; 32],
}

/// Session-state for a pairing attempt. Carries the lockout counter +
/// PIN issue time so the same session can re-prompt for the PIN within
/// the 60s window without re-running PAKE wire setup.
pub struct PairingSession {
    /// Wall-time (seconds since epoch) at which the current PIN was issued.
    pin_issued_at: Mutex<Option<i64>>,
    /// Failed-attempt counter. Reset on success, frozen after lockout.
    failed_attempts: Mutex<u32>,
    /// Whether the session is locked out. Once true, no further attempts
    /// are accepted on this session — the user must restart pairing.
    locked: Mutex<bool>,
    clock: Arc<dyn Clock>,
}

impl PairingSession {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            pin_issued_at: Mutex::new(None),
            failed_attempts: Mutex::new(0),
            locked: Mutex::new(false),
            clock,
        }
    }

    /// Mark a fresh PIN as issued *now*. Resets the expiry timer; does
    /// NOT clear the lockout counter (a locked-out session stays locked
    /// even if the operator regenerates the PIN — they must restart).
    pub fn issue_pin(&self) -> Result<(), VaultError> {
        if *self.locked.lock().map_err(|_| VaultError::LockPoisoned)? {
            return Err(PairError::LockedOut.into());
        }
        *self.pin_issued_at.lock().map_err(|_| VaultError::LockPoisoned)? =
            Some(self.clock.now_secs());
        Ok(())
    }

    /// True iff the most recently issued PIN is still within its 60s window.
    pub fn pin_valid(&self) -> Result<bool, VaultError> {
        let issued = *self.pin_issued_at.lock().map_err(|_| VaultError::LockPoisoned)?;
        Ok(match issued {
            None => false,
            Some(t) => self.clock.now_secs() - t < PIN_EXPIRY_SECS,
        })
    }

    pub fn is_locked(&self) -> Result<bool, VaultError> {
        Ok(*self.locked.lock().map_err(|_| VaultError::LockPoisoned)?)
    }

    pub fn failed_count(&self) -> Result<u32, VaultError> {
        Ok(*self
            .failed_attempts
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?)
    }

    fn record_failure(&self) -> Result<u32, VaultError> {
        let mut g = self
            .failed_attempts
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        *g += 1;
        let n = *g;
        drop(g);
        if n >= LOCKOUT_AFTER_ATTEMPTS {
            *self.locked.lock().map_err(|_| VaultError::LockPoisoned)? = true;
        }
        Ok(n)
    }

    fn clear_on_success(&self) -> Result<(), VaultError> {
        *self
            .failed_attempts
            .lock()
            .map_err(|_| VaultError::LockPoisoned)? = 0;
        Ok(())
    }
}

impl Default for PairingSession {
    fn default() -> Self {
        Self::new()
    }
}

/// PIN sanity check — must be exactly 6 ASCII digits. Runs *before*
/// PAKE because CPace accepts arbitrary input (including empty) and
/// would silently produce a session key for any of them.
pub fn validate_pin(pin: &str) -> Result<(), PairError> {
    if pin.len() != PIN_LEN {
        return Err(PairError::InvalidPin);
    }
    if !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(PairError::InvalidPin);
    }
    Ok(())
}

// ─── PAKE three-step wrappers ──────────────────────────────────────────

/// Initiator side, post-step1. Holds the CPace state internally so the
/// caller doesn't have to thread the inner type around.
pub struct InitiatorAfterStep1 {
    inner: pake_cpace::Step1Out,
    id_a: String,
    id_b: String,
}

impl InitiatorAfterStep1 {
    pub fn step1_packet(&self) -> [u8; pake_cpace::STEP1_PACKET_BYTES] {
        self.inner.packet()
    }

    /// Finish PAKE on the initiator side using the responder's step2 packet.
    /// Returns the raw shared keys — caller MUST run [`key_confirmation`]
    /// before trusting them.
    pub fn step3(
        self,
        step2_packet: &[u8; pake_cpace::STEP2_PACKET_BYTES],
    ) -> Result<RawSharedKeys, PairError> {
        let sk = self
            .inner
            .step3(step2_packet)
            .map_err(|e| PairError::PakeFailed(format!("{e:?}")))?;
        Ok(RawSharedKeys {
            k1: sk.k1,
            k2: sk.k2,
            id_a: self.id_a,
            id_b: self.id_b,
        })
    }
}

/// Responder side after step2. Carries provisional shared keys; caller
/// MUST run [`key_confirmation`] before trusting them.
pub struct ResponderAfterStep2 {
    pub raw_keys: RawSharedKeys,
    step2_packet: [u8; pake_cpace::STEP2_PACKET_BYTES],
}

impl ResponderAfterStep2 {
    pub fn step2_packet(&self) -> [u8; pake_cpace::STEP2_PACKET_BYTES] {
        self.step2_packet
    }
}

/// Raw PAKE output — *not* trusted until key-confirmation succeeds.
pub struct RawSharedKeys {
    pub k1: [u8; 32],
    pub k2: [u8; 32],
    pub id_a: String,
    pub id_b: String,
}

/// Initiator side: send the PIN, the long-form id strings, and our
/// device_id.
pub fn start_initiator(
    pin: &str,
    id_a: &str,
    id_b: &str,
) -> Result<InitiatorAfterStep1, PairError> {
    validate_pin(pin)?;
    let s1 = pake_cpace::CPace::step1::<&[u8]>(pin, id_a, id_b, None)
        .map_err(|e| PairError::PakeFailed(format!("{e:?}")))?;
    Ok(InitiatorAfterStep1 {
        inner: s1,
        id_a: id_a.to_string(),
        id_b: id_b.to_string(),
    })
}

/// Responder side: ingest step1 + return step2 packet + provisional keys.
pub fn respond(
    step1_packet: &[u8; pake_cpace::STEP1_PACKET_BYTES],
    pin: &str,
    id_a: &str,
    id_b: &str,
) -> Result<ResponderAfterStep2, PairError> {
    validate_pin(pin)?;
    let s2 = pake_cpace::CPace::step2::<&[u8]>(step1_packet, pin, id_a, id_b, None)
        .map_err(|e| PairError::PakeFailed(format!("{e:?}")))?;
    let sk = s2.shared_keys();
    Ok(ResponderAfterStep2 {
        raw_keys: RawSharedKeys {
            k1: sk.k1,
            k2: sk.k2,
            id_a: id_a.to_string(),
            id_b: id_b.to_string(),
        },
        step2_packet: s2.packet(),
    })
}

// ─── Key confirmation ──────────────────────────────────────────────────

/// `HMAC-SHA256(k2, device_id_a || device_id_b)` per the epic's A2
/// design note. PAKE itself does NOT error on wrong PIN — keys silently
/// diverge. Both sides compute this MAC and exchange; mismatch ⇒ abort
/// and bump the lockout counter.
pub fn key_confirmation_mac(k2: &[u8; 32], id_a: &str, id_b: &str) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(k2).expect("HMAC accepts any key length");
    mac.update(id_a.as_bytes());
    mac.update(id_b.as_bytes());
    let out = mac.finalize().into_bytes();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    buf
}

/// Check the peer's MAC against our locally-computed one. Constant-time
/// compare via `subtle` (transitive dep through ed25519-dalek). On
/// mismatch the caller MUST `record_failure` on the session.
///
/// Returns the *confirmed* k1 on success — k2 has been consumed by the
/// MAC step and must not be reused.
pub fn finalize_with_confirmation(
    raw: &RawSharedKeys,
    peer_mac: &[u8; 32],
    session: &PairingSession,
) -> Result<ConfirmedKeys, PairError> {
    if session.is_locked().map_err(|_| PairError::LockedOut)? {
        return Err(PairError::LockedOut);
    }
    if !session.pin_valid().map_err(|_| PairError::PinExpired)? {
        return Err(PairError::PinExpired);
    }
    let local_mac = key_confirmation_mac(&raw.k2, &raw.id_a, &raw.id_b);
    if !ct_eq(&local_mac, peer_mac) {
        let _ = session.record_failure();
        return Err(PairError::KeyConfirmationFailed);
    }
    let _ = session.clear_on_success();
    Ok(ConfirmedKeys { k1: raw.k1 })
}

/// Constant-time byte slice equality. Avoids leaking timing info on the
/// MAC compare.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
