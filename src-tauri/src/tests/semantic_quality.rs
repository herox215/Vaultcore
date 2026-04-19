//! #208 — Semantic quality sanity test.
//! #233 — Extended with DE fixtures + queries to guard the multilingual
//! retrieval path. MiniLM-L6 is English-only and collapses DE inputs onto
//! the noise floor — these tests are the regression guard that forced the
//! swap to `multilingual-e5-small`.
//!
//! Guards against silent retrieval-quality regressions in the embedding
//! stack. EN corpus: five mini-docs from research #188
//! (`pizza_dough`, `bread_baking`, `cat_behavior`, `machine_learning`,
//! `sourdough_starter`). DE corpus: three mini-docs covering disjoint
//! topics (`hund_verhalten`, `pizza_teig_de`, `maschinelles_lernen_de`).
//!
//! Runs as a regular CI job (no `#[ignore]`). Skips cleanly when the
//! model isn't bundled, consistent with every other test in this
//! module — no CI flakes on hosts without the model.
//!
//! Similarity is L2-normalised dot product (== cosine) and we
//! brute-force the full fixture set rather than going through HNSW/RRF.
//! Deliberate: we're testing the *embedding quality*, not the index or
//! the fuser. If a regression here ever aligns suspiciously with an HNSW
//! change, that's the signal that HNSW has drifted, not the embedder.
//!
//! Uses `embed_query` / `embed_passage` (added in #233) because e5 needs
//! `"query: "` / `"passage: "` prefixes — applying them symmetrically
//! reduces quality significantly per the e5 model card.

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

const DE_FIXTURES: &[(&str, &str)] = &[
    (
        "hund_verhalten",
        include_str!("../../tests/fixtures/semantic_quality/hund_verhalten.md"),
    ),
    (
        "pizza_teig_de",
        include_str!("../../tests/fixtures/semantic_quality/pizza_teig_de.md"),
    ),
    (
        "maschinelles_lernen_de",
        include_str!("../../tests/fixtures/semantic_quality/maschinelles_lernen_de.md"),
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
    rank_set(query, FIXTURES)
}

fn rank_de(query: &str) -> Option<Vec<(&'static str, f32)>> {
    rank_set(query, DE_FIXTURES)
}

fn rank_set(
    query: &str,
    fixtures: &'static [(&'static str, &'static str)],
) -> Option<Vec<(&'static str, f32)>> {
    let svc = EmbeddingService::load(None).ok()?;
    let q = svc.embed_query(query).expect("query embed failed");
    let mut scored: Vec<(&'static str, f32)> = fixtures
        .iter()
        .map(|(name, body)| {
            let v = svc.embed_passage(body).expect("fixture embed failed");
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
    // 0.10 margin threshold — multilingual-e5-small (#233) runs a tighter
    // cosine spread than the MiniLM-era 0.2 assumed. Top-1 still dominates
    // clearly (measured ~0.12 margin on the committed fixtures); 0.10
    // leaves slack for inference-order noise while catching a real
    // regression to the sub-0.05 "noise floor" band.
    assert!(
        margin > 0.10,
        "expected cosine margin > 0.10, got {margin:.4} (ranked: {ranked:?})"
    );
}

// #233 — DE quality gate. MiniLM fails these because DE queries cluster
// at the noise floor (~0.30–0.34 cosine across all topics, margins ~0);
// e5-small-multilingual separates topics cleanly. Margin threshold 0.10
// is conservative vs. EN 0.20 — multilingual models spread DE somewhat
// tighter than native-EN MiniLM does EN, but still well above noise.

#[test]
fn de_query_hundeerziehung_top1_is_hund_with_margin() {
    let Some(ranked) = rank_de("Wie erziehe ich einen Hund richtig?") else {
        eprintln!("SKIP: embeddings not bundled");
        return;
    };
    assert_eq!(
        ranked[0].0, "hund_verhalten",
        "expected top-1 == `hund_verhalten`, got {ranked:?}"
    );
    let margin = ranked[0].1 - ranked[1].1;
    assert!(
        margin > 0.10,
        "expected DE cosine margin > 0.10, got {margin:.4} (ranked: {ranked:?})"
    );
}

#[test]
fn de_query_neuronale_netze_top1_is_ml_with_margin() {
    let Some(ranked) = rank_de("Was sind neuronale Netze im maschinellen Lernen?") else {
        eprintln!("SKIP: embeddings not bundled");
        return;
    };
    assert_eq!(
        ranked[0].0, "maschinelles_lernen_de",
        "expected top-1 == `maschinelles_lernen_de`, got {ranked:?}"
    );
    let margin = ranked[0].1 - ranked[1].1;
    assert!(
        margin > 0.10,
        "expected DE cosine margin > 0.10, got {margin:.4} (ranked: {ranked:?})"
    );
}
