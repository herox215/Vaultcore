// #360 — tests for `export_decrypted_file`: pull a plaintext copy of
// an encrypted file out to a user-chosen destination.
//
// The IPC lives in `commands::encryption`, but the tests mirror the
// same test-double pattern the rest of the crate uses — they call an
// `_impl` body that takes `&VaultState` so we do not need to
// construct a running Tauri app.

#![cfg(test)]

use std::path::PathBuf;

use tempfile::TempDir;
use zeroize::Zeroizing;

use crate::commands::encryption::export_decrypted_file_impl;
use crate::encryption::batch::{encrypt_file_in_place, write_sentinel};
use crate::encryption::crypto::{derive_key, random_salt};
use crate::encryption::file_format::MAGIC;
use crate::encryption::manifest::{upsert, EncryptedFolderMeta, FolderState};
use crate::error::VaultError;
use crate::VaultState;

/// Build a vault with one encrypted folder (`secret/`) containing a
/// sealed file. Returns the vault root, the encrypted root, and the
/// canonical path of the sealed file. The encrypted folder is UNLOCKED
/// by default (key in keyring, not in the locked registry).
struct SealedVault {
    _tmp: TempDir,
    vault: PathBuf,
    sealed_file: PathBuf,
    state: VaultState,
}

fn setup(unlocked: bool, plaintext: &[u8]) -> SealedVault {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().canonicalize().unwrap();
    let enc_root = vault.join("secret");
    std::fs::create_dir_all(&enc_root).unwrap();
    let salt = random_salt();
    upsert(
        &vault,
        EncryptedFolderMeta {
            path: "secret".into(),
            created_at: "2026-04-24T00:00:00Z".into(),
            salt: EncryptedFolderMeta::encode_salt(&salt),
            state: FolderState::Encrypted,
        },
    )
    .unwrap();
    let key = derive_key(b"pw", &salt).unwrap();
    write_sentinel(&enc_root, &key).unwrap();
    let sealed_file = enc_root.join("photo.png");
    std::fs::write(&sealed_file, plaintext).unwrap();
    encrypt_file_in_place(&key, &sealed_file).unwrap();
    let enc_root_canon = enc_root.canonicalize().unwrap();
    let sealed_canon = sealed_file.canonicalize().unwrap();

    let state = VaultState::default();
    *state.current_vault.lock().unwrap() = Some(vault.clone());
    state.manifest_cache.refresh_from_disk(&vault).unwrap();
    if unlocked {
        let mut k = Zeroizing::new([0u8; 32]);
        k.copy_from_slice(key.as_slice());
        state.keyring.insert(enc_root_canon.clone(), k).unwrap();
        // Default VaultState already has empty locked_paths — unlocked state.
    } else {
        state.locked_paths.lock_root(enc_root_canon.clone()).unwrap();
    }

    let _ = enc_root_canon; // enc_root_canon is kept as a debug aid
    SealedVault {
        _tmp: tmp,
        vault,
        sealed_file: sealed_canon,
        state,
    }
}

fn external_dest(sv: &SealedVault, name: &str) -> PathBuf {
    // Sibling of the vault so the dest parent is guaranteed NOT inside
    // any encrypted root.
    let parent = sv.vault.parent().expect("vault has parent").to_path_buf();
    parent.join(name)
}

#[test]
fn exports_plaintext_to_external_dest_when_unlocked() {
    let plaintext = b"\x89PNG\r\n\x1a\nfake-image-bytes";
    let sv = setup(true, plaintext);
    let dest = external_dest(&sv, "photo-export.png");

    export_decrypted_file_impl(
        &sv.state,
        sv.sealed_file.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
    )
    .expect("export should succeed");

    // Dest bytes match the original plaintext.
    let actual = std::fs::read(&dest).unwrap();
    assert_eq!(actual, plaintext);
    // Source remains sealed on disk.
    let source_on_disk = std::fs::read(&sv.sealed_file).unwrap();
    assert_eq!(&source_on_disk[0..4], MAGIC);
}

#[test]
fn rejects_locked_source_with_path_locked() {
    let sv = setup(false, b"secret");
    let dest = external_dest(&sv, "leak.bin");
    let err = export_decrypted_file_impl(
        &sv.state,
        sv.sealed_file.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
    )
    .expect_err("locked source must refuse");
    assert!(
        matches!(err, VaultError::PathLocked { .. }),
        "expected PathLocked, got {err:?}"
    );
    // Dest file must NOT have been created.
    assert!(!dest.exists(), "no plaintext artifact on refusal");
}

