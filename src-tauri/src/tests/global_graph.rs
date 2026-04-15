// Unit tests for compute_link_graph — the whole-vault enumeration that
// powers the global graph tab (issue #32).
//
// Runs against the pure `compute_link_graph` function — no Tauri state or
// IPC plumbing involved.

use crate::commands::links::{compute_link_graph, GraphEdge, GraphNode};
use crate::indexer::link_graph::{extract_links, LinkGraph};
use crate::indexer::memory::{FileIndex, FileMeta};
use crate::indexer::tag_index::TagIndex;

fn make_file_index(entries: &[(&str, &str)]) -> FileIndex {
    let mut fi = FileIndex::new();
    for (rel, title) in entries {
        fi.insert(
            std::path::PathBuf::from(format!("/vault/{}", rel)),
            FileMeta {
                relative_path: rel.to_string(),
                hash: "abc".to_string(),
                title: title.to_string(),
                aliases: Vec::new(),
            },
        );
    }
    fi
}

fn seed(
    files: &[(&str, &str, &str)],
) -> (LinkGraph, FileIndex, TagIndex) {
    // files: (rel_path, title, body)
    let all: Vec<String> = files.iter().map(|(p, _, _)| (*p).to_string()).collect();
    let fi = make_file_index(
        &files.iter().map(|(p, t, _)| (*p, *t)).collect::<Vec<_>>(),
    );
    let mut lg = LinkGraph::new();
    let mut ti = TagIndex::new();
    for (rel, _title, body) in files {
        let links = extract_links(body);
        lg.update_file(rel, links, &all);
        ti.update_file(rel, body);
    }
    (lg, fi, ti)
}

fn ids(nodes: &[GraphNode]) -> Vec<String> {
    nodes.iter().map(|n| n.id.clone()).collect()
}

fn edge_set(edges: &[GraphEdge]) -> std::collections::HashSet<(String, String)> {
    edges
        .iter()
        .map(|e| {
            let (a, b) = if e.from <= e.to {
                (e.from.clone(), e.to.clone())
            } else {
                (e.to.clone(), e.from.clone())
            };
            (a, b)
        })
        .collect()
}

#[test]
fn empty_vault_yields_empty_graph() {
    let (lg, fi, ti) = seed(&[]);
    let g = compute_link_graph(&lg, &fi, &ti);
    assert!(g.nodes.is_empty());
    assert!(g.edges.is_empty());
}

#[test]
fn every_indexed_file_becomes_resolved_node() {
    let (lg, fi, ti) = seed(&[
        ("a.md", "A", ""),
        ("b.md", "B", ""),
        ("sub/c.md", "C", ""),
    ]);
    let g = compute_link_graph(&lg, &fi, &ti);
    let node_ids = ids(&g.nodes);
    assert!(node_ids.contains(&"a.md".to_string()));
    assert!(node_ids.contains(&"b.md".to_string()));
    assert!(node_ids.contains(&"sub/c.md".to_string()));
    for n in &g.nodes {
        assert!(n.resolved, "all file-nodes must be resolved");
    }
}

#[test]
fn resolved_link_produces_undirected_edge() {
    let (lg, fi, ti) = seed(&[
        ("a.md", "A", "See [[B]]"),
        ("b.md", "B", "plain"),
    ]);
    let g = compute_link_graph(&lg, &fi, &ti);
    let e = edge_set(&g.edges);
    assert_eq!(g.edges.len(), 1);
    assert!(e.contains(&("a.md".to_string(), "b.md".to_string())));
}

#[test]
fn mutual_links_are_deduped_to_single_edge() {
    let (lg, fi, ti) = seed(&[
        ("a.md", "A", "[[B]]"),
        ("b.md", "B", "[[A]]"),
    ]);
    let g = compute_link_graph(&lg, &fi, &ti);
    assert_eq!(g.edges.len(), 1);
}

#[test]
fn unresolved_target_surfaces_as_pseudo_node() {
    let (lg, fi, ti) = seed(&[("a.md", "A", "[[Ghost]]")]);
    let g = compute_link_graph(&lg, &fi, &ti);
    let ghost = g
        .nodes
        .iter()
        .find(|n| n.id.starts_with("unresolved:"))
        .expect("ghost node expected");
    assert!(!ghost.resolved);
    assert_eq!(ghost.label, "Ghost");
    assert_eq!(ghost.path, "");
    // Edge to the ghost must exist.
    let e = edge_set(&g.edges);
    assert!(e.iter().any(|(x, y)| x.starts_with("unresolved:") || y.starts_with("unresolved:")));
}

#[test]
fn backlink_count_reflects_vault_wide_incoming() {
    let (lg, fi, ti) = seed(&[
        ("a.md", "A", "."),
        ("b.md", "B", "[[A]]"),
        ("c.md", "C", "[[A]]"),
    ]);
    let g = compute_link_graph(&lg, &fi, &ti);
    let a = g.nodes.iter().find(|n| n.id == "a.md").unwrap();
    assert_eq!(a.backlink_count, 2);
}

#[test]
fn tags_are_populated_per_node() {
    let (lg, fi, ti) = seed(&[
        ("a.md", "A", "hello #rust and #note-taking"),
        ("b.md", "B", "no tags"),
    ]);
    let g = compute_link_graph(&lg, &fi, &ti);
    let a = g.nodes.iter().find(|n| n.id == "a.md").unwrap();
    assert!(a.tags.contains(&"rust".to_string()));
    assert!(a.tags.contains(&"note-taking".to_string()));
    let b = g.nodes.iter().find(|n| n.id == "b.md").unwrap();
    assert!(b.tags.is_empty());
}

#[test]
fn self_link_does_not_create_self_loop() {
    let (lg, fi, ti) = seed(&[("a.md", "A", "[[A]]")]);
    let g = compute_link_graph(&lg, &fi, &ti);
    for e in &g.edges {
        assert_ne!(e.from, e.to);
    }
}

#[test]
fn node_order_is_stable_across_runs() {
    let (lg, fi, ti) = seed(&[
        ("c.md", "C", ""),
        ("a.md", "A", ""),
        ("b.md", "B", ""),
    ]);
    let g1 = compute_link_graph(&lg, &fi, &ti);
    let g2 = compute_link_graph(&lg, &fi, &ti);
    assert_eq!(ids(&g1.nodes), ids(&g2.nodes));
    // Sorted alphabetically.
    let sorted: Vec<String> = ids(&g1.nodes);
    let mut expected = sorted.clone();
    expected.sort();
    assert_eq!(sorted, expected);
}

#[test]
fn orphan_file_still_emitted_with_no_edges() {
    // `orphan.md` has no in/outbound links — must still appear as a node.
    let (lg, fi, ti) = seed(&[
        ("a.md", "A", "[[B]]"),
        ("b.md", "B", ""),
        ("orphan.md", "Orphan", ""),
    ]);
    let g = compute_link_graph(&lg, &fi, &ti);
    assert!(ids(&g.nodes).contains(&"orphan.md".to_string()));
}
