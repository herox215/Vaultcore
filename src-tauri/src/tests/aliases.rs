// Unit tests for note aliases (issue #60).
//
// Covers:
//   - Frontmatter reader: list form, scalar form, missing key, malformed YAML.
//   - Resolution map: alias lookup, stem-vs-alias collision, alias-vs-alias
//     collision with first-indexed-wins ordering.

use std::path::PathBuf;

use crate::indexer::frontmatter::{extract_yaml_aliases, extract_yaml_tags, parse_frontmatter};
use crate::indexer::link_graph::resolved_map_with_aliases;
use crate::indexer::memory::{FileIndex, FileMeta};

// ── Frontmatter reader ─────────────────────────────────────────────────────────

#[test]
fn aliases_list_form_parses() {
    let content = "---\naliases: [UI, User Interface]\n---\nbody";
    assert_eq!(
        extract_yaml_aliases(content),
        vec!["ui".to_string(), "user interface".to_string()]
    );
}

#[test]
fn aliases_scalar_form_parses() {
    let content = "---\naliases: UI\n---\nbody";
    assert_eq!(extract_yaml_aliases(content), vec!["ui".to_string()]);
}

#[test]
fn aliases_missing_returns_empty() {
    let content = "---\ntitle: foo\n---\nbody";
    assert!(extract_yaml_aliases(content).is_empty());
}

#[test]
fn aliases_malformed_yaml_graceful_noop() {
    // Unterminated list — serde_yml::from_str returns Err, reader must not panic.
    let content = "---\naliases: [UI, Interface\n---\nbody";
    let fm = parse_frontmatter(content);
    assert!(fm.aliases.is_empty());
    assert!(fm.tags.is_empty());
}

#[test]
fn existing_tag_behaviour_unchanged() {
    // Regression guard — the shared reader must return the same shape for
    // the tag path that `tag_index` originally produced.
    let content = "---\ntags: [rust, work/meeting]\n---\nbody";
    assert_eq!(
        extract_yaml_tags(content),
        vec!["rust".to_string(), "work/meeting".to_string()]
    );
    let content = "---\ntags: single\n---\nbody";
    assert_eq!(extract_yaml_tags(content), vec!["single".to_string()]);
}

// ── Resolution map collision handling ──────────────────────────────────────────

fn make_file(idx: &mut FileIndex, rel: &str, aliases: Vec<String>) {
    idx.insert(
        PathBuf::from(format!("/vault/{}", rel)),
        FileMeta {
            relative_path: rel.to_string(),
            hash: "h".to_string(),
            title: rel.to_string(),
            aliases,
        },
    );
}

/// Build the `(rel_path, aliases)` slice in a deterministic order — used by the
/// collision tests to assert first-indexed-wins ordering.
fn file_alias_list(order: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    order
        .iter()
        .map(|(rel, aliases)| {
            (
                (*rel).to_string(),
                aliases.iter().map(|s| s.to_string()).collect(),
            )
        })
        .collect()
}

#[test]
fn alias_resolves_to_target_file() {
    let all_paths = vec!["notes/uinote.md".to_string()];
    let aliases = file_alias_list(&[("notes/uinote.md", &["ui", "user interface"])]);

    let map = resolved_map_with_aliases(&all_paths, &aliases);

    assert_eq!(
        map.get("ui").map(|s| s.as_str()),
        Some("notes/uinote.md"),
        "alias 'ui' should resolve to notes/uinote.md"
    );
    assert_eq!(
        map.get("user interface").map(|s| s.as_str()),
        Some("notes/uinote.md")
    );
    // Filename stem key is unaffected.
    assert_eq!(
        map.get("uinote").map(|s| s.as_str()),
        Some("notes/uinote.md")
    );
}

#[test]
fn stem_beats_alias_on_collision() {
    // File A is named `ui.md`, file B has alias 'UI'. Resolving `[[ui]]`
    // must pick A (stem) — alias never reaches the map for that key.
    let all_paths = vec!["a/ui.md".to_string(), "b/other.md".to_string()];
    let aliases = file_alias_list(&[("b/other.md", &["ui"])]);

    let map = resolved_map_with_aliases(&all_paths, &aliases);

    assert_eq!(
        map.get("ui").map(|s| s.as_str()),
        Some("a/ui.md"),
        "stem must win over alias"
    );
}

#[test]
fn alias_vs_alias_first_indexed_wins() {
    // Two files both declare alias 'ui'. The first-indexed file (order of the
    // file_aliases slice) wins; loser is ignored (log::info emitted but not
    // asserted here because the test harness doesn't capture log output).
    let all_paths = vec!["a/first.md".to_string(), "b/second.md".to_string()];
    let aliases = file_alias_list(&[
        ("a/first.md", &["ui"]),
        ("b/second.md", &["ui"]),
    ]);

    let map = resolved_map_with_aliases(&all_paths, &aliases);

    assert_eq!(
        map.get("ui").map(|s| s.as_str()),
        Some("a/first.md"),
        "first-indexed alias must win"
    );
}

#[test]
fn alias_stable_when_no_collision() {
    // Sanity: distinct aliases on distinct files both resolve.
    let all_paths = vec!["a/first.md".to_string(), "b/second.md".to_string()];
    let aliases = file_alias_list(&[
        ("a/first.md", &["alpha"]),
        ("b/second.md", &["beta"]),
    ]);

    let map = resolved_map_with_aliases(&all_paths, &aliases);

    assert_eq!(map.get("alpha").map(|s| s.as_str()), Some("a/first.md"));
    assert_eq!(map.get("beta").map(|s| s.as_str()), Some("b/second.md"));
}

#[test]
fn aliases_populated_into_file_meta_via_helper() {
    // Smoke test for the FileIndex mutator used by `IndexCmd::UpdateLinks`.
    let mut fi = FileIndex::new();
    make_file(&mut fi, "note.md", Vec::new());
    fi.set_aliases_for_rel("note.md", vec!["ui".to_string()]);

    let got = fi.aliases_for_rel("note.md");
    assert_eq!(got, vec!["ui".to_string()]);
}