#[test]
fn rejects_source_outside_any_encrypted_root() {
    // A plain vault file has nothing to export.
    let sv = setup(true, b"anything");
    let plain = sv.vault.join("plain.md");
    std::fs::write(&plain, b"# plain\n").unwrap();
    let plain_canon = plain.canonicalize().unwrap();
    let dest = external_dest(&sv, "out.md");
    let err = export_decrypted_file_impl(
        &sv.state,
        plain_canon.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
    )
    .expect_err("plain source must refuse");
    assert!(
        matches!(err, VaultError::PermissionDenied { .. }),
        "expected PermissionDenied, got {err:?}"
    );
    assert!(!dest.exists());
}

#[test]
fn rejects_dest_inside_another_encrypted_root() {
    let sv = setup(true, b"payload");
    // Create a second encrypted folder in the same vault.
    let second = sv.vault.join("vault2");
    std::fs::create_dir_all(&second).unwrap();
    let salt2 = random_salt();
    upsert(
        &sv.vault,
        EncryptedFolderMeta {
            path: "vault2".into(),
            created_at: "t".into(),
            salt: EncryptedFolderMeta::encode_salt(&salt2),
            state: FolderState::Encrypted,
        },
    )
    .unwrap();
    sv.state.manifest_cache.refresh_from_disk(&sv.vault).unwrap();

    let dest_inside_other = second.join("smuggled.bin");
    let err = export_decrypted_file_impl(
        &sv.state,
        sv.sealed_file.to_string_lossy().into_owned(),
        dest_inside_other.to_string_lossy().into_owned(),
    )
    .expect_err("dest in another encrypted root must refuse");
    assert!(
        matches!(err, VaultError::PermissionDenied { .. }),
        "expected PermissionDenied, got {err:?}"
    );
    assert!(!dest_inside_other.exists());
}

#[test]
fn allows_dest_inside_vault_but_outside_every_encrypted_root() {
    // The feature explicitly allows exporting into a plain vault
    // subfolder — user may want a plaintext copy next to other
    // plain notes. The FS watcher will index the new plaintext file
    // via its normal Create → AddFile path; that is the expected
    // behavior (documented in the plan).
    let sv = setup(true, b"body");
    let plain_dir = sv.vault.join("plain");
    std::fs::create_dir_all(&plain_dir).unwrap();
    let dest = plain_dir.join("exported.bin");
    export_decrypted_file_impl(
        &sv.state,
        sv.sealed_file.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
    )
    .expect("plain-subdir dest must succeed");
    assert_eq!(std::fs::read(&dest).unwrap(), b"body");
}

#[test]
fn errors_when_dest_parent_does_not_exist() {
    let sv = setup(true, b"body");
    let missing_parent = external_dest(&sv, "nope/nested/out.bin");
    let err = export_decrypted_file_impl(
        &sv.state,
        sv.sealed_file.to_string_lossy().into_owned(),
        missing_parent.to_string_lossy().into_owned(),
    )
    .expect_err("missing dest parent must refuse");
    // Either FileNotFound (canonicalize on missing dir) or an io error
    // mapped through VaultError::Io; both acceptable. The contract is
    // that the SOURCE is untouched and NO partial file was created.
    match &err {
        VaultError::FileNotFound { .. } | VaultError::Io(_) => {}
        other => panic!("expected FileNotFound or Io, got {other:?}"),
    }
    // Source is still sealed.
    let still_sealed = std::fs::read(&sv.sealed_file).unwrap();
    assert_eq!(&still_sealed[0..4], MAGIC);
}

#[test]
fn source_remains_unchanged_after_successful_export() {
    let plaintext = b"attested plaintext";
    let sv = setup(true, plaintext);
    let dest = external_dest(&sv, "copy.bin");
    let before = std::fs::read(&sv.sealed_file).unwrap();
    export_decrypted_file_impl(
        &sv.state,
        sv.sealed_file.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
    )
    .unwrap();
    let after = std::fs::read(&sv.sealed_file).unwrap();
    assert_eq!(before, after, "source ciphertext must be byte-identical");
}
