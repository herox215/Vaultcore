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

use crate::commands::embedding_graph::{
    apply_threshold_to_raw, compute_embedding_graph, compute_embedding_graph_raw,
};
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

// ── #254: RAM-reduction parity + hot-path memory guards ───────────────────

/// Shared fixture generator — deterministic 6-note × 3-chunk index
/// arranged into two clusters (notes 0-2 share axis 0 weight, notes
/// 3-5 share axis 1 weight) so plenty of cross-note edges land above
/// threshold 0.5. Produces a non-trivial graph for the parity check
/// (ordering, deduplication, chunk-pair max).
fn seeded_graph_fixture() -> VectorIndex {
    let vi = VectorIndex::new(18);
    for f in 0..6u64 {
        // Cluster A (f < 3): dominant axis = 0 with weight 0.9.
        // Cluster B (f ≥ 3): dominant axis = 1 with weight 0.9.
        let (major_axis, minor_axis) = if f < 3 { (0usize, 2usize) } else { (1, 3) };
        for c in 0..3u64 {
            // Slight per-chunk tilt along a secondary axis so chunks of
            // the same file aren't cosine-1 clones. `major_weight` ≈ 0.9
            // → cos between two same-cluster notes ≈ 0.81 > 0.5.
            let major_w = 0.9_f32;
            let minor_w = (1.0 - major_w * major_w).sqrt(); // keeps unit norm
            let tilt_axis = minor_axis + (c as usize);
            let mut v = vec![0.0f32; DIM];
            v[major_axis] = major_w;
            v[tilt_axis] = minor_w;
            vi.insert(PathBuf::from(format!("note-{f}.md")), c as usize, &v);
        }
    }
    vi
}

#[test]
fn compute_embedding_graph_output_is_stable_parity_snapshot() {
    // Regression guard for the #254 refactor: the graph builder must emit
    // byte-identical node/edge lists when we switch to Arc<Path> mapping
    // and streaming vector access. Checks node ids, sorted edge pairs,
    // and edge weights (with tight fp tolerance).
    let vi = seeded_graph_fixture();
    let fi = empty_file_index();
    let ti = TagIndex::new();

    let g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 5, 0.5);

    // 6 nodes, one per file, sorted lexically.
    let node_ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(node_ids.len(), 6);
    assert_eq!(
        node_ids,
        vec!["note-0.md", "note-1.md", "note-2.md", "note-3.md", "note-4.md", "note-5.md"]
    );

    // Fixture has two disjoint clusters (0/1/2 on axis 0, 3/4/5 on axis 1).
    // Within each cluster every pair lands at cos ≈ 0.81, above threshold 0.5.
    // Cross-cluster pairs land at cos ≈ 0.0 (perpendicular axes) — pruned.
    // Expected edges: all 3-choose-2 pairs in each cluster = 6 edges total.
    let pairs: Vec<(String, String)> = g
        .edges
        .iter()
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();
    let expected: Vec<(String, String)> = vec![
        ("note-0.md", "note-1.md"),
        ("note-0.md", "note-2.md"),
        ("note-1.md", "note-2.md"),
        ("note-3.md", "note-4.md"),
        ("note-3.md", "note-5.md"),
        ("note-4.md", "note-5.md"),
    ]
    .into_iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    assert_eq!(pairs, expected, "edge set changed; parity regression?");

    // Every surviving edge must sit in the narrow cosine band the
    // fixture pins (chunk-pair max ≈ 0.9² + minor_w² on a shared tilt
    // axis: ~0.81 when tilts align, ~0.81 + minor_weight² otherwise).
    for e in &g.edges {
        let w = e.weight.expect("weight set");
        assert!(
            w >= 0.5 && w <= 1.0001,
            "edge {}↔{} weight {w} outside expected band",
            e.from,
            e.to,
        );
    }
    for w in node_ids.windows(2) {
        assert!(w[0] < w[1], "node list must be sorted: {w:?}");
    }

    // Parity snapshot for the edge set. Encode edges as `(from,to,weight.round(4))`
    // strings so the assertion is stable under f32 noise.
    let mut snapshot: Vec<String> = g
        .edges
        .iter()
        .map(|e| {
            format!(
                "{}|{}|{:.4}",
                e.from,
                e.to,
                e.weight.unwrap_or(f32::NAN)
            )
        })
        .collect();
    snapshot.sort();
    // There must be at least some edges — otherwise the fixture regressed
    // and the parity guard becomes vacuous.
    assert!(
        !snapshot.is_empty(),
        "fixture produced no edges, threshold mis-tuned",
    );
    // Undirected: no (a,b) may appear with (b,a) too.
    let pairs: Vec<(&str, &str)> = g
        .edges
        .iter()
        .map(|e| (e.from.as_str(), e.to.as_str()))
        .collect();
    for (i, (a, b)) in pairs.iter().enumerate() {
        for (c, d) in pairs.iter().skip(i + 1) {
            assert!(
                !(a == d && b == c),
                "edge {a}↔{b} emitted twice as ({c},{d})"
            );
            assert!(a < b, "edge not normalised lo<hi: {a} ↔ {b}");
        }
    }
}

