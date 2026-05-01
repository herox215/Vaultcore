// #392 — round-trip tests for `PosixStorage`. Mirrors the desktop-only
// surface PR-A introduces; PR-B adds a sister `storage_android.rs`
// scaffold once `AndroidStorage` exists.

#![cfg(test)]

use crate::storage::{PosixStorage, VaultStorage};
use tempfile::TempDir;

fn fresh_storage() -> (TempDir, PosixStorage) {
    let dir = TempDir::new().expect("tempdir");
    let storage = PosixStorage::new(dir.path().to_path_buf());
    (dir, storage)
}

#[test]
fn write_then_read_round_trips() {
    let (_dir, storage) = fresh_storage();
    storage.write_file("note.md", b"hello vault").unwrap();
    let bytes = storage.read_file("note.md").unwrap();
    assert_eq!(bytes, b"hello vault");
}

#[test]
fn create_file_writes_initial_bytes() {
    let (_dir, storage) = fresh_storage();
    storage.create_file("a.md", b"seed").unwrap();
    assert_eq!(storage.read_file("a.md").unwrap(), b"seed");
}

#[test]
fn create_dir_then_write_into_it() {
    let (_dir, storage) = fresh_storage();
    storage.create_dir("subdir").unwrap();
    storage.write_file("subdir/note.md", b"nested").unwrap();
    assert_eq!(storage.read_file("subdir/note.md").unwrap(), b"nested");
}

#[test]
fn delete_removes_file() {
    let (_dir, storage) = fresh_storage();
    storage.write_file("doomed.md", b"x").unwrap();
    assert!(storage.exists("doomed.md"));
    storage.delete("doomed.md").unwrap();
    assert!(!storage.exists("doomed.md"));
}

#[test]
fn delete_recursively_removes_dir() {
    let (_dir, storage) = fresh_storage();
    storage.create_dir("victim").unwrap();
    storage.write_file("victim/inner.md", b"x").unwrap();
    storage.delete("victim").unwrap();
    assert!(!storage.exists("victim"));
}

#[test]
fn rename_moves_file() {
    let (_dir, storage) = fresh_storage();
    storage.write_file("old.md", b"x").unwrap();
    storage.rename("old.md", "new.md").unwrap();
    assert!(!storage.exists("old.md"));
    assert!(storage.exists("new.md"));
    assert_eq!(storage.read_file("new.md").unwrap(), b"x");
}

#[test]
fn metadata_returns_size_and_dir_flag() {
    let (_dir, storage) = fresh_storage();
    storage.write_file("note.md", b"abc").unwrap();
    storage.create_dir("inner").unwrap();
    let f = storage.metadata("note.md").unwrap();
    assert_eq!(f.size, 3);
    assert!(!f.is_dir);
    let d = storage.metadata("inner").unwrap();
    assert!(d.is_dir);
}

#[test]
fn list_dir_returns_children() {
    let (_dir, storage) = fresh_storage();
    storage.write_file("a.md", b"").unwrap();
    storage.write_file("b.md", b"").unwrap();
    storage.create_dir("sub").unwrap();
    let mut names: Vec<String> = storage
        .list_dir("")
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    names.sort();
    assert_eq!(names, vec!["a.md", "b.md", "sub"]);
}

#[test]
fn read_missing_file_maps_to_file_not_found() {
    let (_dir, storage) = fresh_storage();
    match storage.read_file("nope.md") {
        Err(crate::error::VaultError::FileNotFound { path }) => assert_eq!(path, "nope.md"),
        other => panic!("expected FileNotFound, got {other:?}"),
    }
}

#[test]
fn metadata_path_returns_dot_vaultcore_under_root() {
    let (dir, storage) = fresh_storage();
    assert_eq!(storage.metadata_path(), dir.path().join(".vaultcore"));
}

#[test]
fn exists_returns_false_for_missing() {
    let (_dir, storage) = fresh_storage();
    assert!(!storage.exists("ghost.md"));
}
