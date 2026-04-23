// On-disk container for encrypted `.md` files.
//
// Layout (version 1):
//   [0..4]   magic    = b"VCE1"  (ASCII; version bump = new magic, e.g. "VCE2")
//   [4..28]  nonce    24 bytes, random per file
//   [28..]   ciphertext ++ 16-byte Poly1305 tag (from XChaCha20-Poly1305)
//
// Partial-write protection: write to `<target>.vce-tmp-<pid>-<rand>` in the
// same directory, sync, then `fs::rename` to the target. Per-file atomic
// replace — NOT a WAL, just the std::fs::rename contract. A half-written
// ciphertext is unrecoverable even with the correct password; a clean
// tempfile rename converts that failure mode into "no change at all".

use std::fs;
use std::io::Write;
use std::path::Path;

use rand::RngCore;

use crate::encryption::crypto::{NONCE_LEN, TAG_LEN};
use crate::error::VaultError;

pub const MAGIC: &[u8; 4] = b"VCE1";
pub const HEADER_LEN: usize = 4 + NONCE_LEN; // 28
pub const MIN_FILE_LEN: usize = HEADER_LEN + TAG_LEN; // 44

/// Assemble on-disk bytes: magic ++ nonce ++ ciphertext_and_tag.
pub fn frame(nonce: &[u8; NONCE_LEN], ciphertext_and_tag: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext_and_tag.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(nonce);
    out.extend_from_slice(ciphertext_and_tag);
    out
}

/// Parse on-disk bytes. Distinguishes truncated / wrong-magic from AEAD
/// failure — the caller (unlock/decrypt path) needs to tell a tampered
/// plaintext file from a wrong password so UX messaging can be accurate.
pub fn parse(bytes: &[u8]) -> Result<([u8; NONCE_LEN], &[u8]), VaultError> {
    if bytes.len() < MIN_FILE_LEN {
        return Err(VaultError::CryptoError {
            msg: format!(
                "encrypted container truncated: {} bytes, need ≥ {}",
                bytes.len(),
                MIN_FILE_LEN
            ),
        });
    }
    if &bytes[0..4] != MAGIC {
        return Err(VaultError::CryptoError {
            msg: "not a VCE1 encrypted container (wrong magic)".into(),
        });
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[4..HEADER_LEN]);
    Ok((nonce, &bytes[HEADER_LEN..]))
}

/// Write `bytes` to `target` atomically (temp-file + rename). The temp
/// lives in the same directory so `rename` is a single-FS syscall.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    let parent = target.parent().ok_or_else(|| VaultError::PermissionDenied {
        path: target.display().to_string(),
    })?;
    let mut rand_buf = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut rand_buf);
    let suffix: String = rand_buf.iter().map(|b| format!("{:02x}", b)).collect();
    let tmp_name = format!(
        ".vce-tmp-{}-{}",
        std::process::id(),
        suffix,
    );
    let tmp = parent.join(tmp_name);

    let write_result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(VaultError::Io(e));
    }

    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(VaultError::Io(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::crypto::{decrypt_bytes, derive_key, encrypt_bytes, random_nonce};

    #[test]
    fn frame_then_parse_roundtrip() {
        let nonce = random_nonce();
        let body = vec![9u8; 40]; // ciphertext+tag filler
        let bytes = frame(&nonce, &body);
        let (n2, rest) = parse(&bytes).unwrap();
        assert_eq!(n2, nonce);
        assert_eq!(rest, body.as_slice());
    }

    #[test]
    fn parse_rejects_truncated_file() {
        let err = parse(&[1u8; 10]).unwrap_err();
        match err {
            VaultError::CryptoError { msg } => assert!(msg.contains("truncated")),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_wrong_magic() {
        let mut bytes = vec![0u8; MIN_FILE_LEN];
        bytes[0..4].copy_from_slice(b"XXXX");
        let err = parse(&bytes).unwrap_err();
        match err {
            VaultError::CryptoError { msg } => assert!(msg.contains("wrong magic")),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn write_atomic_leaves_no_tempfile_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        write_atomic(&target, b"content").unwrap();
        // No `.vce-tmp-*` leftover.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".vce-tmp-")
            })
            .collect();
        assert!(leftovers.is_empty(), "tempfile leaked");
        assert_eq!(std::fs::read(&target).unwrap(), b"content");
    }

    #[test]
    fn frame_crypto_end_to_end() {
        let key = derive_key(b"pw", b"saltsaltsaltsalt").unwrap();
        let nonce = random_nonce();
        let ct = encrypt_bytes(&key, &nonce, b"secret doc").unwrap();
        let on_disk = frame(&nonce, &ct);
        let (nonce_back, body) = parse(&on_disk).unwrap();
        let pt = decrypt_bytes(&key, &nonce_back, body).unwrap();
        assert_eq!(pt, b"secret doc");
    }
}
