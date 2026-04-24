// #357 — orchestrator for the "auto-encrypt files dropped into encrypted
// folders" flow.
//
// Responsibilities:
// - Classify a path observed by the FS watcher (or any post-drop entry
//   point) and either: seal it in place, enqueue it for the next unlock,
//   or leave it alone.
// - Kept free of `VaultState` so the logic can be exercised from unit
//   tests without constructing a Tauri state object. Callers thread the
//   concrete registry / keyring / queue references in.
//
// Streaming vs buffered: MVP is buffered with a hard size cap (see
// `MAX_INLINE_ENCRYPT_BYTES`). Files over the cap produce
// `VaultError::PayloadTooLarge` — the file stays plaintext and the
// frontend surfaces an actionable toast. Streaming encryption will land
// in a follow-up ticket that bumps the file-format magic (VCE1 → VCE2).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::WriteIgnoreList;
use crate::encryption::batch::encrypt_file_in_place;
use crate::encryption::file_format::MAGIC;
use crate::encryption::pending_queue::PendingEncryptionQueue;
use crate::encryption::registry::{CanonicalPath, Keyring, LockedPathRegistry};
use crate::encryption::{find_enclosing_encrypted_root_cached, ManifestCache};
use crate::error::VaultError;

/// Upper bound on the plaintext size we are willing to encrypt with the
/// buffered MVP path. 256 MiB comfortably covers high-res photos, PDF
/// whitepapers, and typical code archives without running the process
/// out of memory. Users hitting the cap get a targeted error they can
/// act on instead of a silent half-encrypt.
pub const MAX_INLINE_ENCRYPT_BYTES: u64 = 256 * 1024 * 1024;

/// Outcome returned by the orchestrator. Callers (watcher, unlock drain)
/// use it to decide whether to emit a progress event and whether the
/// follow-on indexer dispatch is still safe.
#[derive(Debug, PartialEq, Eq)]
pub enum EncryptOutcome {
    /// Path is outside every encrypted root — no-op.
    NotInEncryptedRoot,
    /// Path was not a regular file (directory, symlink, FIFO, …) — no-op.
    NotRegularFile,
    /// File already sealed (starts with VCE1 magic) — no-op.
    AlreadySealed,
    /// Root is currently locked; file was queued for seal-on-unlock. The
    /// file remains plaintext on disk (known gap — surfaced to user).
    Queued { root: PathBuf },
    /// File was sealed in place atomically.
    Sealed { root: PathBuf },
}

/// Dependencies the orchestrator needs. Taking a borrow struct keeps the
/// function signature stable as the watcher's state grows; the alternative
/// (pass every `Arc<...>` individually) made `spawn_watcher` balloon to 8+
/// parameters.
pub struct EncryptDeps<'a> {
    pub vault_root: &'a Path,
    pub locked_paths: &'a LockedPathRegistry,
    pub keyring: &'a Keyring,
    pub pending_queue: &'a PendingEncryptionQueue,
    pub write_ignore: &'a Arc<std::sync::Mutex<WriteIgnoreList>>,
    pub manifest_cache: &'a ManifestCache,
}

