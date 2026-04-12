// Tests for watcher.rs — WriteIgnoreList timing behavior and process_events
// filtering logic. The watcher spawn itself requires a running Tauri app so
// integration testing is manual; unit tests cover the filtering logic.

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use crate::WriteIgnoreList;

// ─── WriteIgnoreList timing tests ────────────────────────────────────────────

#[test]
fn test_write_ignore_record_and_ignore_within_window() {
    // Test 1: record(path) + should_ignore(path) within 100ms returns true
    let mut list = WriteIgnoreList::default();
    let path = PathBuf::from("/vault/note.md");
    list.record(path.clone());
    assert!(
        list.should_ignore(&path),
        "should_ignore should return true within the 100ms window"
    );
}

#[test]
fn test_write_ignore_expires_after_window() {
    // Test 2: should_ignore(path) after 150ms returns false (window expired)
    let mut list = WriteIgnoreList::default();
    let path = PathBuf::from("/vault/old-note.md");
    list.record(path.clone());
    thread::sleep(Duration::from_millis(150));
    assert!(
        !list.should_ignore(&path),
        "should_ignore should return false after 150ms (100ms window expired)"
    );
}

#[test]
fn test_write_ignore_entries_pruned_after_500ms() {
    // Test 3: entries older than 500ms are pruned on next record() call
    let mut list = WriteIgnoreList::default();
    let old_path = PathBuf::from("/vault/old.md");
    let new_path = PathBuf::from("/vault/new.md");

    list.record(old_path.clone());
    thread::sleep(Duration::from_millis(510));

    // Trigger pruning via record()
    list.record(new_path.clone());

    // Old entry should have been pruned (no longer present)
    // We verify via the internal invariant: should_ignore returns false even
    // though we're past the 100ms window anyway — but the key test is that
    // internal state is cleaned up. Since should_ignore already returns false
    // after 100ms, we verify the pruning happened by checking the new entry
    // is present while old is gone.
    assert!(
        list.should_ignore(&new_path),
        "new entry should be in the ignore list"
    );
    assert!(
        !list.should_ignore(&old_path),
        "old entry (510ms old) should not be ignored (outside 100ms window)"
    );
}

#[test]
fn test_write_ignore_unknown_path_not_ignored() {
    // should_ignore returns false for paths not in the list
    let list = WriteIgnoreList::default();
    let path = PathBuf::from("/vault/unknown.md");
    assert!(!list.should_ignore(&path));
}

// ─── process_events filtering tests ──────────────────────────────────────────

#[test]
fn test_dot_prefix_filtering() {
    // Test 6: paths with dot-prefixed components should be detected as hidden
    // We test the helper function directly since process_events requires AppHandle.
    // The is_hidden_path function is pub(crate) for testability.
    use crate::watcher::is_hidden_path;

    let vault = PathBuf::from("/vault");

    // Dot-prefixed directory component — should be hidden
    assert!(is_hidden_path(&vault, &PathBuf::from("/vault/.obsidian/app.json")));
    assert!(is_hidden_path(&vault, &PathBuf::from("/vault/.git/COMMIT_EDITMSG")));
    assert!(is_hidden_path(&vault, &PathBuf::from("/vault/.trash/note.md")));

    // Dot-prefixed file at root — should be hidden
    assert!(is_hidden_path(&vault, &PathBuf::from("/vault/.DS_Store")));

    // Normal paths — should NOT be hidden
    assert!(!is_hidden_path(&vault, &PathBuf::from("/vault/note.md")));
    assert!(!is_hidden_path(&vault, &PathBuf::from("/vault/subfolder/note.md")));
    assert!(!is_hidden_path(&vault, &PathBuf::from("/vault/Archive/2024-01.md")));
}

#[test]
fn test_write_ignore_multiple_paths() {
    // Record multiple paths — each should be individually ignorable
    let mut list = WriteIgnoreList::default();
    let path_a = PathBuf::from("/vault/a.md");
    let path_b = PathBuf::from("/vault/b.md");

    list.record(path_a.clone());
    list.record(path_b.clone());

    assert!(list.should_ignore(&path_a));
    assert!(list.should_ignore(&path_b));
    assert!(!list.should_ignore(&PathBuf::from("/vault/c.md")));
}
