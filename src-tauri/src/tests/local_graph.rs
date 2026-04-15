// Unit tests for compute_local_graph — the BFS helper that powers the
// right-sidebar local graph panel.
//
// The tests run directly against the pure `compute_local_graph` function so
// no Tauri state or IPC plumbing is needed.

use crate::commands::links::{compute_local_graph, GraphEdge, GraphNode};
use crate::indexer::link_graph::{extract_links, LinkGraph};
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
                aliases: Vec::new(),
            },
        );
    }
    fi
}

fn seed_graph(files: &[(&str, &str, &str)]) -> (LinkGraph, FileIndex, Vec<String>) {
    // files: (rel_path, title, body)
    let all: Vec<String> = files.iter().map(|(p, _, _)| (*p).to_string()).collect();
    let fi = make_file_index(
        &files.iter().map(|(p, t, _)| (*p, *t)).collect::<Vec<_>>(),
    );
    let mut lg = LinkGraph::new();
    for (rel, _title, body) in files {
        let links = extract_links(body);
        lg.update_file(rel, links, &all);
    }
    (lg, fi, all)
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

// ── Basic cases ────────────────────────────────────────────────────────────────

#[test]
fn local_graph_center_alone_when_no_links() {
    let (lg, fi, _) = seed_graph(&[("a.md", "A", "no links here")]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    assert_eq!(result.nodes.len(), 1);
    assert_eq!(result.nodes[0].id, "a.md");
    assert!(result.nodes[0].resolved);
    assert!(result.edges.is_empty());
}

#[test]
fn local_graph_single_outgoing_link() {
    let (lg, fi, _) = seed_graph(&[
        ("a.md", "A", "See [[B]]"),
        ("b.md", "B", "plain"),
    ]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    let ids = ids(&result.nodes);
    assert!(ids.contains(&"a.md".to_string()));
    assert!(ids.contains(&"b.md".to_string()));
    assert_eq!(result.edges.len(), 1);
    let edges = edge_set(&result.edges);
    assert!(edges.contains(&("a.md".to_string(), "b.md".to_string())));
}

#[test]
fn local_graph_includes_backlink_direction() {
    // Only C links to A — A should still see C as a neighbor via incoming edges.
    let (lg, fi, _) = seed_graph(&[
        ("a.md", "A", "no outgoing links"),
        ("c.md", "C", "See [[A]]"),
    ]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    let ids = ids(&result.nodes);
    assert!(ids.contains(&"c.md".to_string()));
    let edges = edge_set(&result.edges);
    assert!(edges.contains(&("a.md".to_string(), "c.md".to_string())));
}

#[test]
fn local_graph_two_hop_expansion() {
    // a -> b -> c. Depth 2 must include c; depth 1 must not.
    let (lg, fi, _) = seed_graph(&[
        ("a.md", "A", "[[B]]"),
        ("b.md", "B", "[[C]]"),
        ("c.md", "C", "."),
    ]);

    let depth2 = compute_local_graph("a.md", 2, &lg, &fi);
    let ids2 = ids(&depth2.nodes);
    assert!(ids2.contains(&"c.md".to_string()));

    let depth1 = compute_local_graph("a.md", 1, &lg, &fi);
    let ids1 = ids(&depth1.nodes);
    assert!(!ids1.contains(&"c.md".to_string()));
    assert!(ids1.contains(&"b.md".to_string()));
}

#[test]
fn local_graph_undirected_edge_dedupe() {
    // A and B link to each other — only one edge should be emitted.
    let (lg, fi, _) = seed_graph(&[
        ("a.md", "A", "[[B]]"),
        ("b.md", "B", "[[A]]"),
    ]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    assert_eq!(result.edges.len(), 1);
}

#[test]
fn local_graph_unresolved_target_becomes_pseudo_node() {
    let (lg, fi, _) = seed_graph(&[("a.md", "A", "[[Ghost]]")]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    let ghost = result
        .nodes
        .iter()
        .find(|n| n.id.starts_with("unresolved:"))
        .expect("unresolved node should exist");
    assert!(!ghost.resolved);
    assert_eq!(ghost.label, "Ghost");
    assert_eq!(ghost.path, "");
}

#[test]
fn local_graph_backlink_count_populated() {
    // Both B and C link to A. A.backlink_count should be 2.
    let (lg, fi, _) = seed_graph(&[
        ("a.md", "A", "."),
        ("b.md", "B", "[[A]]"),
        ("c.md", "C", "[[A]]"),
    ]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    let center = result.nodes.iter().find(|n| n.id == "a.md").unwrap();
    assert_eq!(center.backlink_count, 2);
}

#[test]
fn local_graph_no_self_loop() {
    let (lg, fi, _) = seed_graph(&[("a.md", "A", "[[A]]")]);
    let result = compute_local_graph("a.md", 2, &lg, &fi);
    for e in &result.edges {
        assert_ne!(e.from, e.to);
    }
}

#[test]
fn local_graph_label_strips_md_and_folder() {
    let (lg, fi, _) = seed_graph(&[("folder/sub/NoteTitle.md", "NoteTitle", ".")]);
    let result = compute_local_graph("folder/sub/NoteTitle.md", 2, &lg, &fi);
    let center = result
        .nodes
        .iter()
        .find(|n| n.id == "folder/sub/NoteTitle.md")
        .unwrap();
    assert_eq!(center.label, "NoteTitle");
}

#[test]
fn local_graph_respects_node_cap() {
    // 600 neighbors — center linked to 600 unique files. Result must cap at
    // LOCAL_GRAPH_NODE_CAP (500) without panicking.
    let mut files: Vec<(String, String, String)> = Vec::new();
    let mut center_body = String::new();
    for i in 0..600 {
        let rel = format!("n{:04}.md", i);
        center_body.push_str(&format!("[[n{:04}]]\n", i));
        files.push((rel.clone(), format!("N{:04}", i), String::new()));
    }
    files.push(("center.md".to_string(), "Center".to_string(), center_body));

    let tuples: Vec<(&str, &str, &str)> = files
        .iter()
        .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
        .collect();
    let (lg, fi, _) = seed_graph(&tuples);

    let result = compute_local_graph("center.md", 2, &lg, &fi);
    assert!(result.nodes.len() <= 500);
}

#[test]
fn local_graph_empty_center_still_renders_center() {
    // Center isn't in the FileIndex (e.g. brand-new file) — still emit the
    // single node so the panel has something to show.
    let (lg, fi, _) = seed_graph(&[("other.md", "Other", ".")]);
    let result = compute_local_graph("missing.md", 2, &lg, &fi);
    assert_eq!(result.nodes.len(), 1);
    assert_eq!(result.nodes[0].id, "missing.md");
    assert!(result.edges.is_empty());
}
