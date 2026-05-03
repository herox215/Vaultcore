//! Post-PAKE pairing driver (epic #73, UI-1.5).
//!
//! `pairing.rs` ends at "both sides agree on `k1`/`k2` and a key-confirmation
//! MAC matches". This module picks up there:
//!
//! 1. **Noise XX bootstrap.** Each side opens a Noise XX channel using its
//!    Curve25519 noise static (held separately from the Ed25519 long-term
//!    identity — Noise is happier with native Curve25519 keys).
//! 2. **Long-term key attestation.** Inside the encrypted channel, each
//!    side sends `(ed25519_pubkey, HMAC-SHA256(k2, ed25519_pubkey))`. The
//!    HMAC under the just-derived PAKE session key is what binds the
//!    long-term identity to *this* pairing flow — without it a network
//!    attacker who could MITM Noise (impossible without the static keys
//!    they don't yet have, but defensive depth) couldn't substitute their
//!    own Ed25519 key. After verification the peer's pubkey is persisted
//!    via `state.upsert_peer(.., PeerTrust::Trusted)`.
//! 3. **Vault grant exchange.** Optional follow-up step (separate entry
//!    points). Each side sends a peer-self-signed `Capability` for a
//!    chosen vault and stores the *peer's* signed cap on its DB. Body
//!    layout matches `engine_tests::pair_peer_with_grant`: the issuer's
//!    cap names the issuer's own device id in `peer_device_id`, signed
//!    by the issuer's long-term key.
//!
//! ## Wire format (engine-internal, post-Noise-handshake)
//!
//! Noise messages on the wire are u16-length-prefixed, identical to
//! `transport.rs::drive_handshake`. The plaintext payload of each Noise
//! message is a bincode-serialized `EngineFrame`. We do **not** layer a
//! frame-length prefix on top — engine frames are tiny (≤ 200 bytes) and
//! always fit in one Noise message.
//!
//! ## Re-pair short-circuit
//!
//! If the local DB already has a `Trusted` row for the peer's device id
//! whose stored Ed25519 pubkey matches what the peer attested, we skip
//! the upsert (the row is already correct) and return
//! `PairingOutcome { short_circuited: true, reason: Some("already-paired") }`.
//! UI-3 surfaces this as the "one-tap re-grant" code path.

use std::io::{Read, Write};
use std::net::TcpStream;

use ed25519_dalek::SigningKey;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use snow::TransportState;

use crate::error::VaultError;

use super::capability::{Capability, CapabilityBody};
use super::state::{PeerTrust, SyncState};
use super::transport::{drive_handshake, xx_initiator, xx_responder, NoiseKeypair, TransportError};

type HmacSha256 = Hmac<Sha256>;

/// Reason string returned in `PairingOutcome::reason` when the engine
/// detects the peer is already trusted with a matching pubkey and
/// short-circuits the trust upsert. UI-3 keys its "already paired"
/// banner off this constant.
pub const ALREADY_PAIRED: &str = "already-paired";

/// Engine-internal protocol frames. Sent over the Noise XX channel,
/// bincode-serialized into the plaintext of a single Noise message.
#[derive(Debug, Clone, Serialize, Deserialize)]
enum EngineFrame {
    /// Long-term Ed25519 pubkey + HMAC-SHA256(k2, pubkey). The HMAC under
    /// the PAKE-derived session key proves the sender knew the PIN.
    LongTermAttest {
        ed25519_pubkey: [u8; 32],
        mac: [u8; 32],
    },
    /// Peer-self-signed capability — `body.peer_device_id` is the issuer's
    /// own device id and `signature` is over `body` under the issuer's
    /// Ed25519 key.
    VaultGrant { capability_bytes: Vec<u8> },
}

/// What the caller gets back from the post-PAKE driver.
#[derive(Debug, Clone)]
pub struct PairingOutcome {
    /// True iff the engine detected an existing trusted peer row with a
    /// matching pubkey and skipped the upsert. UI surfaces a different
    /// confirmation copy when this fires.
    pub short_circuited: bool,
    /// Optional machine-readable reason — `Some("already-paired")` when
    /// `short_circuited`, `None` otherwise.
    pub reason: Option<String>,
}

/// Carries the post-bootstrap encrypted state forward so the caller can
/// continue using the channel for grant exchange (or, in the production
/// path, hand it off to the sync engine for the first sync). `outcome`
/// reports whether trust persistence ran or short-circuited.
#[derive(Debug)]
pub struct PostPairingSession {
    pub stream: TcpStream,
    pub transport: TransportState,
    pub outcome: PairingOutcome,
}

