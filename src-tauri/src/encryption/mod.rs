// #345 — per-folder encryption at rest.
//
// Obsidian-compat note: ciphertext files under an encrypted folder are
// not readable by Obsidian, but the surrounding vault remains
// compatible. Users opt in per folder; the vault structure itself is
// untouched.
//
// Encryption scope per folder: every regular file, not only `.md`.
// Attachments (images pasted into notes, PDFs, CSV exports, canvas
// files) are sealed together with the notes they belong to — otherwise
// the "this folder is private" contract would silently leak through
// the embedded-asset side door.
//
// Crypto choices are frozen — see `crypto.rs` for rationale. Changing
// them requires a file-format magic bump (VCE1 → VCE2) and migration.
//
// Layout:
//   crypto.rs       — XChaCha20-Poly1305 + Argon2id primitives
//   file_format.rs  — on-disk container + atomic write
//   manifest.rs     — per-vault `.vaultcore/encrypted-folders.json`
//   registry.rs     — in-memory locked-path set + derived-key cache
//   batch.rs        — folder-level encrypt + lock + unlock helpers
//   (IPC commands live in `crate::commands::encryption`, following the
//    existing commands/{vault,files,search,…}.rs convention; encryption/
//    holds the domain primitives only.)

pub(crate) mod batch;
pub(crate) mod crypto;
pub(crate) mod file_format;
pub(crate) mod manifest;
pub(crate) mod registry;

// Public surface — kept intentionally narrow. PRs 1b/2/3 import only
// the state primitives (registry types + newtype) and the sentinel
// constants needed at module boundaries. Internal primitives like
// `encrypt_bytes`, `frame`, and `random_nonce` stay crate-private to
// prevent drift in future call sites.
pub use registry::{CanonicalPath, Keyring, LockedPathRegistry};

/// Name of the per-folder sentinel file that probes a candidate
/// unlock-password. It starts with `.` so walk_md_files / list_directory
/// naturally skip it.
pub const SENTINEL_FILENAME: &str = ".vaultcore-folder-key-check";

/// Deterministic plaintext sealed by the sentinel. Decrypting this with
/// a candidate key confirms (or denies) the password.
pub const SENTINEL_PLAINTEXT: &[u8] = b"VCE1-SENTINEL-v1";

use std::path::{Path, PathBuf};

use crate::error::VaultError;

/// Locate the absolute path of the encrypted root that contains
/// `canonical`, if any. Returns `None` when the path is outside
/// every encrypted folder. Uses the manifest because the locked
/// registry drops entries on unlock — the manifest is the canonical
/// "which folders are encrypted at rest" source of truth.
pub fn find_enclosing_encrypted_root(
    vault_root: &Path,
    canonical: &Path,
) -> Result<Option<PathBuf>, VaultError> {
    let metas = manifest::read_manifest(vault_root)?;
    if metas.is_empty() {
        return Ok(None);
    }
    for m in &metas {
        let abs = vault_root.join(&m.path);
        let Ok(root_canon) = std::fs::canonicalize(&abs) else {
            continue;
        };
        if canonical == root_canon.as_path() || canonical.starts_with(&root_canon) {
            return Ok(Some(root_canon));
        }
    }
    Ok(None)
}

/// Decrypt `bytes` when `canonical` lives inside an unlocked
/// encrypted root, otherwise return them unchanged.
///
/// Bytes pass through untouched when:
/// - the path is outside every encrypted root, OR
/// - the bytes do not start with the VCE1 magic (a plain file that
///   leaked into the folder via an external tool or a half-finished
///   encrypt batch — tolerated so the user can still read/repair).
pub fn maybe_decrypt_read(
    state: &crate::VaultState,
    canonical: &Path,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, VaultError> {
    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => return Ok(bytes),
        }
    };
    let Some(root) = find_enclosing_encrypted_root(&vault_root, canonical)? else {
        return Ok(bytes);
    };
    if !bytes.starts_with(file_format::MAGIC) {
        return Ok(bytes);
    }
    let key = state
        .keyring
        .key_clone(&root)?
        .ok_or_else(|| VaultError::PathLocked {
            path: canonical.display().to_string(),
        })?;
    let (nonce, body) = file_format::parse(&bytes)?;
    crypto::decrypt_bytes(&key, &nonce, body)
}

/// Encrypt `bytes` when `canonical` lives inside an unlocked
/// encrypted root, otherwise return them unchanged. The sealed
/// output is ready to be written atomically via
/// `file_format::write_atomic`.
pub fn maybe_encrypt_write(
    state: &crate::VaultState,
    canonical: &Path,
    bytes: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => return Ok(bytes.to_vec()),
        }
    };
    let Some(root) = find_enclosing_encrypted_root(&vault_root, canonical)? else {
        return Ok(bytes.to_vec());
    };
    let key = state
        .keyring
        .key_clone(&root)?
        .ok_or_else(|| VaultError::PathLocked {
            path: canonical.display().to_string(),
        })?;
    let nonce = crypto::random_nonce();
    let ct = crypto::encrypt_bytes(&key, &nonce, bytes)?;
    Ok(file_format::frame(&nonce, &ct))
}
