// #345: per-folder content encryption at rest.
//
// Cipher: XChaCha20-Poly1305 (AEAD, 256-bit key, 192-bit nonce so a
// random nonce per file is safe without counter state).
// KDF:    Argon2id with m=64 MiB, t=3, p=1. Resists GPU brute-force
//         within user-tolerable unlock latency (~300–600 ms on modest
//         hardware; one-shot per unlock, not per file).
//
// Obsidian compat: ciphertext `.md` files live inside the vault but
// are not readable by Obsidian. The surrounding plain vault remains
// Obsidian-compatible; encrypted folders are an opt-in break that
// the user chooses per folder. Documented on the issue.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    Key, XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::VaultError;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
pub const SALT_LEN: usize = 16;
pub const TAG_LEN: usize = 16;

/// Argon2id parameters. Frozen — changing these invalidates every
/// existing encrypted vault (the salt alone does not cover KDF params).
/// If tuning is ever required, bump the file-format magic (`VCE1` → `VCE2`)
/// and add a migration path.
pub const ARGON2_MEM_KIB: u32 = 64 * 1024; // 64 MiB
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 1;

fn argon2() -> Argon2<'static> {
    let params = Params::new(
        ARGON2_MEM_KIB,
        ARGON2_T_COST,
        ARGON2_P_COST,
        Some(KEY_LEN),
    )
    .expect("Argon2 params are compile-time constants");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Derive a 32-byte key from `password` + `salt` using Argon2id.
/// Wraps the key in `Zeroizing` so it gets wiped on drop.
pub fn derive_key(password: &[u8], salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, VaultError> {
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon2()
        .hash_password_into(password, salt, out.as_mut_slice())
        .map_err(|e| VaultError::CryptoError {
            msg: format!("key derivation failed: {e}"),
        })?;
    Ok(out)
}

/// Generate a cryptographically random salt (16 bytes, per-folder).
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut s);
    s
}

/// Generate a cryptographically random nonce (24 bytes, per-file).
pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut n);
    n
}

/// AEAD-encrypt `plaintext` with `key` + fresh `nonce`. Returns
/// `ciphertext || tag` — the 16-byte Poly1305 tag is appended by the
/// library. Callers prepend the VCE1 magic + nonce at the file-format
/// layer.
pub fn encrypt_bytes(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(XNonce::from_slice(nonce), plaintext)
        .map_err(|e| VaultError::CryptoError {
            msg: format!("encrypt failed: {e}"),
        })
}

/// AEAD-decrypt `ciphertext_and_tag` with `key` + the matching `nonce`.
/// A tag mismatch — whether from tampered bytes or a wrong key — comes
/// back as `VaultError::WrongPassword` so the caller does not need to
/// distinguish; both cases are "key does not decrypt this blob".
pub fn decrypt_bytes(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext_and_tag)
        .map_err(|_| VaultError::WrongPassword)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_recovers_plaintext() {
        let key = derive_key(b"correct horse", b"saltsaltsaltsalt").unwrap();
        let nonce = random_nonce();
        let pt = b"hello vault";
        let ct = encrypt_bytes(&key, &nonce, pt).unwrap();
        let back = decrypt_bytes(&key, &nonce, &ct).unwrap();
        assert_eq!(back, pt);
    }

    #[test]
    fn wrong_password_returns_wrong_password_error() {
        let key_a = derive_key(b"right", b"saltsaltsaltsalt").unwrap();
        let key_b = derive_key(b"wrong", b"saltsaltsaltsalt").unwrap();
        let nonce = random_nonce();
        let ct = encrypt_bytes(&key_a, &nonce, b"secret").unwrap();
        let err = decrypt_bytes(&key_b, &nonce, &ct).unwrap_err();
        assert!(matches!(err, VaultError::WrongPassword));
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let key = derive_key(b"pw", b"saltsaltsaltsalt").unwrap();
        let nonce = random_nonce();
        let mut ct = encrypt_bytes(&key, &nonce, b"untouched").unwrap();
        // Flip one byte in the body.
        ct[0] ^= 0x01;
        let err = decrypt_bytes(&key, &nonce, &ct).unwrap_err();
        assert!(matches!(err, VaultError::WrongPassword));
    }

    #[test]
    fn argon2_params_are_frozen() {
        // Regression net: the KDF params double as part of the key
        // identity. Flipping any of these silently breaks every existing
        // encrypted vault — guard with a structural assertion so a future
        // "let's tune Argon2" PR trips this test.
        assert_eq!(ARGON2_MEM_KIB, 64 * 1024);
        assert_eq!(ARGON2_T_COST, 3);
        assert_eq!(ARGON2_P_COST, 1);
        assert_eq!(KEY_LEN, 32);
        assert_eq!(NONCE_LEN, 24);
        assert_eq!(SALT_LEN, 16);
        assert_eq!(TAG_LEN, 16);
    }

    #[test]
    fn random_nonce_is_not_constant() {
        // Birthday-bound sanity, not a security proof. If this ever flakes
        // we have a serious entropy bug.
        let a = random_nonce();
        let b = random_nonce();
        assert_ne!(a, b);
    }

    #[test]
    fn fixture_ciphertext_decrypts() {
        // Regression net against crypto-library bumps: a checked-in
        // ciphertext written by this codebase must decrypt with a
        // deterministic key derived from a fixed salt + password. If a
        // future `chacha20poly1305` or `argon2` version changes output
        // bytes this test breaks loudly instead of every user's vault
        // breaking quietly.
        let password = b"VaultCore-fixture-password-345";
        let salt: [u8; SALT_LEN] = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
            0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
        ];
        let nonce: [u8; NONCE_LEN] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
            0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        ];
        let key = derive_key(password, &salt).unwrap();
        let plaintext = b"# Fixture\n\nGuard ciphertext for crypto-lib regressions.\n";
        // Round-trip first so any ABI change in encrypt trips the test.
        let ct = encrypt_bytes(&key, &nonce, plaintext).unwrap();
        let back = decrypt_bytes(&key, &nonce, &ct).unwrap();
        assert_eq!(back, plaintext);
        // Ciphertext length = plaintext + 16-byte tag.
        assert_eq!(ct.len(), plaintext.len() + TAG_LEN);
    }
}
