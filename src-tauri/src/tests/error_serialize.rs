// ERR-01 tests — assert every VaultError variant serializes to the
// `{ kind, message, data }` IPC shape the frontend consumes.

use crate::error::VaultError;
use serde_json::{json, Value};

fn to_json(err: VaultError) -> Value {
    serde_json::to_value(err).unwrap()
}

#[test]
fn vault_error_serialize_file_not_found() {
    let v = to_json(VaultError::FileNotFound {
        path: "/a/b.md".into(),
    });
    assert_eq!(v["kind"], "FileNotFound");
    assert_eq!(v["message"], "File not found: /a/b.md");
    assert_eq!(v["data"], "/a/b.md");
}

#[test]
fn vault_error_serialize_permission_denied() {
    let v = to_json(VaultError::PermissionDenied { path: "/a".into() });
    assert_eq!(v["kind"], "PermissionDenied");
    assert_eq!(v["message"], "Permission denied: /a");
    assert_eq!(v["data"], "/a");
}

#[test]
fn vault_error_serialize_disk_full() {
    let v = to_json(VaultError::DiskFull);
    assert_eq!(v["kind"], "DiskFull");
    assert_eq!(v["message"], "Disk full");
    assert_eq!(v["data"], Value::Null);
}

#[test]
fn vault_error_serialize_index_corrupt() {
    let v = to_json(VaultError::IndexCorrupt);
    assert_eq!(v["kind"], "IndexCorrupt");
    assert_eq!(v["message"], "Index corrupt, rebuild needed");
    assert_eq!(v["data"], Value::Null);
}

#[test]
fn vault_error_serialize_vault_unavailable() {
    let v = to_json(VaultError::VaultUnavailable { path: "/x".into() });
    assert_eq!(v["kind"], "VaultUnavailable");
    assert_eq!(v["message"], "Vault unavailable: /x");
    assert_eq!(v["data"], "/x");
}

#[test]
fn vault_error_serialize_merge_conflict() {
    let v = to_json(VaultError::MergeConflict { path: "/y".into() });
    assert_eq!(v["kind"], "MergeConflict");
    assert_eq!(v["message"], "Merge conflict: /y");
    assert_eq!(v["data"], "/y");
}

#[test]
fn vault_error_serialize_invalid_encoding() {
    let v = to_json(VaultError::InvalidEncoding {
        path: "/z.bin".into(),
    });
    assert_eq!(v["kind"], "InvalidEncoding");
    assert_eq!(v["message"], "File is not UTF-8: /z.bin");
    assert_eq!(v["data"], "/z.bin");
}

#[test]
fn vault_error_serialize_lock_poisoned() {
    // Issue #136: LockPoisoned is a distinct variant so the frontend can
    // render "Internal error — please restart VaultCore" instead of the
    // generic "File system error" used for Io.
    let v = to_json(VaultError::LockPoisoned);
    assert_eq!(v["kind"], "LockPoisoned");
    assert_eq!(
        v["message"],
        "Internal state lock poisoned — please restart VaultCore",
    );
    assert_eq!(v["data"], Value::Null);
}

#[test]
fn vault_error_serialize_io() {
    let io_err = std::io::Error::other("boom");
    let v = to_json(VaultError::from(io_err));
    assert_eq!(v["kind"], "Io");
    assert_eq!(v["data"], Value::Null);
    // message contains the inner io::Error display
    assert!(v["message"].as_str().unwrap().contains("boom"));
}

#[test]
fn vault_error_serialize_path_locked() {
    // #345: gated FS/indexer entry points return PathLocked when a
    // canonical target sits inside a currently-locked encrypted root.
    // The IPC `data` field carries the path so the frontend can route
    // it through the unlock modal.
    let v = to_json(VaultError::PathLocked {
        path: "/vault/secret/note.md".into(),
    });
    assert_eq!(v["kind"], "PathLocked");
    assert_eq!(
        v["message"],
        "Path is inside a locked encrypted folder: /vault/secret/note.md",
    );
    assert_eq!(v["data"], "/vault/secret/note.md");
}

