// #392 PR-B — `storage::validate_rel` is the structural rel-path guard
// shared by every backend. Backends layer their own canonical/SAF
// checks on top; this is the first line of defense against
// path-traversal and obviously-malformed paths.

#![cfg(test)]

use crate::error::VaultError;
use crate::storage::validate_rel;

#[test]
fn accepts_simple_rel_path() {
    assert!(validate_rel("note.md").is_ok());
    assert!(validate_rel("subdir/note.md").is_ok());
    assert!(validate_rel("a/b/c/deep.md").is_ok());
}

#[test]
fn accepts_empty_rel_path() {
    // Empty rel = "the vault root itself" — legitimate for `list_dir("")`.
    assert!(validate_rel("").is_ok());
}

#[test]
fn rejects_dotdot_segment() {
    match validate_rel("../escape") {
        Err(VaultError::PathOutsideVault { path }) => assert_eq!(path, "../escape"),
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn rejects_dotdot_in_subdir() {
    match validate_rel("subdir/../escape") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn rejects_dotdot_with_backslash_separator() {
    // Defense-in-depth: Windows-style separator from a copy-paste path.
    match validate_rel("subdir\\..\\escape") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn rejects_absolute_unix_path() {
    match validate_rel("/etc/passwd") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn rejects_absolute_windows_path() {
    match validate_rel("\\Windows\\System32") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn rejects_null_byte() {
    match validate_rel("note\0.md") {
        Err(VaultError::PathOutsideVault { .. }) => {}
        other => panic!("expected PathOutsideVault, got {other:?}"),
    }
}

#[test]
fn accepts_dot_segments_other_than_dotdot() {
    // Legitimate file names with dots — `.gitignore`, `.vaultcore`.
    assert!(validate_rel(".vaultcore/index/v.json").is_ok());
    assert!(validate_rel("note.with.dots.md").is_ok());
}

#[test]
fn accepts_filename_starting_with_dot_but_not_dotdot() {
    // `.hidden` is a single segment, not traversal.
    assert!(validate_rel(".hidden").is_ok());
    assert!(validate_rel("dir/.hidden").is_ok());
}