/// Classify and act on a single candidate path. Safe to call repeatedly
/// for the same path (the AlreadySealed / NotInEncryptedRoot short
/// circuits make it idempotent on the hot path). Errors surface only
/// for genuinely bad states (IO on metadata read, payload-too-large,
/// crypto failure) — the caller decides whether to log, toast, or retry.
pub fn encrypt_file_in_place_if_needed(
    deps: &EncryptDeps<'_>,
    canonical_path: &Path,
) -> Result<EncryptOutcome, VaultError> {
    // 1. Inside an encrypted root? The cache is kept warm by every
    //    manifest write; plain-vault paths short-circuit in O(1).
    let Some(root) = find_enclosing_encrypted_root_cached(
        deps.manifest_cache,
        deps.vault_root,
        canonical_path,
    )? else {
        return Ok(EncryptOutcome::NotInEncryptedRoot);
    };

    // 2. Regular file? Watcher events occasionally point at directories
    //    (macOS FSEvents coalesces dir-creates). `fs::metadata` follows
    //    symlinks — that is correct here: a symlink TO a file outside
    //    the vault is still out-of-scope (its canonical path will not
    //    starts_with(root)), and a symlink to a regular file inside the
    //    vault can be sealed like any other.
    let meta = match std::fs::metadata(canonical_path) {
        Ok(m) => m,
        // Path has disappeared between the watcher event and our read —
        // nothing to encrypt.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EncryptOutcome::NotRegularFile);
        }
        Err(e) => return Err(VaultError::Io(e)),
    };
    if !meta.is_file() {
        return Ok(EncryptOutcome::NotRegularFile);
    }

    // 3. Enforce the MVP size cap so we never buffer a multi-GB video in
    //    RAM. The cap surfaces as an actionable error message.
    let size = meta.len();
    ensure_size_cap(canonical_path, size)?;

    // 4. Already sealed? Peek 4 bytes instead of loading the whole file.
    //    A 4-byte short read means the file is smaller than the header
    //    and obviously not sealed — fall through and encrypt.
    if file_starts_with_magic(canonical_path)? {
        return Ok(EncryptOutcome::AlreadySealed);
    }

    // 5. Locked root? Queue and bail. The plaintext stays on disk — the
    //    UI must warn the user.
    let canon = CanonicalPath::assume_canonical(canonical_path.to_path_buf());
    if deps.locked_paths.is_locked(&canon) {
        deps.pending_queue.enqueue_for_root(root.clone(), canonical_path.to_path_buf())?;
        return Ok(EncryptOutcome::Queued { root });
    }

    // 6. Seal. Register the write in write_ignore BEFORE the atomic
    //    rename so the watcher's resulting Modify/Rename event is self-
    //    filtered and we never re-enter for the same file.
    if let Ok(mut ign) = deps.write_ignore.lock() {
        ign.record(canonical_path.to_path_buf());
    }
    let key = deps.keyring.key_clone(&root)?.ok_or_else(|| VaultError::PathLocked {
        path: canonical_path.display().to_string(),
    })?;
    // `encrypt_file_in_place` is idempotent: `Ok(false)` means already
    // framed, which we've already short-circuited above but is handled
    // defensively in case two watcher events race.
    let did_work = encrypt_file_in_place(&key, canonical_path)?;
    if did_work {
        Ok(EncryptOutcome::Sealed { root })
    } else {
        Ok(EncryptOutcome::AlreadySealed)
    }
}

/// Directly seal a single file under a root whose key is already in the
/// keyring — used by the unlock flow when draining the pending queue.
/// Bypasses the `is_locked` check deliberately: the unlock drain runs
/// WHILE the folder is still registered as locked (to close the
/// plaintext-read window) but with the key already inserted.
pub fn seal_pending_file(
    deps: &EncryptDeps<'_>,
    root: &Path,
    canonical_path: &Path,
) -> Result<EncryptOutcome, VaultError> {
    // Revalidate: the queued path must still sit inside the root we were
    // passed. If the user moved the file between drop and unlock, do
    // nothing rather than sealing a path in the wrong vault.
    let canon_enclosing = find_enclosing_encrypted_root_cached(
        deps.manifest_cache,
        deps.vault_root,
        canonical_path,
    )?;
    if canon_enclosing.as_deref() != Some(root) {
        return Ok(EncryptOutcome::NotInEncryptedRoot);
    }

    let meta = match std::fs::metadata(canonical_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EncryptOutcome::NotRegularFile);
        }
        Err(e) => return Err(VaultError::Io(e)),
    };
    if !meta.is_file() {
        return Ok(EncryptOutcome::NotRegularFile);
    }
    ensure_size_cap(canonical_path, meta.len())?;
    if file_starts_with_magic(canonical_path)? {
        return Ok(EncryptOutcome::AlreadySealed);
    }
    if let Ok(mut ign) = deps.write_ignore.lock() {
        ign.record(canonical_path.to_path_buf());
    }
    let key = deps.keyring.key_clone(root)?.ok_or_else(|| VaultError::PathLocked {
        path: canonical_path.display().to_string(),
    })?;
    let did = encrypt_file_in_place(&key, canonical_path)?;
    Ok(if did {
        EncryptOutcome::Sealed { root: root.to_path_buf() }
    } else {
        EncryptOutcome::AlreadySealed
    })
}

