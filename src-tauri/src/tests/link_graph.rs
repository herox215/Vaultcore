// Unit tests for the link_graph module.
//
// Tests cover:
// - extract_links: basic, alias, empty
// - resolve_link: same-folder, shortest-path, alpha-tiebreak, not-found
// - LinkGraph: update_file, backlinks, remove_file, incremental replace
// - get_unresolved
// - resolved_map: unique stems, ambiguous stems (shortest-path winner)

use crate::indexer::link_graph::{
    extract_links, resolve_link, resolved_map, LinkGraph,
};
use crate::indexer::memory::{FileIndex, FileMeta};

fn make_file_index(entries: &[(&str, &str)]) -> FileIndex {
    let mut fi = FileIndex::new();
    for (rel, title) in entries {
        fi.insert(
            std::path::PathBuf::from(format!("/vault/{}", rel)),
            FileMeta {
                relative_path: rel.to_string(),
                hash: "abc".to_string(),
                title: title.to_string(),
            },
        );
    }
    fi
}

// ── extract_links ──────────────────────────────────────────────────────────────

#[test]
fn test_extract_links_basic() {
    let links = extract_links("Some text [[Note]] here");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Note");
    assert!(links[0].alias.is_none());
    assert_eq!(links[0].line_number, 0);
}

#[test]
fn test_extract_links_alias() {
    let links = extract_links("[[Other|alias text]]");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Other");
    assert_eq!(links[0].alias, Some("alias text".to_string()));
}

#[test]
fn test_extract_links_empty() {
    let links = extract_links("No links here");
    assert!(links.is_empty());
}

#[test]
fn test_extract_links_multiple_on_same_line() {
    let links = extract_links("See [[Note]] and [[Other|alias]] here");
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].target_raw, "Note");
    assert_eq!(links[1].target_raw, "Other");
    assert_eq!(links[1].alias, Some("alias".to_string()));
}

#[test]
fn test_extract_links_multiline() {
    let content = "Line 0 [[NoteA]]\nLine 1 text\nLine 2 [[NoteB]]";
    let links = extract_links(content);
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].line_number, 0);
    assert_eq!(links[1].line_number, 2);
}

#[test]
fn test_extract_links_code_block_included() {
    // Rust indexes ALL links for graph completeness; code-block exclusion is CM6's job
    let content = "```\n[[CodeBlock]]\n```";
    let links = extract_links(content);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "CodeBlock");
}

// ── resolve_link ───────────────────────────────────────────────────────────────

#[test]
fn test_resolve_same_folder() {
    let all = vec![
        "folder/Note.md".to_string(),
        "other/Note.md".to_string(),
    ];
    let result = resolve_link("Note", "folder/", &all);
    assert_eq!(result.as_deref(), Some("folder/Note.md"));
}

#[test]
fn test_resolve_shortest_path() {
    let all = vec![
        "b/Note.md".to_string(),
        "c/d/Note.md".to_string(),
    ];
    let result = resolve_link("Note", "a/", &all);
    assert_eq!(result.as_deref(), Some("b/Note.md"));
}

#[test]
fn test_resolve_alpha_tiebreak() {
    let all = vec![
        "b/Note.md".to_string(),
        "c/Note.md".to_string(),
    ];
    let result = resolve_link("Note", "a/", &all);
    // Both are 1 segment deep from root, "b/Note.md" < "c/Note.md" alphabetically
    assert_eq!(result.as_deref(), Some("b/Note.md"));
}

#[test]
fn test_resolve_not_found() {
    let all = vec!["b/Other.md".to_string()];
    let result = resolve_link("Missing", "a/", &all);
    assert!(result.is_none());
}

#[test]
fn test_resolve_with_md_suffix() {
    // target_raw may include .md suffix — strip it before matching
    let all = vec!["folder/Note.md".to_string()];
    let result = resolve_link("Note.md", "folder/", &all);
    assert_eq!(result.as_deref(), Some("folder/Note.md"));
}

