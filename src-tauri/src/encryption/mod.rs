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
//   crypto.rs          — XChaCha20-Poly1305 + Argon2id primitives
//   file_format.rs     — on-disk container + atomic write
//   manifest.rs        — per-vault `.vaultcore/encrypted-folders.json`
//   registry.rs        — in-memory locked-path set + derived-key cache
//   batch.rs           — folder-level encrypt + lock + unlock helpers
//   pending_queue.rs   — #357 queue of files dropped into locked folders
//   drop_encrypt.rs    — #357 watcher/unlock orchestrator for auto-encrypt
//   (IPC commands live in `crate::commands::encryption`, following the
//    existing commands/{vault,files,search,…}.rs convention; encryption/
//    holds the domain primitives only.)

pub(crate) mod batch;
pub(crate) mod crypto;
pub(crate) mod drop_encrypt;
pub(crate) mod file_format;
pub(crate) mod manifest;
pub(crate) mod pending_queue;
pub(crate) mod registry;

// Public surface — kept intentionally narrow. PRs 1b/2/3 import only
// the state primitives (registry types + newtype) and the sentinel
// constants needed at module boundaries. Internal primitives like
// `encrypt_bytes`, `frame`, and `random_nonce` stay crate-private to
// prevent drift in future call sites.
pub use drop_encrypt::{
    encrypt_file_in_place_if_needed, ensure_size_cap, seal_pending_file,
    EncryptDeps, EncryptOutcome, MAX_INLINE_ENCRYPT_BYTES,
};
pub use pending_queue::PendingEncryptionQueue;
pub use registry::{CanonicalPath, Keyring, LockedPathRegistry};
// ManifestCache is declared below this module's re-export block.

/// Name of the per-folder sentinel file that probes a candidate
/// unlock-password. It starts with `.` so walk_md_files / list_directory
/// naturally skip it.
pub const SENTINEL_FILENAME: &str = ".vaultcore-folder-key-check";

/// Deterministic plaintext sealed by the sentinel. Decrypting this with
/// a candidate key confirms (or denies) the password.
pub const SENTINEL_PLAINTEXT: &[u8] = b"VCE1-SENTINEL-v1";

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::error::VaultError;

/// In-memory cache of the canonical roots listed in
/// `.vaultcore/encrypted-folders.json`. #357 puts the manifest lookup
/// on the watcher hot path (every FS event consults it). Before the
/// cache, a bulk drop of 10k files read + JSON-parsed the manifest
/// 10 000 times — obviously untenable. Every IPC command that mutates
/// the manifest (encrypt / unlock / lock) must refresh the cache
/// AFTER its write via `refresh_from_disk`.
///
/// Stores already-canonicalized paths so hot-path lookups don't syscall
/// (`std::fs::canonicalize` is ~µs per call). The refresh path pays
/// the canonicalize cost once per manifest write.
#[derive(Default)]
pub struct ManifestCache {
    roots: RwLock<Vec<PathBuf>>,
}

impl ManifestCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-read the manifest and canonicalize every entry. Called by
    /// `open_vault` (cold start) and `encrypt_folder` — the only two
    /// paths that mutate the manifest JSON on disk. `lock_folder`,
    /// `unlock_folder`, and `lock_all_folders` intentionally do NOT
    /// refresh: they mutate in-memory registry + keyring state only,
    /// never the manifest. If a future command starts writing to the
    /// manifest, call this method after its write — otherwise the
    /// watcher hot path will see stale state.
    ///
    /// Orphaned manifest entries (folder renamed outside the app) are
    /// dropped from the cache — same best-effort semantics as
    /// `reload_manifest_and_lock_all`.
    pub fn refresh_from_disk(&self, vault_root: &Path) -> Result<(), VaultError> {
        let metas = manifest::read_manifest(vault_root)?;
        let mut canon_roots = Vec::with_capacity(metas.len());
        for m in &metas {
            let abs = vault_root.join(&m.path);
            if let Ok(canon) = std::fs::canonicalize(&abs) {
                canon_roots.push(canon);
            }
        }
        let mut g = self.roots.write().map_err(|_| VaultError::LockPoisoned)?;
        *g = canon_roots;
        Ok(())
    }

    /// Wipe the cache — called on vault switch before the new manifest
    /// is refreshed, so the new vault doesn't transiently see the old
    /// vault's roots.
    pub fn clear(&self) -> Result<(), VaultError> {
        let mut g = self.roots.write().map_err(|_| VaultError::LockPoisoned)?;
        g.clear();
        Ok(())
    }

    /// Lookup the enclosing encrypted root for `canonical`, O(n roots).
    /// Returns `None` if the cache is empty or the path is outside every
    /// encrypted root.
    pub fn find_enclosing(&self, canonical: &Path) -> Result<Option<PathBuf>, VaultError> {
        let g = self.roots.read().map_err(|_| VaultError::LockPoisoned)?;
        if g.is_empty() {
            return Ok(None);
        }
        for root in g.iter() {
            if canonical == root.as_path() || canonical.starts_with(root) {
                return Ok(Some(root.clone()));
            }
        }
        Ok(None)
    }
}

/// Cache-backed lookup. Callers on the hot path (watcher, read_file,
/// write_file) must use this. The plain `find_enclosing_encrypted_root`
/// below is kept as a fallback for callers that don't carry a cache
/// handle (tests, migration tools).
pub fn find_enclosing_encrypted_root_cached(
    cache: &ManifestCache,
    _vault_root: &Path,
    canonical: &Path,
) -> Result<Option<PathBuf>, VaultError> {
    cache.find_enclosing(canonical)
}

/// Locate the absolute path of the encrypted root that contains
/// `canonical`, if any. Returns `None` when the path is outside
/// every encrypted folder. Uses the manifest because the locked
/// registry drops entries on unlock — the manifest is the canonical
/// "which folders are encrypted at rest" source of truth.
///
/// NOTE: reads the manifest from disk on every call. Use
/// `find_enclosing_encrypted_root_cached` on the hot watcher path.
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
            Some(crate::storage::VaultHandle::Posix(p)) => p.clone(),
            // #392 PR-B: encrypted folders are not yet supported on
            // Android (canonical-path-keyed manifest is desktop-only).
            // Passthrough ensures plain (unencrypted) Android vaults
            // still flow read paths cleanly. Encrypt path is guarded
            // separately at every encrypt_folder/unlock_folder entry.
            #[cfg(target_os = "android")]
            Some(crate::storage::VaultHandle::ContentUri(_)) => return Ok(bytes),
            None => return Ok(bytes),
        }
    };
    let Some(root) = find_enclosing_encrypted_root_cached(
        &state.manifest_cache,
        &vault_root,
        canonical,
    )? else {
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
            Some(crate::storage::VaultHandle::Posix(p)) => p.clone(),
            // #392 PR-B: see maybe_decrypt_read for rationale.
            #[cfg(target_os = "android")]
            Some(crate::storage::VaultHandle::ContentUri(_)) => return Ok(bytes.to_vec()),
            None => return Ok(bytes.to_vec()),
        }
    };
    let Some(root) = find_enclosing_encrypted_root_cached(
        &state.manifest_cache,
        &vault_root,
        canonical,
    )? else {
        return Ok(bytes.to_vec());
    };
    // #357: enforce the same size cap we apply on the drop path so every
    // encrypted write — from editor, attachment, or drop — is subject to
    // the same guarantee.
    drop_encrypt::ensure_size_cap(canonical, bytes.len() as u64)?;
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
