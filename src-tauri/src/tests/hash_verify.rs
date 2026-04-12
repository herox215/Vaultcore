//! EDIT-10: Unit tests for get_file_hash command.
//!
//! Because `tauri::State` cannot be constructed outside a running Tauri app,
//! these tests call `get_file_hash_impl` directly (the testable implementation
//! split, following the `list_directory_impl` pattern in tree.rs).

use crate::commands::files;
use crate::hash::hash_bytes;
use crate::VaultState;
use std::fs;
use tempfile::TempDir;

fn make_state(vault_path: std::path::PathBuf) -> VaultState {
    let state = VaultState::default();
    *state.current_vault.lock().unwrap() = Some(vault_path);
    state
}

#[test]
fn get_file_hash_returns_sha256_of_bytes() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().canonicalize().unwrap();
    let file = vault.join("test.md");
    fs::write(&file, b"hello world").unwrap();
    let state = make_state(vault.clone());
    let expected = hash_bytes(b"hello world");
    let actual = files::get_file_hash_impl(&state, file.display().to_string()).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn get_file_hash_rejects_outside_vault() {
    let vault_tmp = TempDir::new().unwrap();
    let outside_tmp = TempDir::new().unwrap();
    let vault = vault_tmp.path().canonicalize().unwrap();
    let outside = outside_tmp.path().canonicalize().unwrap().join("secret.md");
    fs::write(&outside, b"secret").unwrap();
    let state = make_state(vault);
    let err = files::get_file_hash_impl(&state, outside.display().to_string()).unwrap_err();
    assert!(matches!(err, crate::error::VaultError::PermissionDenied { .. }));
}

#[test]
fn get_file_hash_returns_file_not_found_for_missing_path() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().canonicalize().unwrap();
    let missing = vault.join("does-not-exist.md");
    let state = make_state(vault);
    let err = files::get_file_hash_impl(&state, missing.display().to_string()).unwrap_err();
    assert!(matches!(err, crate::error::VaultError::FileNotFound { .. }));
}

#[test]
fn get_file_hash_is_deterministic_for_same_content() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().canonicalize().unwrap();
    let a = vault.join("a.md");
    let b = vault.join("b.md");
    fs::write(&a, b"same").unwrap();
    fs::write(&b, b"same").unwrap();
    let state = make_state(vault);
    let ha = files::get_file_hash_impl(&state, a.display().to_string()).unwrap();
    let hb = files::get_file_hash_impl(&state, b.display().to_string()).unwrap();
    assert_eq!(ha, hb);
}

#[test]
fn get_file_hash_changes_when_content_mutates() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path().canonicalize().unwrap();
    let f = vault.join("f.md");
    fs::write(&f, b"first").unwrap();
    let state = make_state(vault);
    let h1 = files::get_file_hash_impl(&state, f.display().to_string()).unwrap();
    fs::write(&f, b"second").unwrap();
    let h2 = files::get_file_hash_impl(&state, f.display().to_string()).unwrap();
    assert_ne!(h1, h2);
}
