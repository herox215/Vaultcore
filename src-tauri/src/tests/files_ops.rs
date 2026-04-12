// Wave 2 file-operations unit tests — create_file, create_folder, rename_file,
// delete_file, move_file, count_wiki_links.
//
// These tests drive `_impl` helpers that mirror the body of the
// `#[tauri::command]` functions in `commands/files.rs`. The duplication is
// intentional: `tauri::State` cannot be constructed outside a running Tauri
// app.
//
// Test coverage:
//   Test 1: create_file with empty name creates "Untitled.md"
//   Test 2: create_file collision auto-suffixes to "Untitled 1.md"
//   Test 3: create_file with explicit name creates that file
//   Test 4: create_folder creates directory and returns path
//   Test 5: rename_file renames on disk, returns link_count=0 (no links)
//   Test 6: rename_file returns link_count>0 when wiki-links exist
//   Test 7: delete_file moves to .trash/, .trash/ auto-created, original gone
//   Test 8: delete_file collision in .trash/ auto-suffixes
//   Test 9: move_file moves file to target folder, returns new path
//   Test 10: move_file rejects destination outside vault (PermissionDenied)
//   Test 11: count_wiki_links scans all .md files for [[filename]] pattern

use crate::commands::files::{
    create_file_impl, create_folder_impl, rename_file_impl, delete_file_impl,
    move_file_impl, count_wiki_links_impl,
};
use crate::error::VaultError;
use crate::VaultState;
use std::fs;
use tempfile::tempdir;

fn state_with_vault(root: &std::path::Path) -> VaultState {
    let canonical = fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(canonical);
    s
}

// Test 1: create_file with empty name creates "Untitled.md"
#[test]
fn create_file_empty_name_creates_untitled() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let result = create_file_impl(&state, dir.path().to_string_lossy().into_owned(), "".into()).unwrap();
    let expected = dir.path().join("Untitled.md");
    assert!(expected.exists(), "Untitled.md should exist");
    assert_eq!(result, expected.to_string_lossy().into_owned());
}

// Test 2: create_file collision auto-suffixes
#[test]
fn create_file_collision_auto_suffixes() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    // First call creates Untitled.md
    create_file_impl(&state, dir.path().to_string_lossy().into_owned(), "".into()).unwrap();
    // Second call should create "Untitled 1.md"
    let result = create_file_impl(&state, dir.path().to_string_lossy().into_owned(), "".into()).unwrap();
    let expected = dir.path().join("Untitled 1.md");
    assert!(expected.exists(), "Untitled 1.md should exist");
    assert_eq!(result, expected.to_string_lossy().into_owned());
}

// Test 3: create_file with custom name
#[test]
fn create_file_with_custom_name() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let result = create_file_impl(&state, dir.path().to_string_lossy().into_owned(), "note.md".into()).unwrap();
    let expected = dir.path().join("note.md");
    assert!(expected.exists(), "note.md should exist");
    assert_eq!(result, expected.to_string_lossy().into_owned());
}

// Test 4: create_folder creates directory and returns path
#[test]
fn create_folder_creates_directory() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let result = create_folder_impl(&state, dir.path().to_string_lossy().into_owned(), "MyFolder".into()).unwrap();
    let expected = dir.path().join("MyFolder");
    assert!(expected.exists() && expected.is_dir(), "MyFolder dir should exist");
    assert_eq!(result, expected.to_string_lossy().into_owned());
}

// Test 5: rename_file renames on disk, returns link_count=0 when no links
#[test]
fn rename_file_renames_and_returns_zero_link_count() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let old_path = dir.path().join("old.md");
    fs::write(&old_path, "# content").unwrap();
    let result = rename_file_impl(
        &state,
        old_path.to_string_lossy().into_owned(),
        "new.md".into(),
    ).unwrap();
    let expected_new = dir.path().join("new.md");
    assert!(!old_path.exists(), "old.md should no longer exist");
    assert!(expected_new.exists(), "new.md should exist");
    assert_eq!(result.new_path, expected_new.to_string_lossy().into_owned());
    assert_eq!(result.link_count, 0);
}