/// Guard used by both the orchestrator and `save_attachment` so the cap
/// is enforced uniformly regardless of entry point.
pub fn ensure_size_cap(path: &Path, size: u64) -> Result<(), VaultError> {
    if size > MAX_INLINE_ENCRYPT_BYTES {
        return Err(VaultError::PayloadTooLarge {
            path: path.display().to_string(),
            size,
            cap: MAX_INLINE_ENCRYPT_BYTES,
        });
    }
    Ok(())
}

/// Peek the first 4 bytes; returns `Ok(false)` for files shorter than
/// the header — callers treat those as not-sealed.
fn file_starts_with_magic(path: &Path) -> Result<bool, VaultError> {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(VaultError::Io(e)),
    };
    let mut buf = [0u8; 4];
    match f.read(&mut buf) {
        Ok(n) if n == 4 => Ok(&buf == MAGIC),
        Ok(_) => Ok(false),
        Err(e) => Err(VaultError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WriteIgnoreList;
    use crate::encryption::crypto::{derive_key, random_salt};
    use crate::encryption::manifest::{upsert, EncryptedFolderMeta, FolderState};
    use std::sync::Mutex;
    use tempfile::TempDir;
    use zeroize::Zeroizing;

    struct Harness {
        _tmp: TempDir,
        vault: PathBuf,
        root: PathBuf,
        locked: LockedPathRegistry,
        keyring: Keyring,
        queue: PendingEncryptionQueue,
        write_ignore: Arc<Mutex<WriteIgnoreList>>,
        manifest_cache: ManifestCache,
    }

    fn setup(folder_name: &str, unlocked: bool) -> Harness {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().canonicalize().unwrap();
        let root = vault.join(folder_name);
        std::fs::create_dir_all(&root).unwrap();
        let salt = random_salt();
        upsert(
            &vault,
            EncryptedFolderMeta {
                path: folder_name.to_string(),
                created_at: "2026-04-24T00:00:00Z".into(),
                salt: EncryptedFolderMeta::encode_salt(&salt),
                state: FolderState::Encrypted,
            },
        )
        .unwrap();
        let locked = LockedPathRegistry::new();
        let keyring = Keyring::new();
        let canon = root.canonicalize().unwrap();
        locked.lock_root(canon.clone()).unwrap();
        if unlocked {
            let key = derive_key(b"pw", &salt).unwrap();
            let mut k = Zeroizing::new([0u8; 32]);
            k.copy_from_slice(key.as_slice());
            keyring.insert(canon.clone(), k).unwrap();
            locked.unlock_root(&canon).unwrap();
        }
        let manifest_cache = ManifestCache::new();
        manifest_cache.refresh_from_disk(&vault).unwrap();
        Harness {
            _tmp: tmp,
            vault,
            root: canon,
            locked,
            keyring,
            queue: PendingEncryptionQueue::new(),
            write_ignore: Arc::new(Mutex::new(WriteIgnoreList::default())),
            manifest_cache,
        }
    }

    impl Harness {
        fn deps(&self) -> EncryptDeps<'_> {
            EncryptDeps {
                vault_root: &self.vault,
                locked_paths: &self.locked,
                keyring: &self.keyring,
                pending_queue: &self.queue,
                write_ignore: &self.write_ignore,
                manifest_cache: &self.manifest_cache,
            }
        }
    }

    #[test]
    fn noop_outside_encrypted_roots() {
        let h = setup("private", true);
        let plain = h.vault.join("plain.md");
        std::fs::write(&plain, b"hello").unwrap();
        let canon = plain.canonicalize().unwrap();
        let out = encrypt_file_in_place_if_needed(&h.deps(), &canon).unwrap();
        assert_eq!(out, EncryptOutcome::NotInEncryptedRoot);
        let on_disk = std::fs::read(&canon).unwrap();
        assert_eq!(on_disk, b"hello");
    }

    #[test]
    fn queues_when_root_locked() {
        let h = setup("private", false);
        let dropped = h.root.join("photo.png");
        std::fs::write(&dropped, b"\x89PNG\r\n\x1a\nbinary").unwrap();
        let canon = dropped.canonicalize().unwrap();
        let out = encrypt_file_in_place_if_needed(&h.deps(), &canon).unwrap();
        assert!(matches!(out, EncryptOutcome::Queued { .. }));
        // Plaintext still on disk (known gap — UI warns).
        let on_disk = std::fs::read(&canon).unwrap();
        assert_eq!(&on_disk[0..4], b"\x89PNG");
        // Queue populated.
        assert_eq!(h.queue.len_for_root(&h.root), 1);
    }

    #[test]
    fn seals_when_root_unlocked() {
        let h = setup("private", true);
        let dropped = h.root.join("receipt.pdf");
        std::fs::write(&dropped, b"%PDF-1.4\nbinary-content").unwrap();
        let canon = dropped.canonicalize().unwrap();
        let out = encrypt_file_in_place_if_needed(&h.deps(), &canon).unwrap();
        assert!(matches!(out, EncryptOutcome::Sealed { .. }));
        let on_disk = std::fs::read(&canon).unwrap();
        assert_eq!(&on_disk[0..4], MAGIC);
        // write_ignore records the sealed path — watcher won't self-loop.
        let ign = h.write_ignore.lock().unwrap();
        assert!(ign.should_ignore(&canon));
    }

    #[test]
    fn idempotent_on_already_sealed_file() {
        let h = setup("private", true);
        let target = h.root.join("note.txt");
        // Write a framed file directly via encrypt_file_in_place so the
        // orchestrator must short-circuit on the magic peek.
        std::fs::write(&target, b"first").unwrap();
        let canon = target.canonicalize().unwrap();
        let _ = encrypt_file_in_place_if_needed(&h.deps(), &canon).unwrap();
        let first = std::fs::read(&canon).unwrap();
        // Second call is a no-op.
        let out2 = encrypt_file_in_place_if_needed(&h.deps(), &canon).unwrap();
        assert_eq!(out2, EncryptOutcome::AlreadySealed);
        let second = std::fs::read(&canon).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn rejects_directory_path() {
        let h = setup("private", true);
        // The encrypted root itself is a directory.
        let out = encrypt_file_in_place_if_needed(&h.deps(), &h.root).unwrap();
        assert_eq!(out, EncryptOutcome::NotRegularFile);
    }

    #[test]
    fn rejects_over_cap_with_payload_too_large() {
        // Sparse file: file_len advertises a huge size without using
        // that many bytes on disk. Linux/macOS support set_len on a
        // freshly-created empty file so the test runs inside a few ms.
        let h = setup("private", true);
        let big = h.root.join("huge.bin");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_INLINE_ENCRYPT_BYTES + 1).unwrap();
        drop(f);
        let canon = big.canonicalize().unwrap();
        let err = encrypt_file_in_place_if_needed(&h.deps(), &canon).unwrap_err();
        assert!(matches!(err, VaultError::PayloadTooLarge { .. }));
        // File untouched.
        let meta = std::fs::metadata(&canon).unwrap();
        assert_eq!(meta.len(), MAX_INLINE_ENCRYPT_BYTES + 1);
    }

    #[test]
    fn seal_pending_file_runs_while_registry_still_locked() {
        // Precondition: registry marks root as locked, BUT keyring has
        // the key. Simulates the unlock-drain window.
        let h = setup("private", false);
        // Hack the harness: insert the key but keep the registry locked.
        let salt = random_salt();
        let key = derive_key(b"pw", &salt).unwrap();
        let mut k = Zeroizing::new([0u8; 32]);
        k.copy_from_slice(key.as_slice());
        h.keyring.insert(h.root.clone(), k).unwrap();

        let dropped = h.root.join("leak.txt");
        std::fs::write(&dropped, b"plaintext content").unwrap();
        let canon = dropped.canonicalize().unwrap();
        let out = seal_pending_file(&h.deps(), &h.root, &canon).unwrap();
        assert!(matches!(out, EncryptOutcome::Sealed { .. }));
        let sealed = std::fs::read(&canon).unwrap();
        assert_eq!(&sealed[0..4], MAGIC);
    }
}
