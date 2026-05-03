//! Noise-encrypted transport for sync (epic #73).
//!
//! Two patterns:
//!   - **XX (bootstrap):** first sync after pairing. Exchanges static
//!     keys mutually so each side learns the other's long-term Noise
//!     static — equivalent to the long-term Ed25519 key in spirit, but
//!     a separate Curve25519 key (Noise's primitives). After XX,
//!     persisted peer record gains the static key.
//!   - **IK (steady-state):** subsequent connections. Initiator already
//!     knows responder's static key (from the XX bootstrap), so the
//!     handshake is one-shot.
//!
//! Cipher suite: `Noise_*_25519_ChaChaPoly_SHA256` per epic #73.
//!
//! Framing: each Noise message body is itself a length-prefixed bincode
//! `SyncFrame`. Noise messages over the wire carry a u16 length prefix
//! (Noise's per-message limit is 65535 bytes), and we chunk frame bodies
//! larger than that across multiple Noise messages on send / reassemble
//! on receive. Header is `[u32 BE total_frame_len][...payload...]`,
//! identical to `protocol::encode_frame`.

use std::io::{Read, Write};
use std::net::TcpStream;

use snow::{HandshakeState, TransportState};

use super::protocol::{FrameError, SyncFrame, MAX_FRAME_BYTES};

const PATTERN_XX: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
const PATTERN_IK: &str = "Noise_IK_25519_ChaChaPoly_SHA256";

/// Noise's per-message hard limit. We chunk longer payloads.
const NOISE_MAX_MSG: usize = 65535;
/// Noise auth tag overhead per message (ChaChaPoly = 16 bytes).
const NOISE_TAG_LEN: usize = 16;
/// Plaintext budget per Noise message after the auth tag.
const NOISE_PT_BUDGET: usize = NOISE_MAX_MSG - NOISE_TAG_LEN;

#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    Noise(snow::Error),
    Frame(FrameError),
    /// Protocol violation: frame too large to chunk reasonably.
    FrameTooLarge,
    /// Peer disconnected mid-handshake or mid-frame.
    UnexpectedClose,
}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e)
    }
}
impl From<snow::Error> for TransportError {
    fn from(e: snow::Error) -> Self {
        TransportError::Noise(e)
    }
}
impl From<FrameError> for TransportError {
    fn from(e: FrameError) -> Self {
        TransportError::Frame(e)
    }
}

/// Generate a fresh Curve25519 keypair (32-byte private + 32-byte public).
/// Used at sync-engine startup to mint a per-install Noise static key.
/// Held separately from the Ed25519 device key — Noise wants Curve25519
/// natively and converting Ed25519 ↔ X25519 is a footgun we sidestep.
pub fn generate_static_keypair() -> Result<NoiseKeypair, TransportError> {
    let builder = snow::Builder::new(PATTERN_XX.parse()?);
    let kp = builder.generate_keypair()?;
    Ok(NoiseKeypair {
        private: kp.private,
        public: kp.public,
    })
}

#[derive(Debug, Clone)]
pub struct NoiseKeypair {
    pub private: Vec<u8>,
    pub public: Vec<u8>,
}

// ─── Handshake builders ───────────────────────────────────────────────

pub fn xx_initiator(local_static: &[u8]) -> Result<HandshakeState, TransportError> {
    Ok(snow::Builder::new(PATTERN_XX.parse()?)
        .local_private_key(local_static)
        .build_initiator()?)
}

pub fn xx_responder(local_static: &[u8]) -> Result<HandshakeState, TransportError> {
    Ok(snow::Builder::new(PATTERN_XX.parse()?)
        .local_private_key(local_static)
        .build_responder()?)
}

pub fn ik_initiator(
    local_static: &[u8],
    remote_static: &[u8],
) -> Result<HandshakeState, TransportError> {
    Ok(snow::Builder::new(PATTERN_IK.parse()?)
        .local_private_key(local_static)
        .remote_public_key(remote_static)
        .build_initiator()?)
}

pub fn ik_responder(local_static: &[u8]) -> Result<HandshakeState, TransportError> {
    Ok(snow::Builder::new(PATTERN_IK.parse()?)
        .local_private_key(local_static)
        .build_responder()?)
}

// ─── Synchronous TCP handshake driver ──────────────────────────────────

