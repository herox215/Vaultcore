// Tests for bookmarks commands (#12).
// Mirrors the `_impl` test pattern used in files_ops.rs.

use crate::commands::bookmarks::{load_bookmarks_impl, save_bookmarks_impl};
use crate::VaultState;
use std::fs;
use tempfile::tempdir;

fn state_with_vault(root: &std::path::Path) -> VaultState {
    let canonical = fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(crate::storage::VaultHandle::Posix(canonical));
    s
}

#[test]
fn load_returns_empty_when_file_missing() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let result = load_bookmarks_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    assert_eq!(result, Vec::<String>::new());
}

#[test]
fn save_then_load_roundtrip() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let vault_path = dir.path().to_string_lossy().into_owned();
    let bookmarks = vec!["notes/a.md".to_string(), "notes/sub/b.md".to_string()];
    save_bookmarks_impl(&state, vault_path.clone(), bookmarks.clone()).unwrap();

    // .vaultcore/bookmarks.json exists
    let bookmarks_file = dir.path().join(".vaultcore").join("bookmarks.json");
    assert!(bookmarks_file.exists(), "bookmarks.json should exist");

    let loaded = load_bookmarks_impl(&state, vault_path).unwrap();
    assert_eq!(loaded, bookmarks);
}

#[test]
fn save_creates_vaultcore_dir_when_missing() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let vault_path = dir.path().to_string_lossy().into_owned();
    save_bookmarks_impl(&state, vault_path, vec!["x.md".to_string()]).unwrap();
    assert!(dir.path().join(".vaultcore").is_dir(), ".vaultcore/ should be created");
}

#[test]
fn save_overwrites_existing_file_atomically() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let vault_path = dir.path().to_string_lossy().into_owned();
    save_bookmarks_impl(&state, vault_path.clone(), vec!["one.md".to_string()]).unwrap();
    save_bookmarks_impl(&state, vault_path.clone(), vec!["two.md".to_string(), "three.md".to_string()]).unwrap();
    let loaded = load_bookmarks_impl(&state, vault_path).unwrap();
    assert_eq!(loaded, vec!["two.md".to_string(), "three.md".to_string()]);
}

#[test]
fn load_rejects_vault_path_not_matching_current_vault() {
    let vault_dir = tempdir().unwrap();
    let other_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = load_bookmarks_impl(&state, other_dir.path().to_string_lossy().into_owned());
    assert!(result.is_err(), "should reject non-matching vault path");
}

#[test]
fn save_rejects_vault_path_not_matching_current_vault() {
    let vault_dir = tempdir().unwrap();
    let other_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = save_bookmarks_impl(&state, other_dir.path().to_string_lossy().into_owned(), vec![]);
    assert!(result.is_err(), "should reject non-matching vault path");
}
