//! Sync wire format (epic #73).
//!
//! Length-prefixed bincode frames over the Noise-encrypted TCP channel.
//! Each frame is `[u32 BE length][bincode-encoded SyncFrame]`. The
//! length prefix bounds memory allocation — frames over `MAX_FRAME_BYTES`
//! are rejected before allocation.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{ContentHash, PeerId, VaultId, VersionVector};

/// Hard cap on a single frame's payload length. 64 MiB — enough for the
/// largest plausible note (with image embeds) without exposing an OOM
/// avenue on a misbehaving peer.
pub const MAX_FRAME_BYTES: u32 = 64 * 1024 * 1024;

/// Top-level sync protocol message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncFrame {
    /// Per-file change broadcast on a local write or replayed during
    /// catch-up reconciliation.
    Change(ChangeEvent),
    /// Marker emitted around mass-reconciliation pulls so the receiver
    /// can suppress per-file IndexCmd dispatch.
    BatchBegin { vault_id: VaultId },
    BatchEnd { vault_id: VaultId },
    /// Peer identifies itself + presents its capability for a given vault.
    /// Sent immediately after the Noise handshake completes.
    Hello {
        peer_id: PeerId,
        vault_id: VaultId,
        /// Bincode-serialized `Capability` token signed by the vault owner.
        capability_bytes: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub vault_id: VaultId,
    pub path: PathBuf,
    pub kind: ChangeKind,
    pub source_peer: PeerId,
    pub version_vector: VersionVector,
    pub content_hash: ContentHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeKind {
    Upserted { content: Vec<u8> },
    Renamed { from: PathBuf },
    Deleted,
}

/// Bincode-serialize + length-prefix a `SyncFrame`. Used by tests and
/// by the transport sender. Returns `Vec<u8>` rather than writing into
/// a writer so the caller can pipeline frame composition + Noise
/// encryption + socket write independently.
pub fn encode_frame(frame: &SyncFrame) -> Result<Vec<u8>, FrameError> {
    let body = bincode::serialize(frame).map_err(|e| FrameError::Serialize(e.to_string()))?;
    if body.len() as u64 > MAX_FRAME_BYTES as u64 {
        return Err(FrameError::TooLarge {
            len: body.len(),
            cap: MAX_FRAME_BYTES,
        });
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Decode a length-prefixed frame from a single buffer. Caller is
/// responsible for ensuring the buffer holds a complete frame (the
/// transport read loop refills it as needed).
pub fn decode_frame(buf: &[u8]) -> Result<(SyncFrame, usize), FrameError> {
    if buf.len() < 4 {
        return Err(FrameError::Short);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            len: len as usize,
            cap: MAX_FRAME_BYTES,
        });
    }
    let total = 4 + len as usize;
    if buf.len() < total {
        return Err(FrameError::Short);
    }
    let frame: SyncFrame = bincode::deserialize(&buf[4..total])
        .map_err(|e| FrameError::Deserialize(e.to_string()))?;
    Ok((frame, total))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Buffer doesn't contain a complete frame yet — caller should read more.
    Short,
    /// Frame announces a length over `MAX_FRAME_BYTES`.
    TooLarge { len: usize, cap: u32 },
    Serialize(String),
    Deserialize(String),
}
