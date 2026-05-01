// #392 — round-trip tests for `PosixStorage`. Mirrors the desktop-only
// surface PR-A introduces; PR-B adds a sister `storage_android.rs`
// scaffold once `AndroidStorage` exists.

#![cfg(test)]

use crate::error::VaultError;
use crate::storage::{PosixStorage, VaultStorage};
use tempfile::TempDir;

fn fresh_storage() -> (TempDir, PosixStorage) {
    let dir = TempDir::new().expect("tempdir");
    // Canonicalize the vault root: this matches `open_vault`'s production
    // contract (the path comes via `VaultHandle::parse` which canonicalizes)
    // and is required for the T-02 `starts_with` guard to behave correctly
    // on macOS, where `/var/...` symlinks to `/private/var/...`.
    let canonical = std::fs::canonicalize(dir.path()).expect("canonicalize tempdir");
    let storage = PosixStorage::new(canonical);
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
        Err(VaultError::FileNotFound { path }) => assert_eq!(path, "nope.md"),
        other => panic!("expected FileNotFound, got {other:?}"),
    }
}

#[test]
fn metadata_path_returns_dot_vaultcore_under_root() {
    let dir = TempDir::new().expect("tempdir");
    let canonical = std::fs::canonicalize(dir.path()).unwrap();
    let storage = PosixStorage::new(canonical.clone());
    assert_eq!(storage.metadata_path(), canonical.join(".vaultcore"));
}

#[test]
fn exists_returns_false_for_missing() {
    let (_dir, storage) = fresh_storage();
    assert!(!storage.exists("ghost.md"));
}

// ── T-02 path-traversal guard ───────────────────────────────────────────────

#[test]
fn read_with_dotdot_escape_is_blocked() {
    // Set up a sibling file outside the vault that the attacker is
    // trying to read.
    let outer = TempDir::new().unwrap();
    let secret_path = outer.path().join("secret.txt");
    std::fs::write(&secret_path, b"top secret").unwrap();

    // Vault root sits inside `outer`, so `../secret.txt` would resolve
    // to a real file but outside the vault.
    let vault_dir = outer.path().join("vault");
    std::fs::create_dir(&vault_dir).unwrap();
    let canonical = std::fs::canonicalize(&vault_dir).unwrap();
    let storage = PosixStorage::new(canonical);

    match storage.read_file("../secret.txt") {
        Err(VaultError::PathOutsideVault { path }) => {
            assert_eq!(path, "../secret.txt");
        }
        Ok(_) => panic!("T-02 violation: dotdot escape was allowed to read"),
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn write_with_dotdot_escape_is_blocked() {
    let outer = TempDir::new().unwrap();
    let vault_dir = outer.path().join("vault");
    std::fs::create_dir(&vault_dir).unwrap();
    let canonical = std::fs::canonicalize(&vault_dir).unwrap();
    let storage = PosixStorage::new(canonical);

    // The parent of `../escape.md` (after canonicalize) is `outer`,
    // which does NOT start with `vault_dir` — guard fires.
    match storage.write_file("../escape.md", b"pwn") {
        Err(VaultError::PathOutsideVault { path }) => {
            assert_eq!(path, "../escape.md");
        }
        Ok(_) => panic!("T-02 violation: dotdot escape was allowed to write"),
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
    // And confirm nothing actually landed on disk outside the vault.
    assert!(!outer.path().join("escape.md").exists());
}

#[test]
fn create_dir_with_dotdot_escape_is_blocked() {
    let outer = TempDir::new().unwrap();
    let vault_dir = outer.path().join("vault");
    std::fs::create_dir(&vault_dir).unwrap();
    let canonical = std::fs::canonicalize(&vault_dir).unwrap();
    let storage = PosixStorage::new(canonical);

    match storage.create_dir("../sibling") {
        Err(VaultError::PathOutsideVault { path }) => {
            assert_eq!(path, "../sibling");
        }
        Ok(_) => panic!("T-02 violation: dotdot escape was allowed to mkdir"),
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
    assert!(!outer.path().join("sibling").exists());
}

#[test]
fn rename_to_dotdot_escape_is_blocked() {
    let outer = TempDir::new().unwrap();
    let vault_dir = outer.path().join("vault");
    std::fs::create_dir(&vault_dir).unwrap();
    let canonical = std::fs::canonicalize(&vault_dir).unwrap();
    let storage = PosixStorage::new(canonical);
    storage.write_file("inside.md", b"x").unwrap();

    match storage.rename("inside.md", "../escaped.md") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        Ok(_) => panic!("T-02 violation: rename leaked file out of vault"),
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
    // Source still in place.
    assert!(storage.exists("inside.md"));
    assert!(!outer.path().join("escaped.md").exists());
}

#[test]
fn exists_returns_false_for_dotdot_escape() {
    let outer = TempDir::new().unwrap();
    std::fs::write(outer.path().join("secret.txt"), b"x").unwrap();
    let vault_dir = outer.path().join("vault");
    std::fs::create_dir(&vault_dir).unwrap();
    let canonical = std::fs::canonicalize(&vault_dir).unwrap();
    let storage = PosixStorage::new(canonical);

    // The file exists physically, but `../secret.txt` resolves outside
    // the vault → guard returns Err, we map to false.
    assert!(!storage.exists("../secret.txt"));
}