impl PostPairingSession {
    /// Convenience: forwards `outcome.short_circuited` so call sites that
    /// only care about the re-pair flag don't have to dig.
    pub fn short_circuited(&self) -> bool {
        self.outcome.short_circuited
    }
}

impl std::ops::Deref for PostPairingSession {
    type Target = PairingOutcome;
    fn deref(&self) -> &Self::Target {
        &self.outcome
    }
}

#[derive(Debug)]
pub enum PairingEngineError {
    Io(std::io::Error),
    Transport(TransportError),
    /// Peer's HMAC over its long-term key didn't verify under our `k2`.
    /// Pairing must abort — either the network was tampered or the peer
    /// derived a different `k2` (PIN mismatch).
    AttestationMismatch,
    /// Peer's vault-grant capability didn't verify under the long-term
    /// key we just persisted for them.
    GrantVerification(String),
    /// Local DB write failed. Wrap rather than `From<VaultError>` so the
    /// caller can pattern-match the engine-specific failure modes
    /// distinct from "DB went away".
    State(VaultError),
    /// Engine frame serialization / decoding failure — only fires on
    /// genuinely corrupt wire input.
    Codec(String),
}

impl From<std::io::Error> for PairingEngineError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<TransportError> for PairingEngineError {
    fn from(e: TransportError) -> Self {
        Self::Transport(e)
    }
}
impl From<VaultError> for PairingEngineError {
    fn from(e: VaultError) -> Self {
        Self::State(e)
    }
}

// ─── Noise message I/O ────────────────────────────────────────────────────

const NOISE_MAX_MSG: usize = 65535;

fn send_engine_frame(
    stream: &mut TcpStream,
    state: &mut TransportState,
    frame: &EngineFrame,
) -> Result<(), PairingEngineError> {
    let body = bincode::serialize(frame)
        .map_err(|e| PairingEngineError::Codec(format!("encode: {e}")))?;
    if body.len() > NOISE_MAX_MSG - 16 {
        // Engine frames are tiny in v1 — overflow here is a programming bug.
        return Err(PairingEngineError::Codec(format!(
            "engine frame too large: {} bytes",
            body.len()
        )));
    }
    let mut ct = [0u8; NOISE_MAX_MSG];
    let n = state
        .write_message(&body, &mut ct)
        .map_err(TransportError::Noise)?;
    stream.write_all(&(n as u16).to_be_bytes())?;
    stream.write_all(&ct[..n])?;
    Ok(())
}

fn recv_engine_frame(
    stream: &mut TcpStream,
    state: &mut TransportState,
) -> Result<EngineFrame, PairingEngineError> {
    let mut len_buf = [0u8; 2];
    stream.read_exact(&mut len_buf)?;
    let n = u16::from_be_bytes(len_buf) as usize;
    let mut ct = vec![0u8; n];
    stream.read_exact(&mut ct)?;
    let mut pt = [0u8; NOISE_MAX_MSG];
    let plain_len = state
        .read_message(&ct, &mut pt)
        .map_err(TransportError::Noise)?;
    let frame: EngineFrame = bincode::deserialize(&pt[..plain_len])
        .map_err(|e| PairingEngineError::Codec(format!("decode: {e}")))?;
    Ok(frame)
}

// ─── Long-term key attestation ────────────────────────────────────────────

fn long_term_attest_mac(k2: &[u8; 32], ed25519_pubkey: &[u8; 32]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(k2).expect("HMAC accepts any key length");
    mac.update(ed25519_pubkey);
    let out = mac.finalize().into_bytes();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    buf
}

/// Constant-time byte slice equality. Same routine as `pairing.rs::ct_eq`
/// — duplicated rather than crossing the module boundary because this
/// single use isn't worth a `pub(crate)` carve-out on a security-relevant
/// helper. The cost (32-byte XOR) is negligible.
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