/// Drive a Noise handshake to completion over a `TcpStream`. Each Noise
/// message is u16-length-prefixed on the wire (length excludes the
/// prefix itself).
///
/// Caller passes a fresh `HandshakeState` from one of the builders above.
/// Returns the resulting `TransportState` (encryption-only state) plus
/// the remote's static public key (`Some` for XX, the responder side
/// already holds it for IK initiator).
pub fn drive_handshake(
    mut hs: HandshakeState,
    stream: &mut TcpStream,
    is_initiator: bool,
) -> Result<(TransportState, Option<Vec<u8>>), TransportError> {
    let mut buf = [0u8; NOISE_MAX_MSG];
    // Pattern step counter: initiator writes first.
    let mut my_turn = is_initiator;
    while !hs.is_handshake_finished() {
        if my_turn {
            let len = hs.write_message(&[], &mut buf)?;
            write_noise_msg(stream, &buf[..len])?;
        } else {
            let msg = read_noise_msg(stream)?;
            let mut scratch = [0u8; NOISE_MAX_MSG];
            hs.read_message(&msg, &mut scratch)?;
        }
        my_turn = !my_turn;
    }
    let remote_static = hs.get_remote_static().map(|s| s.to_vec());
    let ts = hs.into_transport_mode()?;
    Ok((ts, remote_static))
}

fn write_noise_msg(stream: &mut TcpStream, msg: &[u8]) -> Result<(), TransportError> {
    if msg.len() > NOISE_MAX_MSG {
        return Err(TransportError::FrameTooLarge);
    }
    stream.write_all(&(msg.len() as u16).to_be_bytes())?;
    stream.write_all(msg)?;
    Ok(())
}

fn read_noise_msg(stream: &mut TcpStream) -> Result<Vec<u8>, TransportError> {
    let mut len_buf = [0u8; 2];
    read_exact_or_close(stream, &mut len_buf)?;
    let len = u16::from_be_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    read_exact_or_close(stream, &mut body)?;
    Ok(body)
}

fn read_exact_or_close(stream: &mut TcpStream, out: &mut [u8]) -> Result<(), TransportError> {
    match stream.read_exact(out) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(TransportError::UnexpectedClose)
        }
        Err(e) => Err(TransportError::Io(e)),
    }
}

// ─── Encrypted frame channel ──────────────────────────────────────────

/// Wraps a Noise `TransportState` + `TcpStream` into a `SyncFrame`-level
/// I/O channel. Each frame is bincode-encoded + chunked across as many
/// Noise messages as needed.
pub struct EncryptedChannel {
    pub stream: TcpStream,
    pub state: TransportState,
}

impl EncryptedChannel {
    /// Encrypt + send a `SyncFrame`. Frames over `MAX_FRAME_BYTES` are
    /// rejected at the framing layer.
    ///
    /// On the wire each frame is `[u32 BE bincode_len][noise_chunks...]`,
    /// where each chunk is `[u16 BE n][ciphertext n bytes]`. The plaintext
    /// across the chunks reassembles to the bincode-encoded `SyncFrame`
    /// payload — no `protocol::encode_frame` length prefix is included
    /// (the outer u32 already gives the receiver the total length).
    pub fn send(&mut self, frame: &SyncFrame) -> Result<(), TransportError> {
        let body = bincode::serialize(frame).map_err(|e| {
            super::protocol::FrameError::Serialize(e.to_string())
        })?;
        if body.len() as u64 > MAX_FRAME_BYTES as u64 {
            return Err(TransportError::FrameTooLarge);
        }
        self.stream.write_all(&(body.len() as u32).to_be_bytes())?;
        let mut offset = 0;
        let mut ct = [0u8; NOISE_MAX_MSG];
        while offset < body.len() {
            let take = (body.len() - offset).min(NOISE_PT_BUDGET);
            let n = self.state.write_message(&body[offset..offset + take], &mut ct)?;
            self.stream.write_all(&(n as u16).to_be_bytes())?;
            self.stream.write_all(&ct[..n])?;
            offset += take;
        }
        Ok(())
    }

    /// Read + decrypt the next `SyncFrame`. Blocks until the full frame
    /// is on the wire.
    pub fn recv(&mut self) -> Result<SyncFrame, TransportError> {
        let mut len_buf = [0u8; 4];
        read_exact_or_close(&mut self.stream, &mut len_buf)?;
        let total = u32::from_be_bytes(len_buf);
        if total > MAX_FRAME_BYTES {
            return Err(TransportError::FrameTooLarge);
        }
        let mut body = Vec::with_capacity(total as usize);
        let mut pt = [0u8; NOISE_MAX_MSG];
        while body.len() < total as usize {
            let mut n_buf = [0u8; 2];
            read_exact_or_close(&mut self.stream, &mut n_buf)?;
            let n = u16::from_be_bytes(n_buf) as usize;
            let mut ct = vec![0u8; n];
            read_exact_or_close(&mut self.stream, &mut ct)?;
            let plain_len = self.state.read_message(&ct, &mut pt)?;
            body.extend_from_slice(&pt[..plain_len]);
        }
        let frame: SyncFrame = bincode::deserialize(&body).map_err(|e| {
            super::protocol::FrameError::Deserialize(e.to_string())
        })?;
        Ok(frame)
    }
}
