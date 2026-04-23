// Folder-level encrypt / lock / unlock primitives. Pure data
// operations — the IPC layer in `crate::commands::encryption` is
// responsible for state mutation (registry, keyring, manifest) and for
// driving progress events.

use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::encryption::crypto::{
    decrypt_bytes, encrypt_bytes, random_nonce, KEY_LEN, NONCE_LEN,
};
use crate::encryption::file_format::{frame, parse, write_atomic, MAGIC};
use crate::encryption::{SENTINEL_FILENAME, SENTINEL_PLAINTEXT};
use crate::error::VaultError;

/// Iterate every regular file strictly inside `root`. Used by the
/// encrypt/unlock batch operations.
///
/// An encrypted folder must seal every file it contains, not just the
/// `.md` notes — otherwise attachments (images pasted into notes, PDFs,
/// excalidraw canvases, CSV exports) would stay plaintext with no
/// warning, breaking the "folder is private" contract.
///
/// Skips:
/// - dot-prefixed directories (`.vaultcore/` sidecar, `.trash/`, `.git/`)
/// - dot-prefixed files (the sentinel `.vaultcore-folder-key-check`,
///   any hidden platform metadata)
/// - symlinks (`follow_links=false`), so a symlink into a locked folder
///   cannot be used to exfiltrate plaintext through the walk.
pub fn walk_all_under(root: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden dirs (e.g. .vaultcore, .trash, .git) and hidden
            // files (e.g. the sentinel we write ourselves).
            e.depth() == 0
                || !e
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
}

/// Encrypt one plaintext file in place. Reads, seals, writes atomically.
/// No-op (returns `Ok(false)`) when the file is already encrypted
/// (starts with the VCE1 magic) so a crashed/resumed encrypt batch is
/// idempotent over already-sealed files.
pub fn encrypt_file_in_place(
    key: &[u8; KEY_LEN],
    path: &Path,
) -> Result<bool, VaultError> {
    let bytes = fs::read(path).map_err(VaultError::Io)?;
    if bytes.starts_with(MAGIC) {
        return Ok(false);
    }
    let nonce: [u8; NONCE_LEN] = random_nonce();
    let ct = encrypt_bytes(key, &nonce, &bytes)?;
    let framed = frame(&nonce, &ct);
    write_atomic(path, &framed)?;
    Ok(true)
}

/// Decrypt one ciphertext file in place, back to plaintext bytes on
/// disk. Used by `lock`/`unlock` round-trips in tests and by the unlock
/// flow if the caller wants plaintext materialized on disk.
///
/// Note: the production IPC `unlock` path keeps files in their encrypted
/// on-disk form and decrypts on read (deferred to #345.2). This helper
/// is used by the encrypt-roundtrip tests now.
pub fn decrypt_file_to_plaintext(
    key: &[u8; KEY_LEN],
    path: &Path,
) -> Result<Vec<u8>, VaultError> {
    let bytes = fs::read(path).map_err(VaultError::Io)?;
    let (nonce, body) = parse(&bytes)?;
    decrypt_bytes(key, &nonce, body)
}

/// Write the per-folder sentinel that `unlock_folder` probes to verify
/// the candidate password.
pub fn write_sentinel(root: &Path, key: &[u8; KEY_LEN]) -> Result<(), VaultError> {
    let nonce = random_nonce();
    let ct = encrypt_bytes(key, &nonce, SENTINEL_PLAINTEXT)?;
    let framed = frame(&nonce, &ct);
    write_atomic(&root.join(SENTINEL_FILENAME), &framed)
}

