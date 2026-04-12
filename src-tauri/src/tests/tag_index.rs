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

// ── Tests 12–15 are in this file too (added in Task 2) ────────────────────────
// They live below after the watcher + serde imports are available.

// ── Test 15: serde shape of TagUsage ──────────────────────────────────────────
// (Moved here early; tests 12-14 require watcher dispatch and are added in Task 2)

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