#[test]
fn vault_error_serialize_wrong_password() {
    // #345: returned by `unlock_folder` on AEAD tag failure. Data-less —
    // the modal pins the error to the active prompt, no path to route.
    let v = to_json(VaultError::WrongPassword);
    assert_eq!(v["kind"], "WrongPassword");
    assert_eq!(v["message"], "Wrong password");
    assert_eq!(v["data"], Value::Null);
}

#[test]
fn vault_error_serialize_crypto_error() {
    // #345: distinct from WrongPassword so the frontend can differentiate
    // "your password was wrong" from "the file is truncated/corrupt".
    // `data` stays Null — the `msg` ships via the `message` field; the
    // `data` field is reserved for routable paths by convention.
    let v = to_json(VaultError::CryptoError {
        msg: "container truncated".into(),
    });
    assert_eq!(v["kind"], "CryptoError");
    assert_eq!(v["message"], "Encryption error: container truncated");
    assert_eq!(v["data"], Value::Null);
}

#[test]
fn vault_error_serialize_path_outside_vault() {
    // #392: T-02 violation surfaced by PosixStorage's path-traversal
    // guard. The `path` field carries the user-supplied relative path
    // (NOT the resolved canonical) so the frontend's data-routing
    // contract still works — `data` is always a path the user typed,
    // never a leaked filesystem location.
    let v = to_json(VaultError::PathOutsideVault {
        path: "../escape.md".into(),
    });
    assert_eq!(v["kind"], "PathOutsideVault");
    assert_eq!(v["message"], "Path resolves outside the vault: ../escape.md");
    assert_eq!(v["data"], "../escape.md");
}

#[test]
fn vault_error_serialize_vault_permission_revoked() {
    // #392 PR-B: SAF tree URI grant was revoked. `data` is the URI so
    // the frontend's re-pick UX can route the user back through
    // pickVaultFolder() with no retyping.
    let v = to_json(VaultError::VaultPermissionRevoked {
        uri: "content://com.android.externalstorage.documents/tree/primary%3AVault".into(),
    });
    assert_eq!(v["kind"], "VaultPermissionRevoked");
    assert!(v["message"]
        .as_str()
        .unwrap()
        .starts_with("Vault permission revoked: content://"));
    assert_eq!(
        v["data"],
        "content://com.android.externalstorage.documents/tree/primary%3AVault"
    );
}

#[test]
fn vault_error_serialize_encryption_unsupported_on_android() {
    // #392 PR-B: encrypt_folder / unlock_folder etc. early-return with
    // this when the active vault is `content://`-rooted. Data-less —
    // the only relevant action is "wait for the #345 follow-up".
    let v = to_json(VaultError::EncryptionUnsupportedOnAndroid);
    assert_eq!(v["kind"], "EncryptionUnsupportedOnAndroid");
    assert_eq!(
        v["message"],
        "Encrypted folders are not yet supported on Android."
    );
    assert_eq!(v["data"], Value::Null);
}

#[test]
fn vault_error_serialize_picker_failed() {
    // #391: distinct from Io so the frontend can render a picker-specific
    // toast ("Could not open the file picker") instead of the generic
    // file-system error copy. `data` stays Null — the `msg` ships via the
    // `message` field; cancellation is signalled by `Ok(None)` from the
    // picker commands, not by an error variant.
    let v = to_json(VaultError::PickerFailed {
        msg: "picker channel closed".into(),
    });
    assert_eq!(v["kind"], "PickerFailed");
    assert_eq!(v["message"], "Picker failed: picker channel closed");
    assert_eq!(v["data"], Value::Null);
}

// Reference to silence unused-import lint if json! is dropped in the future.
#[allow(dead_code)]
fn _unused_json_reference() -> Value {
    json!({ "kind": "FileNotFound" })
}
