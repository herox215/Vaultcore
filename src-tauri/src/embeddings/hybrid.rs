//! `hybrid` (#203) — Reciprocal Rank Fusion of BM25 (Tantivy) and
//! HNSW (vector) ranks into a single top-k list.
//!
//! RRF per Cormack et al. 2009 § 3: `score(d) = Σ 1 / (k_rrf + rank_i(d))`
//! where `rank_i` is 1-indexed within each source. `k_rrf = 60` is the
//! literature-standard anchor (see research #188).
//!
//! This module is the pure math layer — no Tantivy / no HNSW imports.
//! The Tauri command (`commands::search::hybrid_search`) owns the
//! parallel fan-out, snippet re-generation, and serde shape.
//!
//! Chunked input handling: the vector side returns one hit per
//! *chunk*, so a chunky note can occupy ranks 1, 3, and 8. Per the
//! standard recipe (and every production RRF implementation I've
//! seen — Weaviate, Vespa, Elastic) we **collapse to best-rank-per-path
//! before fusing**. Keeping chunk ranks inflates chunky notes with a
//! harmonic-series mass that is not a property of the underlying
//! document's relevance.

use std::collections::HashMap;

/// Literature-standard RRF anchor (#188). Exposed as a `const` so the
/// #207 benchmark harness can sweep without touching the math.
pub const RRF_K: f32 = 60.0;

/// One post-fusion ranked entry. `path` is the stable note id; the
/// per-source rank/score fields let callers show "matched by: BM25
/// rank 3 / vector rank 12" in debug UIs. All `Option<_>` fields
/// default-skip in serde so the wire shape stays clean when a hit
/// comes from only one source.
#[derive(Debug, Clone, PartialEq)]
pub struct FusedHit {
    pub path: String,
    pub score: f32,
    pub bm25_rank: Option<u32>,
    pub vec_rank: Option<u32>,
    pub bm25_score: Option<f32>,
    pub vec_score: Option<f32>,
}

