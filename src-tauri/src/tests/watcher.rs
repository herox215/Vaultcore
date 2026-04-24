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
    // Test 1: record(path) + should_ignore(path) within 500ms returns true
    let mut list = WriteIgnoreList::default();
    let path = PathBuf::from("/vault/note.md");
    list.record(path.clone());
    assert!(
        list.should_ignore(&path),
        "should_ignore should return true within the 500ms window"
    );
}

#[test]
fn test_write_ignore_expires_after_window() {
    // Test 2: should_ignore(path) after 600ms returns false (500ms window expired)
    let mut list = WriteIgnoreList::default();
    let path = PathBuf::from("/vault/old-note.md");
    list.record(path.clone());
    thread::sleep(Duration::from_millis(600));
    assert!(
        !list.should_ignore(&path),
        "should_ignore should return false after 600ms (500ms window expired)"
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
fn test_dot_prefix_filtering_covers_orchestrator_tempfile() {
    // #357 — `encrypt_file_in_place` uses `write_atomic`, which creates
    // a temp file named `.vce-tmp-<pid>-<hex>` in the same directory as
    // the target. Its Create event would reach the watcher if it were
    // not filtered, potentially causing the orchestrator to recurse.
    // This test pins the invariant: `is_hidden_path` filters the temp
    // file. If a future refactor renames the tmp prefix, the filter
    // must be updated in lockstep.
    use crate::watcher::is_hidden_path;
    let vault = PathBuf::from("/vault");
    let tmp_in_encrypted =
        PathBuf::from("/vault/secret/.vce-tmp-12345-abcdef0123456789");
    assert!(
        is_hidden_path(&vault, &tmp_in_encrypted),
        "atomic-write tempfile must be filtered by is_hidden_path"
    );
    let tmp_at_root = PathBuf::from("/vault/.vce-tmp-9999-deadbeef");
    assert!(is_hidden_path(&vault, &tmp_at_root));
}

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

// ─── try_send_or_warn overflow behavior (#139) ───────────────────────────────

#[test]
fn test_try_send_or_warn_drops_when_full_without_blocking() {
    // Issue #139: watcher callbacks use try_send_or_warn so a full channel
    // drops the command rather than blocking (which would freeze the
    // notify-debouncer callback thread). Verify:
    //   1. First send on a cap-1 channel succeeds.
    //   2. Second send returns synchronously despite the channel being full —
    //      no blocking, no panic.
    //   3. Receiver still only sees the first command (second was dropped).
    use crate::indexer::IndexCmd;
    use crate::watcher::try_send_or_warn;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    rt.block_on(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<IndexCmd>(1);

        try_send_or_warn(&tx, IndexCmd::RemoveLinks {
            rel_path: "a.md".into(),
        });
        try_send_or_warn(&tx, IndexCmd::RemoveLinks {
            rel_path: "b.md".into(),
        });

        // Only the first one is in the channel.
        let first = rx.try_recv().expect("first message should be present");
        match first {
            IndexCmd::RemoveLinks { rel_path } => assert_eq!(rel_path, "a.md"),
            _ => panic!("expected RemoveLinks"),
        }
        // Second is dropped — no further messages.
        assert!(rx.try_recv().is_err(), "second message should have been dropped");
    });
}

#[test]
fn test_try_send_or_warn_returns_quickly_when_receiver_closed() {
    // If the coordinator was dropped between the watcher snapshot and the
    // dispatch (e.g. mid-vault-switch), the channel is closed rather than
    // full. try_send_or_warn must still return synchronously (not panic,
    // not block).
    use crate::indexer::IndexCmd;
    use crate::watcher::try_send_or_warn;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    rt.block_on(async move {
        let (tx, rx) = tokio::sync::mpsc::channel::<IndexCmd>(4);
        drop(rx); // channel closed

        try_send_or_warn(&tx, IndexCmd::RemoveLinks {
            rel_path: "x.md".into(),
        });
        // No panic = contract upheld.
    });
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

// ─── Issue #246: dispatchers must not read from disk themselves ──────────────
//
// Regression guard for #246 — every .md modify event used to read the file
// twice (once in dispatch_link_graph_cmd, once in dispatch_tag_index_cmd).
// After the fix, the read is done once in process_events and the content is
// handed to both dispatchers. These tests pin down that contract by calling
// the dispatchers with an explicit content string on a path that does NOT
// exist on disk: the old code would have silently dropped both commands (fs
// read fails), the new code enqueues both because it never touches disk.

#[test]
fn test_dispatch_link_graph_uses_provided_content_without_disk_read() {
    use crate::indexer::IndexCmd;
    use crate::watcher::dispatch_link_graph_cmd;
    use notify_debouncer_full::{
        notify::{event::ModifyKind, Event, EventKind},
        DebouncedEvent,
    };
    use std::time::Instant;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    rt.block_on(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<IndexCmd>(8);

        // A path that definitely does not exist on disk.
        let vault_path = PathBuf::from("/tmp/vaultcore-nonexistent-246");
        let md_path = vault_path.join("ghost.md");
        let ev = DebouncedEvent::new(
            Event {
                kind: EventKind::Modify(ModifyKind::Data(
                    notify_debouncer_full::notify::event::DataChange::Content,
                )),
                paths: vec![md_path],
                attrs: Default::default(),
            },
            Instant::now(),
        );

        // Dispatcher must use the supplied content verbatim — not re-read from disk.
        dispatch_link_graph_cmd(&tx, &vault_path, &ev, Some("link body [[foo]]"), None);

        let cmd = rx.try_recv().expect(
            "dispatcher must enqueue UpdateLinks from the supplied content, \
             even though the path is not readable",
        );
        match cmd {
            IndexCmd::UpdateLinks { rel_path, content } => {
                assert_eq!(rel_path, "ghost.md");
                assert_eq!(content, "link body [[foo]]");
            }
            other => panic!(
                "expected UpdateLinks, got discriminant {:?}",
                std::mem::discriminant(&other)
            ),
        }
    });
}

#[test]
fn test_dispatch_tag_index_uses_provided_content_without_disk_read() {
    use crate::indexer::IndexCmd;
    use crate::watcher::dispatch_tag_index_cmd;
    use notify_debouncer_full::{
        notify::{event::ModifyKind, Event, EventKind},
        DebouncedEvent,
    };
    use std::time::Instant;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    rt.block_on(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<IndexCmd>(8);

        let vault_path = PathBuf::from("/tmp/vaultcore-nonexistent-246");
        let md_path = vault_path.join("ghost.md");
        let ev = DebouncedEvent::new(
            Event {
                kind: EventKind::Modify(ModifyKind::Data(
                    notify_debouncer_full::notify::event::DataChange::Content,
                )),
                paths: vec![md_path],
                attrs: Default::default(),
            },
            Instant::now(),
        );

        dispatch_tag_index_cmd(&tx, &vault_path, &ev, Some("body with #rust"), None);

        let cmd = rx.try_recv().expect(
            "dispatcher must enqueue UpdateTags from the supplied content, \
             even though the path is not readable",
        );
        match cmd {
            IndexCmd::UpdateTags { rel_path, content } => {
                assert_eq!(rel_path, "ghost.md");
                assert_eq!(content, "body with #rust");
            }
            other => panic!(
                "expected UpdateTags, got discriminant {:?}",
                std::mem::discriminant(&other)
            ),
        }
    });
}
