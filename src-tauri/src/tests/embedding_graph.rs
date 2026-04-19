//! #235 — unit tests for `compute_embedding_graph`.
//!
//! Drives the pure builder with synthetic `VectorIndex` fixtures so the
//! tests don't depend on the actual embedding model being bundled. All
//! similarities are constructed analytically: unit vectors along
//! disjoint axes (cosine 0) or mixed along two axes with known weights
//! (cosine = dot product since inputs are L2-normalised).
//!
//! Behaviours guarded:
//! - Threshold filters low-similarity pairs.
//! - `top_k` caps neighbours per source.
//! - Edges are undirected and deduplicated.
//! - Edge weight = **max** chunk-pair cosine (not mean, not last-write).
//! - Self-loops (source-chunk hitting itself or a sibling chunk of the
//!   same note) never emit an edge.
//! - Empty index yields an empty graph.
//! - Nodes come from the VectorIndex path set; a note that exists in
//!   `FileIndex` but has no embedding does NOT appear as a node.

#![cfg(feature = "embeddings")]

use std::path::{Path, PathBuf};

use crate::commands::embedding_graph::compute_embedding_graph;
use crate::commands::links::{GraphEdge, LocalGraph};
use crate::embeddings::{VectorIndex, DIM};
use crate::indexer::memory::{FileIndex, FileMeta};
use crate::indexer::tag_index::TagIndex;

/// Empty `Path` is the no-op vault root that lets tests use
/// already-relative `PathBuf::from("a.md")` fixtures —
/// `strip_prefix("")` succeeds and returns the original path unchanged.
const NO_VAULT_ROOT: &str = "";

/// Build a 384-dim unit vector with non-zero components only at the
/// given `(axis, weight)` positions. Weights must be pre-arranged so
/// that `sum(w_i^2) == 1` — caller's responsibility.
fn mixed_unit(components: &[(usize, f32)]) -> Vec<f32> {
    let mut v = vec![0f32; DIM];
    for (axis, w) in components {
        assert!(*axis < DIM, "axis {axis} out of range");
        v[*axis] = *w;
    }
    // Cheap sanity check — catches miscalibrated weights in fixtures.
    let norm_sq: f32 = v.iter().map(|x| x * x).sum();
    assert!(
        (norm_sq - 1.0).abs() < 1e-5,
        "fixture vector not unit-norm: {norm_sq:.6}"
    );
    v
}

/// Unit vector along a single axis.
fn axis_unit(axis: usize) -> Vec<f32> {
    mixed_unit(&[(axis, 1.0)])
}

fn empty_file_index() -> FileIndex {
    FileIndex::new()
}

fn file_index_with(paths: &[&str]) -> FileIndex {
    let mut fi = FileIndex::new();
    for rel in paths {
        fi.insert(
            PathBuf::from(format!("/vault/{rel}")),
            FileMeta {
                relative_path: (*rel).to_string(),
                hash: "h".into(),
                title: (*rel).into(),
                aliases: Vec::new(),
            },
        );
    }
    fi
}

fn edge_pairs(g: &LocalGraph) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = g
        .edges
        .iter()
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();
    out.sort();
    out
}

fn edge_weight(g: &LocalGraph, a: &str, b: &str) -> Option<f32> {
    g.edges.iter().find_map(|e| {
        let same = (e.from == a && e.to == b) || (e.from == b && e.to == a);
        if same {
            e.weight
        } else {
            None
        }
    })
}

// ── tests ───────────────────────────────────────────────────────────────

#[test]
fn empty_vector_index_yields_empty_graph() {
    let vi = VectorIndex::new(4);
    let fi = empty_file_index();
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 10, 0.0);

    assert!(g.nodes.is_empty(), "expected no nodes, got {:?}", g.nodes);
    assert!(g.edges.is_empty(), "expected no edges, got {:?}", g.edges);
}

