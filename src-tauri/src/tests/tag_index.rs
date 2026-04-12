// Unit tests for the tag_index module (Tasks 1 + 2, Plan 05-01).
//
// Tests 1–11: extract_inline_tags, extract_yaml_tags, TagIndex update/remove/list.
// Tests 12–15 (Task 2): watcher dispatch + serde shape.

use crate::indexer::tag_index::{extract_inline_tags, extract_yaml_tags, TagIndex, TagUsage};

// ── Test 1: inline flat tags ───────────────────────────────────────────────────

#[test]
fn test_inline_flat_tags() {
    let tags = extract_inline_tags("Hello #rust and #python today");
    assert_eq!(tags, vec!["rust", "python"]);
}

// ── Test 2: inline nested tags ─────────────────────────────────────────────────

#[test]
fn test_inline_nested_tags() {
    let tags = extract_inline_tags("Notes on #work/meeting");
    assert_eq!(tags, vec!["work/meeting"]);
}

// ── Test 3: inline URL boundary (must NOT match URL fragment) ──────────────────

#[test]
fn test_inline_url_boundary() {
    // "no#anchor" — '#' is preceded by a letter, so regex must NOT match.
    // "http://site#frag" — '#' is preceded by a letter (not whitespace/punct).
    let tags = extract_inline_tags("no#anchor in http://site#frag here");
    assert_eq!(tags, Vec::<String>::new());
}

// ── Test 4: inline leading-letter requirement ──────────────────────────────────

#[test]
fn test_inline_leading_letter() {
    // #123 must be rejected; #tag1 must be accepted.
    let tags = extract_inline_tags("#123 is not, #tag1 is");
    assert_eq!(tags, vec!["tag1"]);
}

// ── Test 5: inline case-fold dedupe ───────────────────────────────────────────

#[test]
fn test_inline_case_fold_dedupe() {
    let tags = extract_inline_tags("#Rust #RUST #rust");
    assert_eq!(tags, vec!["rust"]);
}

// ── Test 6: YAML list tags ─────────────────────────────────────────────────────

#[test]
fn test_yaml_list_tags() {
    let content = "---\ntags: [a, b, nested/tag]\n---\nbody";
    let tags = extract_yaml_tags(content);
    assert_eq!(tags, vec!["a", "b", "nested/tag"]);
}

// ── Test 7: YAML scalar tag ────────────────────────────────────────────────────

#[test]
fn test_yaml_scalar_tag() {
    let content = "---\ntags: single\n---\n...";
    let tags = extract_yaml_tags(content);
    assert_eq!(tags, vec!["single"]);
}

// ── Test 8: YAML absent tags key ──────────────────────────────────────────────

#[test]
fn test_yaml_absent_tags() {
    let content = "---\ntitle: foo\n---\n...";
    let tags = extract_yaml_tags(content);
    assert_eq!(tags, Vec::<String>::new());
}

// ── Test 9: no frontmatter ────────────────────────────────────────────────────

#[test]
fn test_yaml_no_frontmatter() {
    let content = "no dashes\ntags: [a]";
    let tags = extract_yaml_tags(content);
    assert_eq!(tags, Vec::<String>::new());
}

// ── Test 10: TagIndex update + remove ─────────────────────────────────────────

#[test]
fn test_tag_index_update_remove() {
    let mut idx = TagIndex::new();

    idx.update_file("notes/a.md", "Hello #rust today");
    let tags = idx.list_tags();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].tag, "rust");
    assert_eq!(tags[0].count, 1);

    idx.remove_file("notes/a.md");
    let tags = idx.list_tags();
    assert!(tags.is_empty());
}

// ── Test 11: TagIndex alpha sort + count; per-file uniqueness ─────────────────

#[test]
fn test_tag_index_alpha_sort_and_count() {
    let mut idx = TagIndex::new();

    // File 1: #rust (same tag twice inline — should count once per file)
    idx.update_file("a.md", "#rust is cool, I love #rust");
    // File 2: #rust and #python
    idx.update_file("b.md", "#python is great #rust too");
    // File 3: #python only
    idx.update_file("c.md", "Using #python everywhere");

    let tags = idx.list_tags();

    // Alphabetically sorted
    assert_eq!(tags[0].tag, "python");
    assert_eq!(tags[1].tag, "rust");

    // #python: 2 files (b.md, c.md)
    assert_eq!(tags[0].count, 2);
    // #rust: 2 files (a.md, b.md) — a.md mentioned it twice but counts once
    assert_eq!(tags[1].count, 2);
}

