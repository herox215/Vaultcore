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
fn vault_error_serialize_io() {
    let io_err = std::io::Error::other("boom");
    let v = to_json(VaultError::from(io_err));
    assert_eq!(v["kind"], "Io");
    assert_eq!(v["data"], Value::Null);
    // message contains the inner io::Error display
    assert!(v["message"].as_str().unwrap().contains("boom"));
}

// Reference to silence unused-import lint if json! is dropped in the future.
#[allow(dead_code)]
fn _unused_json_reference() -> Value {
    json!({ "kind": "FileNotFound" })
}