#[test]
fn threshold_filters_low_similarity_edges() {
    // a.md + b.md live near axis 0 (cos ≈ 0.9987).
    // c.md lives on axis 7 (cos with a/b = 0).
    let vi = VectorIndex::new(8);
    vi.insert(PathBuf::from("a.md"), 0, &axis_unit(0));
    vi.insert(
        PathBuf::from("b.md"),
        0,
        &mixed_unit(&[(0, 0.95), (1, 0.3122499)]), // 0.95^2 + 0.3122499^2 ≈ 1.0
    );
    vi.insert(PathBuf::from("c.md"), 0, &axis_unit(7));

    let fi = file_index_with(&["a.md", "b.md", "c.md"]);
    let ti = TagIndex::new();

    // threshold 0.7 → only a↔b edge survives.
    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 10, 0.7);

    let pairs = edge_pairs(&g);
    assert_eq!(
        pairs,
        vec![("a.md".to_string(), "b.md".to_string())],
        "expected single a↔b edge above threshold, got {pairs:?}"
    );
}

#[test]
fn top_k_caps_neighbors_per_source() {
    // a.md is near three other notes b/c/d with distinct similarities.
    // With top_k=1 we keep only the single best neighbor of `a`.
    let vi = VectorIndex::new(8);
    vi.insert(PathBuf::from("a.md"), 0, &axis_unit(0));
    vi.insert(
        PathBuf::from("b.md"),
        0,
        &mixed_unit(&[(0, 0.99), (1, 0.0199_f32.sqrt())]), // cos ≈ 0.99
    );
    vi.insert(
        PathBuf::from("c.md"),
        0,
        &mixed_unit(&[(0, 0.95), (1, 0.3122499)]), // cos ≈ 0.95
    );
    vi.insert(
        PathBuf::from("d.md"),
        0,
        &mixed_unit(&[(0, 0.90), (1, 0.4358899)]), // cos ≈ 0.90
    );

    let fi = file_index_with(&["a.md", "b.md", "c.md", "d.md"]);
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 1, 0.80);

    // Because edges are undirected and every pair (b,c,d) is also >0.80
    // with each other, the top-1-per-source budget yields exactly three
    // edges after deduplication: one per source picks one best neighbour;
    // symmetric duplicates collapse to the same (lo, hi) entry.
    // Specifically: a→b, b→a (dupe), c→?, d→? — the resulting unique
    // edge set has cardinality at most 4 and must contain a↔b (the
    // tightest pair). Precise count depends on the tie-break but must
    // never exceed sources.
    assert!(
        g.edges.len() <= 4,
        "top_k=1 per source should cap edges (≤4 unique), got {}",
        g.edges.len()
    );
    assert!(
        edge_weight(&g, "a.md", "b.md").is_some(),
        "a↔b (tightest) must survive the top-1 cap; got {:?}",
        edge_pairs(&g)
    );
}

#[test]
fn edges_are_undirected_and_deduplicated() {
    // Two notes on nearly-identical vectors — every direction of the
    // k-NN finds the pair. Result must still be exactly one edge.
    let vi = VectorIndex::new(4);
    vi.insert(PathBuf::from("a.md"), 0, &axis_unit(0));
    vi.insert(
        PathBuf::from("b.md"),
        0,
        &mixed_unit(&[(0, 0.98), (1, 0.19899749)]),
    );

    let fi = file_index_with(&["a.md", "b.md"]);
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 10, 0.5);

    assert_eq!(g.edges.len(), 1, "expected 1 unique edge, got {:?}", g.edges);
    let e = &g.edges[0];
    assert!(e.from < e.to, "edge should be normalized lo<hi: {e:?}");
}

