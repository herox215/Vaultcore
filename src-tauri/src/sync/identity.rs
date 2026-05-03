//! Per-device Ed25519 identity (epic #73 sub-issue #417).
//!
//! Private key persists in the OS keychain (Keychain on macOS, Credential
//! Manager on Windows, Secret Service on Linux, Keystore on Android via the
//! `keyring` crate's platform impls). Public key is held in memory and
//! re-derived from the private key on each load.
//!
//! `device_id = base32(SHA-256(pubkey)[..16])` per the epic's identity
//! layer. Stable across launches of the same install — derives a fresh
//! keypair on first use, then reads the same key on every subsequent
//! `Identity::load_or_create` call.

use std::sync::Mutex;

use data_encoding::BASE32_NOPAD;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::error::VaultError;

/// Keychain service identifier — shared across all VaultCore installs of
/// the user. Matches the spec's "service `com.vaultcore.sync`" wording.
pub const KEYCHAIN_SERVICE: &str = "com.vaultcore.sync";
/// Account name within `KEYCHAIN_SERVICE` for the device key.
pub const KEYCHAIN_ACCOUNT: &str = "device-key";

/// Persistent backing store for the device's private key bytes.
///
/// Production wires `OsKeychainStore` to the platform keychain via the
/// `keyring` crate. Tests inject `MemoryKeyStore` to avoid touching the
/// developer's real keychain (and to run in CI where no GUI session
/// exists to unlock Keychain on macOS).
pub trait KeyStore: Send + Sync {
    /// Return the stored private-key bytes, or `None` if none has been
    /// written yet. Errors are *infrastructure* errors (keychain locked,
    /// IPC failed) — distinct from "key absent".
    fn get(&self) -> Result<Option<[u8; 32]>, VaultError>;
    /// Persist the private-key bytes. Overwrites any prior value.
    fn put(&self, key: &[u8; 32]) -> Result<(), VaultError>;
}

/// In-memory keystore for tests. Holds bytes behind a `Mutex` so a single
/// instance can back multiple `Identity::load_or_create` calls and still
/// see the persisted key.
#[derive(Debug, Default)]
pub struct MemoryKeyStore {
    inner: Mutex<Option<[u8; 32]>>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self) -> Result<Option<[u8; 32]>, VaultError> {
        Ok(*self.inner.lock().map_err(|_| VaultError::LockPoisoned)?)
    }

    fn put(&self, key: &[u8; 32]) -> Result<(), VaultError> {
        *self.inner.lock().map_err(|_| VaultError::LockPoisoned)? = Some(*key);
        Ok(())
    }
}

/// OS keychain backed `KeyStore`. Stores the 32-byte ed25519 secret as a
/// base64 string in the keychain "password" slot — keyring's API works in
/// strings, not raw bytes.
pub struct OsKeychainStore {
    service: String,
    account: String,
}

impl Default for OsKeychainStore {
    fn default() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.to_string(),
            account: KEYCHAIN_ACCOUNT.to_string(),
        }
    }
}

impl KeyStore for OsKeychainStore {
    fn get(&self) -> Result<Option<[u8; 32]>, VaultError> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(keyring_err)?;
        match entry.get_password() {
            Ok(s) => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(s.as_bytes())
                    .map_err(|e| VaultError::SyncState {
                        msg: format!("decode keychain entry: {e}"),
                    })?;
                if bytes.len() != 32 {
                    return Err(VaultError::SyncState {
                        msg: format!("keychain entry wrong length: {}", bytes.len()),
                    });
                }
                let mut out = [0u8; 32];
                out.copy_from_slice(&bytes);
                Ok(Some(out))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_err(e)),
        }
    }

    fn put(&self, key: &[u8; 32]) -> Result<(), VaultError> {
        use base64::Engine;
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(keyring_err)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(key);
        entry.set_password(&encoded).map_err(keyring_err)?;
        Ok(())
    }
}

fn keyring_err(e: keyring::Error) -> VaultError {
    VaultError::SyncState {
        msg: format!("keychain: {e}"),
    }
}

/// In-memory device identity. Built once at sync-engine startup; carried
/// in the sync state.
pub struct Identity {
    signing: SigningKey,
    verifying: VerifyingKey,
    device_id: String,
}

impl Identity {
    /// Load the device key from `store`, or generate + persist a fresh
    /// one if absent. Idempotent: subsequent calls with the same store
    /// yield the same `device_id`.
    pub fn load_or_create(store: &dyn KeyStore) -> Result<Self, VaultError> {
        let secret_bytes = match store.get()? {
            Some(b) => b,
            None => {
                use rand_core::RngCore;
                let mut bytes = [0u8; 32];
                rand_core::OsRng.fill_bytes(&mut bytes);
                store.put(&bytes)?;
                bytes
            }
        };
        let signing = SigningKey::from_bytes(&secret_bytes);
        let verifying = signing.verifying_key();
        let device_id = derive_device_id(&verifying);
        Ok(Self {
            signing,
            verifying,
            device_id,
        })
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.verifying.to_bytes()
    }

    /// Short fingerprint advertised in mDNS TXT records. First 8 bytes of
    /// the device-id base32 string — enough to distinguish at a glance
    /// without bloating the broadcast.
    pub fn pubkey_fp(&self) -> String {
        self.device_id.chars().take(8).collect()
    }

    /// Sign a message under the device's private key. Used during
    /// pairing to bind the long-term Ed25519 key to the PAKE session.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying
    }

    /// Borrow the underlying `SigningKey` for callers that need to hand
    /// it to crypto APIs (capability signing, `pairing_engine::drive_*`).
    /// Stays inside the crate — outside callers should go through
    /// [`Identity::sign`] for opaque signing.
    pub(crate) fn signing_key(&self) -> &SigningKey {
        &self.signing
    }
}

/// `device_id = base32(SHA-256(pubkey)[..16])` per the epic. Returned in
/// canonical RFC 4648 base32 with no padding — short, case-insensitive,
/// safe for DNS / mDNS TXT records.
pub fn derive_device_id(pubkey: &VerifyingKey) -> String {
    let digest = Sha256::digest(pubkey.to_bytes());
    BASE32_NOPAD.encode(&digest[..16])
}