// ── LinkGraph ──────────────────────────────────────────────────────────────────

#[test]
fn test_link_graph_update_and_backlinks() {
    let mut graph = LinkGraph::new();
    let all = vec!["a/Source.md".to_string(), "b/Target.md".to_string()];

    let links = extract_links("See [[Target]] here");
    graph.update_file("a/Source.md", links, &all);

    let fi = make_file_index(&[("b/Target.md", "Target")]);
    let backlinks = graph.get_backlinks("b/Target.md", &fi);
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_path, "a/Source.md");
}

#[test]
fn test_link_graph_remove_file() {
    let mut graph = LinkGraph::new();
    let all = vec!["a/Source.md".to_string(), "b/Target.md".to_string()];

    let links = extract_links("See [[Target]] here");
    graph.update_file("a/Source.md", links, &all);
    graph.remove_file("a/Source.md");

    let fi = make_file_index(&[("b/Target.md", "Target")]);
    let backlinks = graph.get_backlinks("b/Target.md", &fi);
    assert!(backlinks.is_empty());
}

#[test]
fn test_link_graph_incremental_replace() {
    let mut graph = LinkGraph::new();
    let all = vec![
        "a/Source.md".to_string(),
        "b/Target.md".to_string(),
        "c/NewTarget.md".to_string(),
    ];

    // Initial update
    let links = extract_links("See [[Target]] here");
    graph.update_file("a/Source.md", links, &all);

    // Second update — replaces the first (no duplicates)
    let links2 = extract_links("See [[NewTarget]] here");
    graph.update_file("a/Source.md", links2, &all);

    let fi = make_file_index(&[
        ("b/Target.md", "Target"),
        ("c/NewTarget.md", "NewTarget"),
    ]);

    // Old target should no longer have source in backlinks
    let old_backlinks = graph.get_backlinks("b/Target.md", &fi);
    assert!(old_backlinks.is_empty());

    // New target should have source in backlinks
    let new_backlinks = graph.get_backlinks("c/NewTarget.md", &fi);
    assert_eq!(new_backlinks.len(), 1);
}

#[test]
fn test_get_unresolved() {
    let mut graph = LinkGraph::new();
    let all = vec!["a/Source.md".to_string()];

    let links = extract_links("See [[NonExistent]] here");
    graph.update_file("a/Source.md", links, &all);

    let unresolved = graph.get_unresolved();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].source_path, "a/Source.md");
    assert_eq!(unresolved[0].target_raw, "NonExistent");
}

#[test]
fn test_get_unresolved_empty_when_all_resolved() {
    let mut graph = LinkGraph::new();
    let all = vec!["a/Source.md".to_string(), "b/Target.md".to_string()];

    let links = extract_links("See [[Target]] here");
    graph.update_file("a/Source.md", links, &all);

    let unresolved = graph.get_unresolved();
    assert!(unresolved.is_empty());
}

// ── resolved_map ───────────────────────────────────────────────────────────────

#[test]
fn test_resolved_map_unique() {
    let all = vec!["folder/NoteA.md".to_string(), "other/NoteB.md".to_string()];
    let map = resolved_map(&all);
    assert_eq!(map.get("notea").map(|s| s.as_str()), Some("folder/NoteA.md"));
    assert_eq!(map.get("noteb").map(|s| s.as_str()), Some("other/NoteB.md"));
}

#[test]
fn test_resolved_map_ambiguous_shortest_path() {
    // Two files with same stem at different depths — shortest path wins
    let all = vec![
        "b/Note.md".to_string(),
        "c/d/Note.md".to_string(),
    ];
    let map = resolved_map(&all);
    // "b/Note.md" is shallower (1 segment) vs "c/d/Note.md" (2 segments)
    assert_eq!(map.get("note").map(|s| s.as_str()), Some("b/Note.md"));
}