#[test]
fn edge_weight_is_max_chunk_pair_similarity() {
    // `a.md` has two chunks:
    //   chunk 0 — axis 0 (matches `b.md`'s single axis-0 chunk at cos 1.0)
    //   chunk 1 — axis 5 (matches `c.md` at cos 1.0)
    //
    // `b.md` has only chunk 0 on axis 0 (cos with a-chunk0 = 1.0).
    // `b.md` also has chunk 1 on axis 5 rotated slightly — a weaker
    //   match against a-chunk1 at cos 0.5.
    //
    // The edge a↔b must carry the MAX chunk-pair cosine (1.0), not the
    // mean (0.75) or the last-written value.
    let vi = VectorIndex::new(8);
    vi.insert(PathBuf::from("a.md"), 0, &axis_unit(0));
    vi.insert(PathBuf::from("a.md"), 1, &axis_unit(5));
    vi.insert(PathBuf::from("b.md"), 0, &axis_unit(0)); // cos(a0,b0)=1.0
    vi.insert(
        PathBuf::from("b.md"),
        1,
        &mixed_unit(&[(5, 0.5), (6, 0.75_f32.sqrt())]), // cos(a1,b1)=0.5
    );

    let fi = file_index_with(&["a.md", "b.md"]);
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 10, 0.4);

    let w = edge_weight(&g, "a.md", "b.md").expect("a↔b edge must exist");
    assert!(
        (w - 1.0).abs() < 0.01,
        "expected edge weight == max chunk-pair cosine ≈ 1.0, got {w:.4}"
    );
}

#[test]
fn self_edges_excluded() {
    // Single note, multiple chunks. No edge should be emitted to itself.
    let vi = VectorIndex::new(4);
    vi.insert(PathBuf::from("a.md"), 0, &axis_unit(0));
    vi.insert(PathBuf::from("a.md"), 1, &axis_unit(1));
    vi.insert(PathBuf::from("a.md"), 2, &axis_unit(2));

    let fi = file_index_with(&["a.md"]);
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 10, 0.0);

    assert!(
        g.edges.is_empty(),
        "a.md must not edge to itself; got {:?}",
        g.edges
    );
    // The node itself should still appear so the graph isn't empty.
    let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, vec!["a.md"]);
}

#[test]
fn nodes_come_from_vector_index_only() {
    // `orphan.md` exists in FileIndex but has no chunks in VectorIndex
    // → it must NOT appear in the embedding graph (no semantic position).
    let vi = VectorIndex::new(4);
    vi.insert(PathBuf::from("indexed.md"), 0, &axis_unit(0));

    let fi = file_index_with(&["indexed.md", "orphan.md"]);
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 10, 0.0);

    let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["indexed.md"],
        "only notes with embeddings belong in the embedding graph"
    );
}

#[test]
fn paths_are_stripped_to_vault_relative_ids() {
    // VectorIndex stores absolute paths (the embed coordinator passes
    // abs paths from `dispatch_embed_update`). The graph payload uses
    // vault-relative paths — `\\` normalised to `/` — so the frontend
    // can key into FileIndex / TagIndex consistently with link-mode.
    //
    // Plan-agent flagged this as the highest-impact correctness bug:
    // without the strip, every node id would be the absolute path and
    // tag/path lookups in the UI silently miss.
    let vault_root = PathBuf::from("/vault");
    let vi = VectorIndex::new(4);
    vi.insert(PathBuf::from("/vault/notes/a.md"), 0, &axis_unit(0));
    vi.insert(
        PathBuf::from("/vault/notes/b.md"),
        0,
        &mixed_unit(&[(0, 0.98), (1, 0.19899749)]),
    );

    let fi = file_index_with(&["notes/a.md", "notes/b.md"]);
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, &vault_root, 10, 0.5);

    let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, vec!["notes/a.md", "notes/b.md"]);
    assert_eq!(g.edges.len(), 1);
    let e = &g.edges[0];
    assert_eq!(e.from, "notes/a.md");
    assert_eq!(e.to, "notes/b.md");
}

/// Guard: a GraphEdge without a weight (link-graph case) is still a
/// valid construction — we haven't accidentally made the field
/// mandatory. This keeps link-graph code paths compiling.
#[test]
fn graph_edge_without_weight_still_constructs() {
    let e = GraphEdge {
        from: "a".into(),
        to: "b".into(),
        weight: None,
    };
    assert!(e.weight.is_none());
}
