//! #208 — Semantic quality sanity test.
//!
//! Guards against silent retrieval-quality regressions in the embedding
//! stack. Uses the five mini-docs from research #188
//! (`pizza_dough`, `bread_baking`, `cat_behavior`, `machine_learning`,
//! `sourdough_starter`) as a ground-truth corpus with two
//! cluster-crossing queries.
//!
//! Runs as a regular CI job (no `#[ignore]`). Skips cleanly when the
//! MiniLM model isn't bundled, consistent with every other test in this
//! module — no CI flakes on hosts without the model.
//!
//! Similarity is MiniLM L2-normalised dot product (== cosine) and we
//! brute-force all 5 docs rather than going through HNSW/RRF. This is
//! deliberate: we're testing the *embedding quality*, not the index or
//! the fuser. If a regression here ever aligns suspiciously with an HNSW
//! change, that's the signal that HNSW has drifted, not the embedder.

#![cfg(feature = "embeddings")]

use crate::embeddings::EmbeddingService;

const FIXTURES: &[(&str, &str)] = &[
    (
        "pizza_dough",
        include_str!("../../tests/fixtures/semantic_quality/pizza_dough.md"),
    ),
    (
        "bread_baking",
        include_str!("../../tests/fixtures/semantic_quality/bread_baking.md"),
    ),
    (
        "cat_behavior",
        include_str!("../../tests/fixtures/semantic_quality/cat_behavior.md"),
    ),
    (
        "machine_learning",
        include_str!("../../tests/fixtures/semantic_quality/machine_learning.md"),
    ),
    (
        "sourdough_starter",
        include_str!("../../tests/fixtures/semantic_quality/sourdough_starter.md"),
    ),
];

/// Dot product — vectors are MiniLM-L2-normalised so this is cosine similarity.
fn cos(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Embed the fixtures + query and return `(name, score)` pairs sorted
/// descending. Returns `None` when the model isn't bundled (so tests
/// can skip cleanly on CI hosts without the model resource).
fn rank_fixtures(query: &str) -> Option<Vec<(&'static str, f32)>> {
    let svc = EmbeddingService::load(None).ok()?;
    let q = svc.embed(query).expect("query embed failed");
    let mut scored: Vec<(&'static str, f32)> = FIXTURES
        .iter()
        .map(|(name, body)| {
            let v = svc.embed(body).expect("fixture embed failed");
            (*name, cos(&q, &v))
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    Some(scored)
}

#[test]
fn italian_flatbread_top3_contains_pizza_and_bread() {
    let Some(ranked) = rank_fixtures("Italian flatbread techniques") else {
        eprintln!("SKIP: embeddings not bundled");
        return;
    };
    let top3: Vec<&str> = ranked.iter().take(3).map(|(n, _)| *n).collect();
    assert!(
        top3.contains(&"pizza_dough"),
        "expected `pizza_dough` in top-3, got {ranked:?}"
    );
    assert!(
        top3.contains(&"bread_baking"),
        "expected `bread_baking` in top-3, got {ranked:?}"
    );
}

#[test]
fn feline_communication_top1_is_cat_with_margin() {
    let Some(ranked) = rank_fixtures("how do felines communicate") else {
        eprintln!("SKIP: embeddings not bundled");
        return;
    };
    assert_eq!(
        ranked[0].0, "cat_behavior",
        "expected top-1 == `cat_behavior`, got {ranked:?}"
    );
    let margin = ranked[0].1 - ranked[1].1;
    assert!(
        margin > 0.2,
        "expected cosine margin > 0.2, got {margin:.4} (ranked: {ranked:?})"
    );
}