/// Persist the peer's pubkey + name under `PeerTrust::Trusted`. If the
/// stored row already names this peer with the *same* pubkey, the upsert
/// is a no-op and we report `short_circuited = true` so the UI can render
/// the "already paired — re-grant" path.
fn persist_peer_trust(
    state: &SyncState,
    peer_device_id: &str,
    peer_pubkey: &[u8; 32],
    display_name: &str,
) -> Result<PairingOutcome, VaultError> {
    if let Some(existing) = state.peer_pubkey(peer_device_id)? {
        if ct_eq(&existing, peer_pubkey) {
            return Ok(PairingOutcome {
                short_circuited: true,
                reason: Some(ALREADY_PAIRED.to_string()),
            });
        }
    }
    state.upsert_peer(peer_device_id, peer_pubkey, display_name, PeerTrust::Trusted)?;
    Ok(PairingOutcome {
        short_circuited: false,
        reason: None,
    })
}

// ─── Public entry points ──────────────────────────────────────────────────

/// Initiator side — runs Noise XX as the dialing peer, then exchanges
/// long-term key attestations. Returns the live `PostPairingSession` so
/// the caller can continue with vault-grant exchange or sync.
///
/// `peer_device_id` is the responder's device id, learned from the
/// pairing flow's PAKE step (each side already has it as part of `id_a`/
/// `id_b`).
pub fn drive_initiator_after_pake(
    stream: &mut TcpStream,
    noise_kp: &NoiseKeypair,
    signing_key: &SigningKey,
    self_device_id: &str,
    peer_device_id: &str,
    k2: &[u8; 32],
    state: &SyncState,
) -> Result<PostPairingSession, PairingEngineError> {
    let hs = xx_initiator(&noise_kp.private)?;
    let (mut transport, _remote_static) = drive_handshake(hs, stream, true)?;

    let outcome = exchange_attestations(
        stream,
        &mut transport,
        signing_key,
        self_device_id,
        peer_device_id,
        k2,
        state,
    )?;
    Ok(PostPairingSession {
        stream: stream.try_clone()?,
        transport,
        outcome,
    })
}

/// Responder side — accepts Noise XX as the listening peer.
pub fn drive_responder_after_pake(
    stream: &mut TcpStream,
    noise_kp: &NoiseKeypair,
    signing_key: &SigningKey,
    self_device_id: &str,
    peer_device_id: &str,
    k2: &[u8; 32],
    state: &SyncState,
) -> Result<PostPairingSession, PairingEngineError> {
    let hs = xx_responder(&noise_kp.private)?;
    let (mut transport, _remote_static) = drive_handshake(hs, stream, false)?;

    let outcome = exchange_attestations(
        stream,
        &mut transport,
        signing_key,
        self_device_id,
        peer_device_id,
        k2,
        state,
    )?;
    Ok(PostPairingSession {
        stream: stream.try_clone()?,
        transport,
        outcome,
    })
}

/// Send our attestation, receive theirs, verify, persist. Mirrors on
/// both sides — the order (send-then-recv) is symmetric over a duplex
/// Noise channel: the snow `TransportState` API allows interleaved
/// read_message / write_message because XX is fully bidirectional once
/// finished. Initiator sends first, responder reads first; we mirror by
/// always sending then reading on both sides — Noise tracks send/recv
/// counters separately so neither blocks the other on a fresh transport.
fn exchange_attestations(
    stream: &mut TcpStream,
    transport: &mut TransportState,
    signing_key: &SigningKey,
    self_device_id: &str,
    peer_device_id: &str,
    k2: &[u8; 32],
    state: &SyncState,
) -> Result<PairingOutcome, PairingEngineError> {
    // Build + send our attestation.
    let our_pk = signing_key.verifying_key().to_bytes();
    let our_mac = long_term_attest_mac(k2, &our_pk);
    send_engine_frame(
        stream,
        transport,
        &EngineFrame::LongTermAttest {
            ed25519_pubkey: our_pk,
            mac: our_mac,
        },
    )?;

    // Receive + verify the peer's.
    let frame = recv_engine_frame(stream, transport)?;
    let (peer_pk, peer_mac) = match frame {
        EngineFrame::LongTermAttest {
            ed25519_pubkey,
            mac,
        } => (ed25519_pubkey, mac),
        _ => {
            return Err(PairingEngineError::Codec(
                "expected LongTermAttest as first engine frame".into(),
            ))
        }
    };
    let expected = long_term_attest_mac(k2, &peer_pk);
    if !ct_eq(&expected, &peer_mac) {
        return Err(PairingEngineError::AttestationMismatch);
    }

    let display_name = format!("Peer {peer_device_id}");
    let outcome = persist_peer_trust(state, peer_device_id, &peer_pk, &display_name)?;
    let _ = self_device_id; // bound for symmetry with future log instrumentation.
    Ok(outcome)
}