// Test 6: rename_file returns link_count>0 when wiki-links exist
#[test]
fn rename_file_counts_wiki_links() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    // Create a file to rename
    let target = dir.path().join("myfile.md");
    fs::write(&target, "# My File").unwrap();
    // Create files that link to it
    fs::write(dir.path().join("linker1.md"), "See [[myfile]] for details").unwrap();
    fs::write(dir.path().join("linker2.md"), "Also [[myfile]] is great").unwrap();
    fs::write(dir.path().join("no_link.md"), "No links here").unwrap();
    let result = rename_file_impl(
        &state,
        target.to_string_lossy().into_owned(),
        "renamed.md".into(),
    ).unwrap();
    assert!(result.link_count >= 2, "Should have found at least 2 wiki-links, got {}", result.link_count);
}

// Test 7: delete_file moves to .trash/, auto-creates .trash/, original gone
#[test]
fn delete_file_moves_to_trash_and_removes_original() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let file_path = dir.path().join("deleteme.md");
    fs::write(&file_path, "content").unwrap();
    delete_file_impl(&state, file_path.to_string_lossy().into_owned()).unwrap();
    // Original should be gone
    assert!(!file_path.exists(), "Original file should be gone");
    // .trash/ should be created
    let trash_dir = dir.path().join(".trash");
    assert!(trash_dir.exists() && trash_dir.is_dir(), ".trash/ should be auto-created");
    // File should be in .trash/
    let trash_file = trash_dir.join("deleteme.md");
    assert!(trash_file.exists(), "deleteme.md should be in .trash/");
}

// Test 8: delete_file collision in .trash/ auto-suffixes
#[test]
fn delete_file_collision_in_trash_auto_suffixes() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    // Pre-populate .trash/ with a file of the same name
    let trash_dir = dir.path().join(".trash");
    fs::create_dir(&trash_dir).unwrap();
    fs::write(trash_dir.join("note.md"), "existing").unwrap();
    // Now delete a file with the same name
    let file_path = dir.path().join("note.md");
    fs::write(&file_path, "new content").unwrap();
    delete_file_impl(&state, file_path.to_string_lossy().into_owned()).unwrap();
    // Should create "note 1.md" in .trash/
    let suffixed = trash_dir.join("note 1.md");
    assert!(suffixed.exists(), "note 1.md should be created in .trash/ on collision");
}

// Test 9: move_file moves to target folder and returns new path
#[test]
fn move_file_moves_to_target_folder() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let source = dir.path().join("source.md");
    fs::write(&source, "move me").unwrap();
    let dest_folder = dir.path().join("subdir");
    fs::create_dir(&dest_folder).unwrap();
    let result = move_file_impl(
        &state,
        source.to_string_lossy().into_owned(),
        dest_folder.to_string_lossy().into_owned(),
    ).unwrap();
    let expected_dest = dest_folder.join("source.md");
    assert!(!source.exists(), "Source file should be gone");
    assert!(expected_dest.exists(), "File should be in destination folder");
    assert_eq!(result, expected_dest.to_string_lossy().into_owned());
}

// Test 10: move_file rejects destination outside vault
#[test]
fn move_file_rejects_outside_vault() {
    let vault_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let source = vault_dir.path().join("file.md");
    fs::write(&source, "content").unwrap();
    let result = move_file_impl(
        &state,
        source.to_string_lossy().into_owned(),
        outside_dir.path().to_string_lossy().into_owned(),
    );
    match result {
        Err(VaultError::PermissionDenied { .. }) => {}
        other => panic!("expected PermissionDenied, got {:?}", other),
    }
}

// Test 11: count_wiki_links scans all .md files for [[filename]] pattern
#[test]
fn count_wiki_links_counts_across_all_md_files() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    fs::write(dir.path().join("a.md"), "See [[target]] here and [[target]] again").unwrap();
    fs::write(dir.path().join("b.md"), "Also [[target]] in another file").unwrap();
    fs::write(dir.path().join("c.md"), "No link here").unwrap();
    let count = count_wiki_links_impl(&state, "target.md".into()).unwrap();
    assert_eq!(count, 3, "Expected 3 occurrences of [[target]] across all files");
}