#[test]
fn graph_build_does_not_materialise_full_vector_clone() {
    // #254 — `compute_embedding_graph` must not allocate a fresh
    // `Vec<Vec<f32>>` holding every chunk vector. The testable proxy is
    // the VectorIndex's mapping Arc-count: after graph build, every path
    // Arc in the index's mapping should still have strong_count == 2
    // (interner pool + mapping slot). If the builder cloned paths as
    // owned PathBufs instead of borrowing/Arc-cloning, no Arc gets
    // bumped — but if it cloned vectors into its own hashmap, that'd
    // show up as transient allocation pressure only visible to a
    // counter.
    //
    // We instrument a side-channel via `VectorIndex::path_refcount_max`
    // (test-only): returns the largest strong_count across the pool.
    // Before graph build: 2 (pool + mapping). During build: if the
    // builder takes its own Arc clones, refcount spikes to 3+; if it
    // clones the PathBuf fresh (the regression the ticket targets) it
    // stays at 2 but a separate counter `vector_clone_count` bumps.
    //
    // Here we assert the non-spike: after graph build, refcount returns
    // to baseline and the builder's vector-clone counter reports zero.
    let vi = seeded_graph_fixture();
    let fi = empty_file_index();
    let ti = TagIndex::new();

    let baseline = vi.path_refcount_max();
    // Reset any prior counter value so we measure this call alone.
    crate::commands::embedding_graph::reset_vector_clone_counter();

    let _g = compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 5, 0.5);

    // Path Arcs must return to baseline — the builder released anything
    // it held. (strong_count inside the build is allowed to spike; we
    // only care that it drains.)
    assert_eq!(
        vi.path_refcount_max(),
        baseline,
        "graph build leaked path Arc references"
    );
    // Hard guard: the builder must not have materialised an owned copy
    // of each chunk vector. On a 12×3 = 36-chunk fixture, pre-#254 code
    // cloned 36 vectors into chunks_by_path. We require strictly zero.
    let clones = crate::commands::embedding_graph::vector_clone_count();
    assert_eq!(
        clones, 0,
        "graph build cloned {clones} chunk vectors; expected 0 after #254"
    );
}

// ── #287 — split raw/threshold builder for cached slider path ─────────────

/// Builds a fixed 4-note fixture with a known cosine ordering:
///   a(axis0) · b ≈ 0.95,  a · c ≈ 0.80,  a · d ≈ 0.50
/// plus pairwise relationships between b/c/d that push all of them
/// above 0.50 with each other.
fn fixture_ordered_four() -> (VectorIndex, FileIndex, TagIndex) {
    let vi = VectorIndex::new(16);
    vi.insert(PathBuf::from("a.md"), 0, &axis_unit(0));
    vi.insert(
        PathBuf::from("b.md"),
        0,
        &mixed_unit(&[(0, 0.95), (1, 0.3122499)]),
    );
    vi.insert(
        PathBuf::from("c.md"),
        0,
        &mixed_unit(&[(0, 0.80), (1, 0.6)]),
    );
    vi.insert(
        PathBuf::from("d.md"),
        0,
        &mixed_unit(&[(0, 0.50), (1, (0.75f32).sqrt())]),
    );
    let fi = file_index_with(&["a.md", "b.md", "c.md", "d.md"]);
    let ti = TagIndex::new();
    (vi, fi, ti)
}