/// Initiator-side vault grant exchange. Sends our peer-self-signed cap
/// for `body`, then receives + verifies the peer's. Body must already
/// have `body.peer_device_id == self_device_id` (the issuer's id), per
/// the engine_tests::pair_peer_with_grant convention — we sanity-check
/// it before signing so a caller that swapped the field doesn't ship
/// a mis-bound cap to disk.
pub fn exchange_vault_grant_initiator(
    session: &mut PostPairingSession,
    signing_key: &SigningKey,
    body: &CapabilityBody,
    peer_device_id: &str,
    state: &SyncState,
) -> Result<(), PairingEngineError> {
    do_grant_exchange(session, signing_key, body, peer_device_id, state, true)
}

/// Responder-side vault grant exchange. Receives the peer's grant first,
/// then sends ours. Reading first on the responder side mirrors the
/// initiator's send-first ordering and avoids a head-of-line block where
/// both sides are simultaneously trying to write before reading.
pub fn exchange_vault_grant_responder(
    session: &mut PostPairingSession,
    signing_key: &SigningKey,
    body: &CapabilityBody,
    peer_device_id: &str,
    state: &SyncState,
) -> Result<(), PairingEngineError> {
    do_grant_exchange(session, signing_key, body, peer_device_id, state, false)
}

fn do_grant_exchange(
    session: &mut PostPairingSession,
    signing_key: &SigningKey,
    body: &CapabilityBody,
    peer_device_id: &str,
    state: &SyncState,
    initiator: bool,
) -> Result<(), PairingEngineError> {
    // Sign our cap. body.peer_device_id is the *issuer's* own device id —
    // we don't bind that here (the caller asserts it), but we'll fail
    // verify() loud and clear if it's wrong.
    let cap = Capability::sign(body, signing_key);

    if initiator {
        send_engine_frame(
            &mut session.stream,
            &mut session.transport,
            &EngineFrame::VaultGrant {
                capability_bytes: cap.to_bytes(),
            },
        )?;
        let frame = recv_engine_frame(&mut session.stream, &mut session.transport)?;
        receive_grant(state, peer_device_id, frame)?;
    } else {
        let frame = recv_engine_frame(&mut session.stream, &mut session.transport)?;
        receive_grant(state, peer_device_id, frame)?;
        send_engine_frame(
            &mut session.stream,
            &mut session.transport,
            &EngineFrame::VaultGrant {
                capability_bytes: cap.to_bytes(),
            },
        )?;
    }
    Ok(())
}

fn receive_grant(
    state: &SyncState,
    peer_device_id: &str,
    frame: EngineFrame,
) -> Result<(), PairingEngineError> {
    let cap_bytes = match frame {
        EngineFrame::VaultGrant { capability_bytes } => capability_bytes,
        _ => {
            return Err(PairingEngineError::Codec(
                "expected VaultGrant frame in grant phase".into(),
            ))
        }
    };
    let cap = Capability::from_bytes(&cap_bytes)?;

    // Verify under the peer's pubkey we just persisted. If the peer wasn't
    // persisted (caller skipped attestation step), peer_pubkey returns
    // None and we reject — fail closed.
    let peer_pk_bytes = state.peer_pubkey(peer_device_id)?.ok_or_else(|| {
        PairingEngineError::GrantVerification(format!(
            "peer {peer_device_id} not trusted; cannot accept grant"
        ))
    })?;
    let peer_vk = ed25519_dalek::VerifyingKey::from_bytes(&peer_pk_bytes).map_err(|e| {
        PairingEngineError::GrantVerification(format!("decode peer pubkey: {e}"))
    })?;
    let body = cap
        .verify(&peer_vk)
        .map_err(|e| PairingEngineError::GrantVerification(format!("{e:?}")))?;
    // The cap's `peer_device_id` field carries the *issuer's* own id by
    // engine_tests::pair_peer_with_grant convention — assert it here so
    // a misbound cap is caught at trust-store time rather than silently
    // rotting until first sync.
    if body.peer_device_id != peer_device_id {
        return Err(PairingEngineError::GrantVerification(format!(
            "cap.peer_device_id {} != expected issuer id {}",
            body.peer_device_id, peer_device_id
        )));
    }
    state.upsert_vault_grant(&cap)?;
    Ok(())
}
