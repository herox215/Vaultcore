//! Per-vault capability tokens (epic #73 sub-issue #418).
//!
//! Tokens are **the** security boundary for cross-device sync: every
//! request to read or write a vault validates a `Capability` issued by
//! the vault owner. Device-trust (PAKE pairing) authenticates *who* is
//! talking; capabilities authorize *what* they can access.
//!
//! Reserved fields (`format_version`, `requires_unlock`, `wrapped_key`,
//! `expires_at`) ride along on the struct even though v1 sets them to
//! null/0 — forward-flex for unforeseen future per-grant gating.
//! **Do not remove them.**

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::VaultError;

/// Sync access level. Stored as TEXT in `sync_vault_grants.scope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scope {
    Read,
    ReadWrite,
}

impl Scope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::ReadWrite => "read+write",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read" => Some(Self::Read),
            "read+write" => Some(Self::ReadWrite),
            _ => None,
        }
    }
}

/// Token body — bincode-serialized + signed. Field order is
/// **load-bearing** for signature stability; do not reorder. Add new
/// fields after `wrapped_key` and bump `format_version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityBody {
    pub local_vault_id: String,
    pub peer_device_id: String,
    pub peer_vault_id: String,
    pub scope: Scope,
    pub format_version: u32,
    pub requires_unlock: u32,
    pub wrapped_key: Option<Vec<u8>>,
    pub expires_at: Option<i64>,
}

impl CapabilityBody {
    /// v1 issuance: `format_version = 1`, no unlock requirement, no wrapped
    /// key, no explicit expiry. The reserved fields are kept on the wire
    /// so future v2 verifiers can refuse v1 tokens or vice versa cleanly.
    pub fn issue_v1(
        local_vault_id: impl Into<String>,
        peer_device_id: impl Into<String>,
        peer_vault_id: impl Into<String>,
        scope: Scope,
    ) -> Self {
        Self {
            local_vault_id: local_vault_id.into(),
            peer_device_id: peer_device_id.into(),
            peer_vault_id: peer_vault_id.into(),
            scope,
            format_version: 1,
            requires_unlock: 0,
            wrapped_key: None,
            expires_at: None,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        bincode::serialize(self).expect("bincode of CapabilityBody is infallible")
    }
}

/// Signed token. `body` is bincode bytes (so the signature covers the
/// exact byte layout — re-serializing on the verifier side would risk
/// drift if a future bincode revision changed encoding). `signature`
/// is the Ed25519 signature (64 bytes) of `body` under the issuing
/// device's key — held as `Vec<u8>` because serde lacks a default
/// `[u8; 64]` impl; the verifier reconstructs the fixed-size signature
/// at check time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub body: Vec<u8>,
    pub signature: Vec<u8>,
}

impl Capability {
    /// Sign `body` under `signing_key` and emit a transmittable token.
    pub fn sign(body: &CapabilityBody, signing_key: &SigningKey) -> Self {
        let body_bytes = body.to_bytes();
        let sig = signing_key.sign(&body_bytes);
        Self {
            body: body_bytes,
            signature: sig.to_bytes().to_vec(),
        }
    }

    /// Verify the signature under `pubkey`. Decodes the body on success
    /// so the caller can act on the parsed fields.
    pub fn verify(&self, pubkey: &VerifyingKey) -> Result<CapabilityBody, VaultError> {
        if self.signature.len() != 64 {
            return Err(VaultError::SyncState {
                msg: format!("capability signature wrong length: {}", self.signature.len()),
            });
        }
        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(&self.signature);
        let sig = Signature::from_bytes(&sig_bytes);
        pubkey
            .verify(&self.body, &sig)
            .map_err(|e| VaultError::SyncState {
                msg: format!("capability signature: {e}"),
            })?;
        let body: CapabilityBody =
            bincode::deserialize(&self.body).map_err(|e| VaultError::SyncState {
                msg: format!("capability body decode: {e}"),
            })?;
        if body.format_version != 1 {
            return Err(VaultError::SyncState {
                msg: format!(
                    "unsupported capability format_version {}",
                    body.format_version
                ),
            });
        }
        Ok(body)
    }

    /// Wire-format encode the whole token (body + signature) as a single
    /// blob suitable for the `capability_token` BLOB column.
    pub fn to_bytes(&self) -> Vec<u8> {
        bincode::serialize(self).expect("bincode of Capability is infallible")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, VaultError> {
        bincode::deserialize(bytes).map_err(|e| VaultError::SyncState {
            msg: format!("capability decode: {e}"),
        })
    }
}