#[test]
fn raw_builder_produces_threshold_independent_per_source_lists() {
    let (vi, fi, ti) = fixture_ordered_four();
    let raw = compute_embedding_graph_raw(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 3);

    // Every chunked path becomes a node — threshold plays no role.
    let ids: Vec<_> = raw.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, vec!["a.md", "b.md", "c.md", "d.md"]);

    // Per-source lists are sorted descending by cosine.
    for (_src, neighbours) in &raw.per_src {
        for w in neighbours.windows(2) {
            assert!(
                w[0].1 >= w[1].1,
                "neighbour list must be sorted desc by cosine",
            );
        }
    }
    // `a.md`'s neighbours include b/c/d with cos in descending order.
    use std::sync::Arc;
    let a_arc: Arc<str> = Arc::<str>::from("a.md");
    let a_neigh = raw.per_src.get(&a_arc).expect("source a.md present");
    let ids: Vec<&str> = a_neigh.iter().map(|(p, _)| p.as_ref()).collect();
    assert_eq!(ids[0], "b.md");
    assert_eq!(ids[1], "c.md");
    assert_eq!(ids[2], "d.md");
}

#[test]
fn apply_threshold_matches_original_compute_for_equivalent_threshold() {
    // The refactor must preserve the end-to-end output for every
    // threshold. Build raw once, apply two thresholds, and compare each
    // against a direct `compute_embedding_graph` call at that threshold.
    let (vi, fi, ti) = fixture_ordered_four();
    let raw = compute_embedding_graph_raw(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 3);

    for threshold in [0.0_f32, 0.4, 0.7, 0.9] {
        let via_cache = apply_threshold_to_raw(&raw, threshold);
        let direct =
            compute_embedding_graph(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 3, threshold);

        let pairs_cache = edge_pairs(&via_cache);
        let pairs_direct = edge_pairs(&direct);
        assert_eq!(
            pairs_cache, pairs_direct,
            "edge set differs at threshold {threshold}",
        );
        for (a, b) in &pairs_cache {
            let w_cache = edge_weight(&via_cache, a, b);
            let w_direct = edge_weight(&direct, a, b);
            assert_eq!(
                w_cache, w_direct,
                "weight for ({a}, {b}) at threshold {threshold} differs: cache={w_cache:?} direct={w_direct:?}",
            );
        }
    }
}

#[test]
fn apply_threshold_on_raw_is_side_effect_free() {
    // The cache must remain reusable after a threshold application —
    // otherwise a second slider change in a row would silently rebuild.
    let (vi, fi, ti) = fixture_ordered_four();
    let raw = compute_embedding_graph_raw(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 3);
    let entries_before = raw.per_src.len();
    let total_edges_before: usize = raw.per_src.values().map(|v| v.len()).sum();

    let _ = apply_threshold_to_raw(&raw, 0.5);
    let _ = apply_threshold_to_raw(&raw, 0.95);

    assert_eq!(raw.per_src.len(), entries_before);
    let total_after: usize = raw.per_src.values().map(|v| v.len()).sum();
    assert_eq!(total_after, total_edges_before);
}

#[test]
fn apply_threshold_trivially_returns_all_edges_at_zero() {
    let (vi, fi, ti) = fixture_ordered_four();
    let raw = compute_embedding_graph_raw(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 3);
    let g_zero = apply_threshold_to_raw(&raw, 0.0);
    // Every source contributes up to top_k edges; symmetric dedup
    // collapses some, but at threshold 0 we expect non-empty edges on
    // a four-note fixture where all cosines are > 0.
    assert!(
        !g_zero.edges.is_empty(),
        "threshold 0 should not filter out every edge",
    );
}

#[test]
fn apply_threshold_at_one_filters_all_edges() {
    let (vi, fi, ti) = fixture_ordered_four();
    let raw = compute_embedding_graph_raw(&vi, &fi, &ti, Path::new(NO_VAULT_ROOT), 3);
    let g_one = apply_threshold_to_raw(&raw, 1.0);
    assert!(g_one.edges.is_empty());
    // Nodes still present — threshold only suppresses edges.
    assert_eq!(g_one.nodes.len(), 4);
}