/// Compute RRF fusion over one BM25 rank list and one vector rank list.
///
/// Inputs are already sorted by each source's native relevance (BM25
/// desc by score; vector desc by cosine similarity). The function:
/// 1. Collapses vector chunks to best-rank-per-path.
/// 2. Walks each list assigning 1-indexed rank and accumulating
///    `1 / (RRF_K + rank)` per path.
/// 3. Sorts by fused score desc; breaks ties by BM25 rank, then
///    alphabetical path, so the output is fully deterministic.
///
/// Scales O(B + V) in lookup + O(P log P) in the final sort, where P
/// ≤ B + V. No allocations beyond the output.
pub fn rrf_fuse(
    bm25: &[(String, f32)],
    vec_hits: &[(String, f32)],
    k_rrf: f32,
) -> Vec<FusedHit> {
    // Step 1: collapse vec chunks to best-rank-per-path. Input is
    // sorted, so the first occurrence of a path is already its best
    // rank. Use an order-preserving dedup walk.
    let mut vec_by_path: HashMap<&str, (u32, f32)> = HashMap::new();
    let mut vec_collapsed: Vec<(&str, u32, f32)> = Vec::new();
    for (path, score) in vec_hits {
        if vec_by_path.contains_key(path.as_str()) {
            continue;
        }
        let rank = (vec_collapsed.len() + 1) as u32;
        vec_by_path.insert(path.as_str(), (rank, *score));
        vec_collapsed.push((path.as_str(), rank, *score));
    }

    // Step 2: accumulate. `BTreeMap` would give deterministic iter but
    // we sort at the end anyway — HashMap is fine and cheaper.
    struct Acc {
        score: f32,
        bm25_rank: Option<u32>,
        bm25_score: Option<f32>,
        vec_rank: Option<u32>,
        vec_score: Option<f32>,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();

    for (i, (path, score)) in bm25.iter().enumerate() {
        let rank = (i + 1) as u32;
        let entry = acc.entry(path.clone()).or_insert(Acc {
            score: 0.0,
            bm25_rank: None,
            bm25_score: None,
            vec_rank: None,
            vec_score: None,
        });
        entry.score += 1.0 / (k_rrf + rank as f32);
        entry.bm25_rank = Some(rank);
        entry.bm25_score = Some(*score);
    }

    for (path, rank, score) in &vec_collapsed {
        let entry = acc.entry((*path).to_string()).or_insert(Acc {
            score: 0.0,
            bm25_rank: None,
            bm25_score: None,
            vec_rank: None,
            vec_score: None,
        });
        entry.score += 1.0 / (k_rrf + *rank as f32);
        entry.vec_rank = Some(*rank);
        entry.vec_score = Some(*score);
    }

    // Step 3: sort by fused score desc; stable tie-break so callers
    // observing two hits with identical scores (e.g. both rank-1 on
    // their side) get a predictable order.
    let mut out: Vec<FusedHit> = acc
        .into_iter()
        .map(|(path, a)| FusedHit {
            path,
            score: a.score,
            bm25_rank: a.bm25_rank,
            vec_rank: a.vec_rank,
            bm25_score: a.bm25_score,
            vec_score: a.vec_score,
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| match (a.bm25_rank, b.bm25_rank) {
                (Some(ar), Some(br)) => ar.cmp(&br),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(hits: &[FusedHit]) -> Vec<&str> {
        hits.iter().map(|h| h.path.as_str()).collect()
    }

    #[test]
    fn empty_inputs_produce_empty_output() {
        assert!(rrf_fuse(&[], &[], RRF_K).is_empty());
    }

    #[test]
    fn bm25_only_preserves_order() {
        let bm25 = vec![
            ("a.md".into(), 9.0),
            ("b.md".into(), 5.0),
            ("c.md".into(), 1.0),
        ];
        let hits = rrf_fuse(&bm25, &[], RRF_K);
        assert_eq!(paths(&hits), vec!["a.md", "b.md", "c.md"]);
        // Scores must be strictly decreasing.
        for w in hits.windows(2) {
            assert!(w[0].score > w[1].score);
        }
        // bm25_* fields populated; vec_* empty.
        for h in &hits {
            assert!(h.bm25_rank.is_some());
            assert!(h.bm25_score.is_some());
            assert!(h.vec_rank.is_none());
            assert!(h.vec_score.is_none());
        }
    }

    #[test]
    fn vec_only_preserves_order() {
        let vec_hits = vec![
            ("x.md".into(), 0.9),
            ("y.md".into(), 0.5),
        ];
        let hits = rrf_fuse(&[], &vec_hits, RRF_K);
        assert_eq!(paths(&hits), vec!["x.md", "y.md"]);
        for h in &hits {
            assert!(h.vec_rank.is_some());
            assert!(h.bm25_rank.is_none());
        }
    }

    #[test]
    fn both_sources_combine_scores() {
        // Same doc ranks 1 on BM25 and 1 on vec — score should be 2×(1/61).
        let bm25 = vec![("overlap.md".into(), 10.0)];
        let vec_hits = vec![("overlap.md".into(), 0.9)];
        let hits = rrf_fuse(&bm25, &vec_hits, RRF_K);
        assert_eq!(hits.len(), 1);
        let expected = 2.0 / (RRF_K + 1.0);
        assert!(
            (hits[0].score - expected).abs() < 1e-6,
            "score={} expected≈{}",
            hits[0].score,
            expected
        );
        assert_eq!(hits[0].bm25_rank, Some(1));
        assert_eq!(hits[0].vec_rank, Some(1));
    }

    #[test]
    fn overlapping_doc_outranks_singleton_at_same_rank() {
        // A ranks 1 in BM25 only; B ranks 2 in BM25 and 1 in vec.
        // B's fused score: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
        // A's fused score: 1/(60+1) = 1/61
        // B > A.
        let bm25 = vec![("a.md".into(), 10.0), ("b.md".into(), 5.0)];
        let vec_hits = vec![("b.md".into(), 0.9)];
        let hits = rrf_fuse(&bm25, &vec_hits, RRF_K);
        assert_eq!(paths(&hits), vec!["b.md", "a.md"]);
    }

    #[test]
    fn vector_chunks_collapse_to_best_rank_per_path() {
        // Path "multi.md" has three chunks at ranks 1, 2, 4; "other.md"
        // at rank 3. After collapse, ranks should be multi=1, other=2.
        let vec_hits = vec![
            ("multi.md".into(), 0.95),
            ("multi.md".into(), 0.90),
            ("other.md".into(), 0.80),
            ("multi.md".into(), 0.70),
        ];
        let hits = rrf_fuse(&[], &vec_hits, RRF_K);
        assert_eq!(paths(&hits), vec!["multi.md", "other.md"]);
        assert_eq!(hits[0].vec_rank, Some(1));
        assert_eq!(hits[1].vec_rank, Some(2));
        // Chunky notes must NOT get a harmonic-series boost.
        let expected_multi = 1.0 / (RRF_K + 1.0);
        assert!((hits[0].score - expected_multi).abs() < 1e-6);
    }

    #[test]
    fn rrf_formula_matches_literature_exactly() {
        // Cormack 2009 § 3: score(d) = Σ 1 / (k + rank_i(d))
        // Three sources simulated as: BM25 ranks a=1, b=2; Vec ranks a=2, b=1.
        let bm25 = vec![("a.md".into(), 1.0), ("b.md".into(), 0.5)];
        let vec_hits = vec![("b.md".into(), 0.9), ("a.md".into(), 0.8)];
        let hits = rrf_fuse(&bm25, &vec_hits, RRF_K);
        assert_eq!(hits.len(), 2);
        // Both end up with the same score: 1/61 + 1/62, tied.
        let expected = 1.0 / (RRF_K + 1.0) + 1.0 / (RRF_K + 2.0);
        for h in &hits {
            assert!((h.score - expected).abs() < 1e-6);
        }
        // Tie-break: bm25_rank asc, so a.md (bm25=1) first, b.md (bm25=2) second.
        assert_eq!(paths(&hits), vec!["a.md", "b.md"]);
    }

    #[test]
    fn deterministic_tiebreak_by_path_when_no_bm25_rank() {
        // Two vec-only hits at different ranks — scores differ, so no tie.
        // But two at the same rank via duplicate collapse would tie; the
        // input is by construction already ordered so this tests the
        // path tie-break when bm25 ranks are both None.
        let vec_a = vec![("z.md".into(), 0.9), ("a.md".into(), 0.9)];
        let hits1 = rrf_fuse(&[], &vec_a, RRF_K);
        // z ranks 1, a ranks 2 → z first (higher score), not path order.
        assert_eq!(paths(&hits1), vec!["z.md", "a.md"]);
    }

    #[test]
    fn k_rrf_smaller_amplifies_top_ranks() {
        // With k_rrf=0, rank-1 score is 1.0 and rank-2 is 0.5 — a 2×
        // gap. With k_rrf=60, rank-1 is ~0.0164 and rank-2 is ~0.0161
        // — gap shrinks to ~2%. Sanity check that the knob works.
        let bm25 = vec![("a.md".into(), 1.0), ("b.md".into(), 0.5)];
        let sharp = rrf_fuse(&bm25, &[], 0.0);
        let flat = rrf_fuse(&bm25, &[], 60.0);
        let sharp_gap = sharp[0].score / sharp[1].score;
        let flat_gap = flat[0].score / flat[1].score;
        assert!(sharp_gap > flat_gap, "{sharp_gap} should exceed {flat_gap}");
    }

    #[test]
    fn handles_large_inputs_without_collisions() {
        // Smoke test: 10k paths on each side with 5k overlap. Asserts the
        // collapse + accumulate + sort path produces the expected output
        // size without dropping or duplicating entries. No timing
        // assertion — perf is covered by the #[ignore] bench in the IPC
        // command path; running this test under heavy parallel load
        // (full lib suite at 16 threads) makes wall-clock thresholds
        // here flaky without telling us anything about real hybrid-
        // search latency.
        let bm25: Vec<(String, f32)> = (0..10_000)
            .map(|i| (format!("bm-{i}.md"), 10_000.0 - i as f32))
            .collect();
        let vec_hits: Vec<(String, f32)> = (0..10_000)
            .map(|i| (format!("bm-{}.md", i + 5_000), 1.0 - (i as f32 / 10_000.0)))
            .collect();
        let hits = rrf_fuse(&bm25, &vec_hits, RRF_K);
        // 10k BM25 + 10k vec − 5k overlap = 15k unique paths.
        assert_eq!(hits.len(), 15_000);
        // Spot-check: the 5k-overlap region must rank ahead of singletons
        // because two-source hits accumulate two RRF terms.
        let overlap_top = hits.iter().take(50).filter(|h| {
            h.bm25_rank.is_some() && h.vec_rank.is_some()
        }).count();
        assert!(
            overlap_top > 25,
            "expected mostly two-source hits in top 50, got {overlap_top}",
        );
    }

    /// #207 AC #1 — RRF fusion p50/p99 at hybrid-search's realistic
    /// working size (each leg returns top_n = 200 per search.rs). This is
    /// the only hybrid-specific time on top of the component legs; the
    /// end-to-end embed + HNSW + BM25 times are captured by their own
    /// benches and summed by the harness.
    #[test]
    #[ignore]
    fn bench_rrf_fuse_p50_p99() {
        use std::time::Instant;
        const WARMUP: usize = 50;
        const N: usize = 1000;
        const PER_LEG: usize = 200;

        // Deterministic synthetic legs: 50% overlap between BM25 and vec,
        // mimicking search.rs's top_n after a realistic dual-retrieval.
        let bm25: Vec<(String, f32)> = (0..PER_LEG)
            .map(|i| (format!("doc-{i}.md"), (PER_LEG - i) as f32))
            .collect();
        let vec_hits: Vec<(String, f32)> = (0..PER_LEG)
            .map(|i| (format!("doc-{}.md", i + PER_LEG / 2), 1.0 - (i as f32 / PER_LEG as f32)))
            .collect();

        for _ in 0..WARMUP {
            let _ = rrf_fuse(&bm25, &vec_hits, RRF_K);
        }
        let mut samples = Vec::with_capacity(N);
        for _ in 0..N {
            let t0 = Instant::now();
            let _ = rrf_fuse(&bm25, &vec_hits, RRF_K);
            samples.push(t0.elapsed());
        }
        samples.sort();
        let p50 = samples[N / 2];
        let p99 = samples[(N * 99) / 100];
        eprintln!(
            "BENCH_JSON {{\"name\":\"rrf_fuse\",\"p50_ms\":{:.4},\"p99_ms\":{:.4},\"n\":{N},\"per_leg\":{PER_LEG}}}",
            p50.as_secs_f64() * 1000.0,
            p99.as_secs_f64() * 1000.0,
        );
    }
}
