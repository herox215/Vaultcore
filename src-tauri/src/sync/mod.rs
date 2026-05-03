//! LAN P2P sync layer (epic #73).
//!
//! Module map:
//!   state.rs       — sync-state.sqlite schema + migrations + apply/record APIs
//!   history.rs     — content-addressed last-2-versions LRU history blob store
//!   tombstone.rs   — 30-day TTL deletion records + GC
//!   clock.rs       — injectable wall clock for time-dependent tests
//!
//! Wire-format types (`PeerId`, `VaultId`, `VersionVector`, `ContentHash`)
//! live in this module so identity / pairing / transport sub-modules can
//! depend on them without circular references.

pub mod clock;
pub mod history;
pub mod state;
pub mod tombstone;

#[cfg(test)]
pub mod tests;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Stable per-device identifier — `base32(SHA-256(ed25519_pubkey)[..16])`
/// per epic #73's identity layer. Stored as a plain `String` so `BTreeMap`
/// ordering matches lexicographic byte order and round-trips through
/// SQLite TEXT columns without a custom codec.
pub type PeerId = String;

/// Per-vault UUIDv4 stored at `.vaultcore/vault-id`. Held as `String`
/// (canonical hyphenated form) for the same SQLite-friendly reason.
pub type VaultId = String;

/// SHA-256 of file content. 32 raw bytes; SQLite stores it as BLOB.
pub type ContentHash = [u8; 32];

/// `{peer_id → counter}` per epic #73's multi-master conflict topology.
/// `BTreeMap` (not `HashMap`) so the bincode-serialized BLOB is stable
/// across runs and platforms — equality checks downstream rely on the
/// canonical byte representation.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct VersionVector(pub BTreeMap<PeerId, u64>);

impl VersionVector {
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    /// Increment `self`'s counter for `peer` (creating the entry if absent).
    /// Used on every local write before persisting `(content_hash, vv)`.
    pub fn increment(&mut self, peer: &str) {
        *self.0.entry(peer.to_string()).or_insert(0) += 1;
    }

    /// Returns true iff `self ≥ other` for every peer in `other` (i.e. `self`
    /// dominates `other` per epic #73's "if vv_local ≥ vv_remote → discard"
    /// rule). Note: peers present only in `self` don't disqualify dominance —
    /// they represent later writes the other side simply hasn't seen yet.
    pub fn dominates(&self, other: &Self) -> bool {
        for (peer, &c_other) in &other.0 {
            let c_self = self.0.get(peer).copied().unwrap_or(0);
            if c_self < c_other {
                return false;
            }
        }
        true
    }

    /// True iff neither vector dominates the other → concurrent writes
    /// → 3-way merge required.
    pub fn concurrent_with(&self, other: &Self) -> bool {
        !self.dominates(other) && !other.dominates(self)
    }

    /// Greatest common ancestor: per-peer `min`. Used to look up the base
    /// content for the 3-way merge when two writes are concurrent.
    pub fn gca(&self, other: &Self) -> Self {
        let mut out = BTreeMap::new();
        for peer in self.0.keys().chain(other.0.keys()) {
            let a = self.0.get(peer).copied().unwrap_or(0);
            let b = other.0.get(peer).copied().unwrap_or(0);
            let m = a.min(b);
            if m > 0 {
                out.insert(peer.clone(), m);
            }
        }
        Self(out)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        bincode::serialize(self).expect("VersionVector bincode serialize is infallible for BTreeMap<String, u64>")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, crate::error::VaultError> {
        bincode::deserialize(bytes).map_err(|e| crate::error::VaultError::SyncState {
            msg: format!("decode version vector: {e}"),
        })
    }
}

/// Outcome of `apply_remote_write`. Decision-only — the caller decides
/// what to do with the new content (overwrite the working file, write a
/// conflict copy, etc.).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Remote dominates — caller should overwrite the local file with the
    /// remote content and persist the new VV.
    FastForward,
    /// Local dominates — caller should drop the remote write.
    Discard,
    /// Concurrent — caller must perform the 3-way merge using the base
    /// content fetched from `history` (or, if the GCA isn't in history,
    /// fall back to a conflict-copy file).
    Conflict,
    /// First time we've seen this `(vault_id, path)` — apply remote as-is.
    Created,
}
