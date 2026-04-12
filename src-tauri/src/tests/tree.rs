// Wave 2 tree.rs unit tests — list_directory command.
//
// These tests drive `list_directory_impl` which mirrors the body of the
// `#[tauri::command]` function in `commands/tree.rs`. The duplication is
// intentional: `tauri::State` cannot be constructed outside a running Tauri
// app.
//
// Test coverage:
//   Test 1: folder-first, alphabetical case-insensitive sort
//   Test 2: dot-prefixed entries are excluded
//   Test 3: symlinks are reported (is_symlink=true) but not followed
//   Test 4: non-.md files appear in results
//   Test 5: only one level of entries returned (no recursive descent)
//   Test 6: path outside vault → PermissionDenied
//   Test 7: three_way_merge skeleton compiles (no-op test)

use crate::commands::tree::list_directory_impl;
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

// Test 1: folders-first, alphabetical case-insensitive sort
#[test]
fn list_directory_sorts_folders_first_then_alphabetical() {
    let dir = tempdir().unwrap();
    // Create files and folders in non-alphabetical order
    fs::create_dir(dir.path().join("Zebra")).unwrap();
    fs::create_dir(dir.path().join("alpha")).unwrap();
    fs::write(dir.path().join("note.md"), "").unwrap();
    fs::write(dir.path().join("Another.md"), "").unwrap();
    let state = state_with_vault(dir.path());
    let result = list_directory_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    // Folders should come first
    let folders: Vec<&str> = result.iter().filter(|e| e.is_dir).map(|e| e.name.as_str()).collect();
    let files: Vec<&str> = result.iter().filter(|e| !e.is_dir).map(|e| e.name.as_str()).collect();
    // All folders before all files
    let folder_end_idx = result.iter().rposition(|e| e.is_dir).unwrap_or(0);
    let file_start_idx = result.iter().position(|e| !e.is_dir).unwrap_or(result.len());
    assert!(folder_end_idx < file_start_idx, "All folders should come before all files");
    // Folders alphabetical (case-insensitive)
    assert_eq!(folders, vec!["alpha", "Zebra"]);
    // Files alphabetical (case-insensitive)
    assert_eq!(files, vec!["Another.md", "note.md"]);
}

// Test 2: dot-prefixed entries are excluded
#[test]
fn list_directory_excludes_dot_prefixed_entries() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join(".obsidian")).unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join(".hidden_file"), "").unwrap();
    fs::write(dir.path().join("visible.md"), "").unwrap();
    let state = state_with_vault(dir.path());
    let result = list_directory_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    // Only visible.md should appear
    assert_eq!(result.len(), 1, "Only visible entries should appear");
    assert_eq!(result[0].name, "visible.md");
}

// Test 3: symlinks reported with is_symlink=true but not followed
#[cfg(unix)]
#[test]
fn list_directory_reports_symlinks_without_following() {
    let dir = tempdir().unwrap();
    let target_dir = tempdir().unwrap();
    // Create a real file inside the target dir
    fs::write(target_dir.path().join("inner.md"), "inner").unwrap();
    // Symlink points to target_dir from within our vault dir
    let symlink_path = dir.path().join("linked_dir");
    std::os::unix::fs::symlink(target_dir.path(), &symlink_path).unwrap();
    // Also create a symlinked file
    let file_target = dir.path().join("real.md");
    fs::write(&file_target, "real").unwrap();
    let symlink_file = dir.path().join("linked_file.md");
    std::os::unix::fs::symlink(&file_target, &symlink_file).unwrap();
    let state = state_with_vault(dir.path());
    let result = list_directory_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    // linked_dir should appear with is_symlink=true
    let linked = result.iter().find(|e| e.name == "linked_dir").expect("linked_dir should appear");
    assert!(linked.is_symlink, "Symlinked dir should have is_symlink=true");
    // Inner files from target_dir should NOT appear (not followed)
    let inner = result.iter().find(|e| e.name == "inner.md");
    assert!(inner.is_none(), "Inner files of symlinked dirs should not appear");
    // linked_file.md should appear with is_symlink=true
    let linked_file = result.iter().find(|e| e.name == "linked_file.md").expect("linked_file.md should appear");
    assert!(linked_file.is_symlink, "Symlinked file should have is_symlink=true");
}

// Test 4: non-.md files appear in results
#[test]
fn list_directory_includes_non_md_files() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("image.png"), "").unwrap();
    fs::write(dir.path().join("doc.txt"), "").unwrap();
    fs::write(dir.path().join("note.md"), "").unwrap();
    let state = state_with_vault(dir.path());
    let result = list_directory_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"image.png"), "image.png should appear");
    assert!(names.contains(&"doc.txt"), "doc.txt should appear");
    assert!(names.contains(&"note.md"), "note.md should appear");
    // Check is_md flag
    let md_entry = result.iter().find(|e| e.name == "note.md").unwrap();
    assert!(md_entry.is_md, "note.md should have is_md=true");
    let png_entry = result.iter().find(|e| e.name == "image.png").unwrap();
    assert!(!png_entry.is_md, "image.png should have is_md=false");
}

// Test 5: only one level of entries (no recursive descent)
#[test]
fn list_directory_returns_only_one_level() {
    let dir = tempdir().unwrap();
    let subdir = dir.path().join("subdir");
    fs::create_dir(&subdir).unwrap();
    fs::write(subdir.join("nested.md"), "").unwrap();
    fs::write(dir.path().join("root.md"), "").unwrap();
    let state = state_with_vault(dir.path());
    let result = list_directory_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    // Should only see "subdir" and "root.md", not "nested.md"
    let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"subdir"), "subdir should appear");
    assert!(names.contains(&"root.md"), "root.md should appear");
    assert!(!names.contains(&"nested.md"), "nested.md should NOT appear (one level only)");
    assert_eq!(result.len(), 2, "Exactly 2 entries expected at root level");
}

// Test 6: path outside vault → PermissionDenied
#[test]
fn list_directory_rejects_path_outside_vault() {
    let vault_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = list_directory_impl(&state, outside_dir.path().to_string_lossy().into_owned());
    match result {
        Err(VaultError::PermissionDenied { .. }) => {}
        other => panic!("expected PermissionDenied, got {:?}", other),
    }
}

// Test 7: three_way_merge skeleton compiles
#[test]
fn three_way_merge_skeleton_compiles() {
    // Just verify the function exists and returns MergeOutcome
    // Since it's a todo!(), we just verify the types compile correctly
    let _: fn(&str, &str, &str) -> crate::merge::MergeOutcome = crate::merge::three_way_merge;
}
