// #392 PR-B — host-side coverage for the rel-path semantics every
// non-Posix VaultStorage backend must satisfy. AndroidStorage's real
// implementation routes through JNI and can't be exercised here, but
// the structural contracts (validate_rel propagation, error mapping,
// list_dir flattening) are platform-agnostic and the mock locks them
// in.

#![cfg(test)]

use crate::error::VaultError;
use crate::storage::mock::MockAndroidStorage;
use crate::storage::VaultStorage;
use std::path::PathBuf;

fn fresh() -> MockAndroidStorage {
    MockAndroidStorage::new(PathBuf::from("/tmp/mock-vaultcore"))
}

#[test]
fn write_then_read_round_trips() {
    let s = fresh();
    s.write_file("note.md", b"hello").unwrap();
    assert_eq!(s.read_file("note.md").unwrap(), b"hello");
}

#[test]
fn read_missing_is_file_not_found() {
    let s = fresh();
    match s.read_file("ghost.md") {
        Err(VaultError::FileNotFound { path }) => assert_eq!(path, "ghost.md"),
        other => panic!("expected FileNotFound, got {other:?}"),
    }
}

#[test]
fn write_with_dotdot_is_path_outside_vault() {
    let s = fresh();
    match s.write_file("../escape", b"x") {
        Err(VaultError::PathOutsideVault { path }) => assert_eq!(path, "../escape"),
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn read_with_absolute_is_path_outside_vault() {
    let s = fresh();
    match s.read_file("/etc/passwd") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn rename_propagates_validate_rel_to_dest() {
    let s = fresh();
    s.write_file("inside.md", b"x").unwrap();
    match s.rename("inside.md", "../escaped.md") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault on rename dest, got {other:?}"),
    }
    // Source preserved.
    assert!(s.exists("inside.md"));
}

#[test]
fn delete_recursive_removes_subtree() {
    let s = fresh();
    s.create_dir("dir").unwrap();
    s.write_file("dir/a.md", b"a").unwrap();
    s.write_file("dir/sub/b.md", b"b").unwrap();
    s.delete("dir").unwrap();
    assert!(!s.exists("dir"));
    assert!(!s.exists("dir/a.md"));
    assert!(!s.exists("dir/sub/b.md"));
}

#[test]
fn list_dir_returns_immediate_children() {
    let s = fresh();
    s.write_file("a.md", b"").unwrap();
    s.write_file("b.md", b"").unwrap();
    s.write_file("dir/inner.md", b"").unwrap();
    s.create_dir("empty").unwrap();
    let mut names: Vec<String> = s
        .list_dir("")
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    names.sort();
    assert_eq!(names, vec!["a.md", "b.md", "dir", "empty"]);
}

#[test]
fn exists_false_on_traversal_attempt() {
    let s = fresh();
    s.write_file("inside.md", b"x").unwrap();
    // Even though `inside.md` exists, `../inside.md` is invalid.
    assert!(!s.exists("../inside.md"));
    assert!(s.exists("inside.md"));
}

#[test]
fn metadata_path_returns_constructor_arg() {
    let s = fresh();
    assert_eq!(s.metadata_path(), std::path::Path::new("/tmp/mock-vaultcore"));
}