/// Returns `Ok(true)` if the sentinel decrypts cleanly, `Err(WrongPassword)`
/// on AEAD tag failure (remapped from the generic `CryptoError` that
/// `decrypt_bytes` produces — this is the sentinel-probe layer, so a tag
/// mismatch means the password was wrong), and `CryptoError` for missing
/// or structurally-broken container files.
pub fn verify_sentinel(root: &Path, key: &[u8; KEY_LEN]) -> Result<bool, VaultError> {
    let path = root.join(SENTINEL_FILENAME);
    let bytes = fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::CryptoError {
            msg: format!(
                "sentinel file missing in {} — manifest claims encrypted but folder is not",
                root.display()
            ),
        },
        _ => VaultError::Io(e),
    })?;
    let (nonce, body) = parse(&bytes)?;
    match decrypt_bytes(key, &nonce, body) {
        Ok(pt) => Ok(pt == SENTINEL_PLAINTEXT),
        // Remap AEAD failure → WrongPassword because at the sentinel
        // layer the caller (unlock flow) is probing a candidate key.
        // A tag mismatch is always "bad password" here.
        Err(VaultError::CryptoError { .. }) => Err(VaultError::WrongPassword),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::crypto::derive_key;

    fn sample_tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("secret");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.md"), b"# A\n").unwrap();
        std::fs::write(root.join("sub/b.md"), b"# B\n").unwrap();
        // Non-md file and hidden file should be skipped.
        std::fs::write(root.join("note.txt"), b"ignore").unwrap();
        std::fs::write(root.join(".secret.md"), b"hidden").unwrap();
        (dir, root)
    }

    #[test]
    fn walk_all_under_covers_attachments_skips_hidden() {
        let (_g, root) = sample_tree();
        let mut files: Vec<_> = walk_all_under(&root)
            .map(|p| p.strip_prefix(&root).unwrap().to_path_buf())
            .collect();
        files.sort();
        // `note.txt` and `sub/b.md` must be in scope; hidden
        // `.secret.md` must not. The walker is deliberately extension-
        // agnostic so attachments don't fall out of encryption scope.
        assert_eq!(
            files,
            vec![
                PathBuf::from("a.md"),
                PathBuf::from("note.txt"),
                PathBuf::from("sub/b.md"),
            ]
        );
    }

    #[test]
    fn encrypt_then_decrypt_roundtrip_on_disk() {
        let (_g, root) = sample_tree();
        let key = derive_key(b"pw", b"saltsaltsaltsalt").unwrap();
        for p in walk_all_under(&root) {
            encrypt_file_in_place(&key, &p).unwrap();
        }
        // Each file now starts with VCE1 magic.
        let a = std::fs::read(root.join("a.md")).unwrap();
        assert_eq!(&a[0..4], MAGIC);
        // Decrypt back and compare.
        let pt_a = decrypt_file_to_plaintext(&key, &root.join("a.md")).unwrap();
        assert_eq!(pt_a, b"# A\n");
    }

    #[test]
    fn encrypt_is_idempotent_over_already_encrypted() {
        let (_g, root) = sample_tree();
        let key = derive_key(b"pw", b"saltsaltsaltsalt").unwrap();
        let path = root.join("a.md");
        assert!(encrypt_file_in_place(&key, &path).unwrap());
        let after_first = std::fs::read(&path).unwrap();
        // Second call is a no-op — file already starts with VCE1.
        assert!(!encrypt_file_in_place(&key, &path).unwrap());
        let after_second = std::fs::read(&path).unwrap();
        assert_eq!(after_first, after_second);
    }

    #[test]
    fn sentinel_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let key = derive_key(b"pw", b"saltsaltsaltsalt").unwrap();
        write_sentinel(dir.path(), &key).unwrap();
        assert!(verify_sentinel(dir.path(), &key).unwrap());
    }

    #[test]
    fn sentinel_wrong_key_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let k1 = derive_key(b"right", b"saltsaltsaltsalt").unwrap();
        let k2 = derive_key(b"wrong", b"saltsaltsaltsalt").unwrap();
        write_sentinel(dir.path(), &k1).unwrap();
        let err = verify_sentinel(dir.path(), &k2).unwrap_err();
        assert!(matches!(err, VaultError::WrongPassword));
    }
}