// ── Tests 12–15: Task 2 — watcher dispatch + serde shape ──────────────────────

use crate::indexer::IndexCmd;
use crate::watcher::dispatch_tag_index_cmd;
use notify_debouncer_full::{
    notify::{event::CreateKind, event::RemoveKind, Event, EventKind},
    DebouncedEvent,
};
use std::path::PathBuf;
use std::time::Instant;
use tokio::sync::mpsc;

fn make_debounced_event(kind: EventKind, path: PathBuf) -> DebouncedEvent {
    let event = Event {
        kind,
        paths: vec![path],
        attrs: Default::default(),
    };
    DebouncedEvent::new(event, Instant::now())
}

// ── Test 12: watcher dispatches UpdateTags on Create ──────────────────────────

#[tokio::test]
async fn test_watcher_dispatch_update_tags_on_create() {
    let (tx, mut rx) = mpsc::channel::<IndexCmd>(16);

    // Create a temp .md file so dispatch_tag_index_cmd can read its content.
    let tmp = tempfile::NamedTempFile::with_suffix(".md").unwrap();
    std::fs::write(tmp.path(), "Hello #rust").unwrap();

    let vault_path = tmp.path().parent().unwrap().to_path_buf();
    let ev = make_debounced_event(EventKind::Create(CreateKind::File), tmp.path().to_path_buf());

    dispatch_tag_index_cmd(&tx, &vault_path, &ev);

    let cmd = rx.try_recv().expect("expected one IndexCmd");
    match cmd {
        IndexCmd::UpdateTags { rel_path, .. } => {
            // rel_path uses forward slashes
            assert!(!rel_path.contains('\\'), "rel_path must use forward slashes");
        }
        other => panic!("expected UpdateTags, got {:?}", std::mem::discriminant(&other)),
    }
    assert!(rx.try_recv().is_err(), "expected exactly one command");
}

// ── Test 13: watcher dispatches RemoveTags on Remove ──────────────────────────

#[tokio::test]
async fn test_watcher_dispatch_remove_tags_on_delete() {
    let (tx, mut rx) = mpsc::channel::<IndexCmd>(16);

    let vault_path = PathBuf::from("/tmp/vault");
    let md_path = vault_path.join("note.md");

    let ev = make_debounced_event(EventKind::Remove(RemoveKind::File), md_path);

    dispatch_tag_index_cmd(&tx, &vault_path, &ev);

    let cmd = rx.try_recv().expect("expected one IndexCmd");
    assert!(
        matches!(cmd, IndexCmd::RemoveTags { .. }),
        "expected RemoveTags"
    );
    assert!(rx.try_recv().is_err(), "expected exactly one command");
}

// ── Test 14: watcher ignores non-.md files ─────────────────────────────────────

#[tokio::test]
async fn test_watcher_ignores_non_md_files() {
    let (tx, mut rx) = mpsc::channel::<IndexCmd>(16);

    let vault_path = PathBuf::from("/tmp/vault");

    // .txt file — must be ignored
    let txt_path = vault_path.join("note.txt");
    let ev = make_debounced_event(EventKind::Create(CreateKind::File), txt_path);
    dispatch_tag_index_cmd(&tx, &vault_path, &ev);

    // extensionless file — must be ignored
    let no_ext = vault_path.join("README");
    let ev2 = make_debounced_event(EventKind::Create(CreateKind::File), no_ext);
    dispatch_tag_index_cmd(&tx, &vault_path, &ev2);

    assert!(
        rx.try_recv().is_err(),
        "no commands should be sent for non-.md files"
    );
}

// ── Test 15: serde shape of TagUsage ──────────────────────────────────────────

#[test]
fn test_tag_usage_serde_shape() {
    let usage = TagUsage {
        tag: "rust".to_string(),
        count: 3,
    };
    let v = serde_json::to_value(&usage).unwrap();
    assert!(v.get("tag").is_some(), "must have 'tag' key");
    assert!(v.get("count").is_some(), "must have 'count' key");
    assert_eq!(v.get("tag").unwrap(), "rust");
    assert_eq!(v.get("count").unwrap(), 3);
}
