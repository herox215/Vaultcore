//! `query` (#202) — text-input top-k search composing `EmbeddingService`
//! (#194) and `VectorIndex` (#198). Sits one layer above the raw HNSW so
//! IPC handlers (and the future hybrid-search fusion in #203) can ask
//! "find the nearest k chunks to this query string" without touching the
//! embed / index plumbing themselves.
//!
//! Concurrency: the returned `QueryHandles` is `Send + Sync` and cheap to
//! clone (two `Arc`s). The embed call serialises through
//! `EmbeddingService`'s internal `Mutex` — see #205 for ORT session
//! tuning that addresses the contention with the embed-on-save / reindex
//! workers under bursty queries.

use std::sync::Arc;

use serde::Serialize;

use super::{EmbeddingError, EmbeddingService, HnswSink};

/// Combined handle the IPC layer needs to answer `semantic_search` —
/// the embedder for the query text plus the sink that owns the live
/// `VectorIndex` snapshot. Wrapped together so `VaultState` only adds
/// one new `Mutex<Option<_>>` field rather than two parallel ones.
pub struct QueryHandles {
    pub service: Arc<EmbeddingService>,
    pub sink: Arc<HnswSink>,
}

/// One ranked semantic-search hit. Path + chunk-index identifies the
/// span; `score` is cosine similarity in `[-1, 1]` (≈ `[0, 1]` for
/// real English prose) — higher = more similar. `id` is intentionally
/// omitted: HNSW internal u32 ids are reassigned on compaction (#200),
/// so leaking them across an async IPC boundary is a footgun.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHit {
    pub path: String,
    pub chunk_index: usize,
    pub score: f32,
}

/// Minimum cosine similarity for a vec-leg hit to leave this module.
/// HNSW always returns its k nearest neighbours regardless of how far
/// away they are — on small vaults the nearest neighbour can still be
/// near-orthogonal noise, which then rides into the RRF top-k on rank
/// alone and confuses users ("why does my search for 'katze' surface a
/// note that says 'test lol dasd'?"). 0.3 is a conservative floor on
/// L2-normalised MiniLM: real semantic matches on English prose sit at
/// 0.4–0.8, and anything below ~0.3 is near-orthogonal — dropping it
/// loses nothing but noise.
pub const MIN_SEMANTIC_SCORE: f32 = 0.3;

fn drop_noise_hits(hits: Vec<SemanticHit>) -> Vec<SemanticHit> {
    hits.into_iter()
        .filter(|h| h.score >= MIN_SEMANTIC_SCORE)
        .collect()
}

/// Embed `text`, query the index for the top `k` nearest chunks, and
/// convert distances to similarity scores. Returns an empty vec for an
/// empty query or empty index — never errors on either; that case is
/// expected during reindex bring-up before any chunks have landed.
///
/// Distance → score: `score = 1.0 - distance` because `DistDot` returns
/// `1 - cos_sim` on L2-normalised vectors. The score is left in its raw
/// `[-1, 1]` range so downstream RRF fusion (#203) can keep the
/// "0 = orthogonal" reading.
pub fn semantic_search_query(
    handles: &QueryHandles,
    text: &str,
    k: usize,
) -> Result<Vec<SemanticHit>, EmbeddingError> {
    if text.trim().is_empty() || k == 0 {
        return Ok(Vec::new());
    }
    let snap = handles.sink.snapshot();
    if snap.is_empty() {
        return Ok(Vec::new());
    }
    let vec = handles.service.embed(text)?;
    if vec.len() != super::DIM {
        return Err(EmbeddingError::InvalidArgument(format!(
            "embedding dim mismatch: got {}, expected {}",
            vec.len(),
            super::DIM
        )));
    }
    let hits = snap.query_with_paths(&vec, k);
    let mapped: Vec<SemanticHit> = hits
        .into_iter()
        .map(|(p, idx, dist)| SemanticHit {
            path: p.to_string_lossy().into_owned(),
            chunk_index: idx,
            score: 1.0 - dist,
        })
        .collect();
    // Filter near-orthogonal noise BEFORE returning so both the direct
    // `semantic_search` IPC and the hybrid fusion path see a clean list.
    Ok(drop_noise_hits(mapped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embeddings::{Chunker, VectorIndex};
    use std::path::PathBuf;

    fn try_load() -> Option<(Arc<EmbeddingService>, Arc<Chunker>)> {
        let svc = EmbeddingService::load(None).ok()?;
        let chk = Chunker::load(None).ok()?;
        Some((svc, chk))
    }

    fn handles_with(sink: Arc<HnswSink>, svc: Arc<EmbeddingService>) -> QueryHandles {
        QueryHandles { service: svc, sink }
    }

    #[test]
    fn empty_query_returns_empty_without_embedding() {
        let Some((svc, _chk)) = try_load() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(HnswSink::open(tmp.path().to_path_buf(), 8));
        let h = handles_with(sink, svc);
        assert!(semantic_search_query(&h, "", 5).unwrap().is_empty());
        assert!(semantic_search_query(&h, "   ", 5).unwrap().is_empty());
    }

    #[test]
    fn empty_index_returns_empty_not_panic() {
        let Some((svc, _chk)) = try_load() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(HnswSink::open(tmp.path().to_path_buf(), 8));
        let h = handles_with(sink, svc);
        let hits = semantic_search_query(&h, "anything at all", 10).unwrap();
        assert!(hits.is_empty(), "expected no hits on empty index, got {hits:?}");
    }

    #[test]
    fn k_zero_returns_empty() {
        let Some((svc, _chk)) = try_load() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(HnswSink::open(tmp.path().to_path_buf(), 8));
        let h = handles_with(sink, svc);
        assert!(semantic_search_query(&h, "anything", 0).unwrap().is_empty());
    }

    #[test]
    fn semantically_close_text_outranks_unrelated() {
        let Some((svc, _chk)) = try_load() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(HnswSink::open(tmp.path().to_path_buf(), 16));

        // Seed the index with several small notes via the live embedder so
        // the test exercises the real embedding pipeline end-to-end.
        // HNSW graph traversal can return fewer than k hits on very small
        // indices (< ~5 points) due to layer-entry sparsity — seeding 6
        // puts us safely past that floor.
        let snap = sink.snapshot();
        let docs = [
            ("cats.md", "Cats are independent creatures that purr when content."),
            ("dogs.md", "Dogs are loyal pack animals that wag their tails when happy."),
            ("rust.md", "Rust async runtimes use cooperative scheduling and futures."),
            ("recipe.md", "Bake the sourdough at 240 degrees for forty minutes."),
            ("music.md", "Jazz improvisation builds on cycling chord progressions."),
            ("math.md", "Eigenvalues of a symmetric matrix are always real numbers."),
        ];
        for (path, text) in docs {
            let v = svc.embed(text).unwrap();
            snap.insert(PathBuf::from(path), 0, &v);
        }
        drop(snap);

        let h = handles_with(sink, svc);
        let hits = semantic_search_query(&h, "feline body language", 3).unwrap();
        assert!(!hits.is_empty(), "expected at least one hit");
        // The cat note must rank first for a feline-related query.
        assert_eq!(hits[0].path, "cats.md", "expected cats first, got {hits:?}");
        // Scores must be non-increasing.
        for w in hits.windows(2) {
            assert!(
                w[0].score >= w[1].score - 1e-6,
                "scores not non-increasing: {} < {}",
                w[0].score,
                w[1].score
            );
        }
        // Top score for a related query should be clearly positive.
        assert!(
            hits[0].score > 0.3,
            "top score suspiciously low: {} for {}",
            hits[0].score,
            hits[0].path
        );
    }

    #[test]
    fn k_caps_result_count() {
        let Some((svc, _chk)) = try_load() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(HnswSink::open(tmp.path().to_path_buf(), 8));
        let snap = sink.snapshot();
        for i in 0..5u64 {
            let v = svc.embed(&format!("note number {i} with unique content")).unwrap();
            snap.insert(PathBuf::from(format!("n-{i}.md")), 0, &v);
        }
        drop(snap);

        let h = handles_with(sink, svc);
        for k in [1usize, 3, 5] {
            let hits = semantic_search_query(&h, "note", k).unwrap();
            assert!(hits.len() <= k, "k={k} returned {} hits", hits.len());
        }
    }

    #[test]
    fn drop_noise_hits_removes_subthreshold_scores() {
        // The filter drops hits below MIN_SEMANTIC_SCORE (noise-adjacent
        // neighbours HNSW returns on small vaults) while keeping hits at
        // the threshold and above. Order within the kept set is preserved
        // because HNSW already hands them to us in rank order.
        let hits = vec![
            SemanticHit { path: "a.md".into(), chunk_index: 0, score: 0.82 },
            SemanticHit { path: "b.md".into(), chunk_index: 0, score: MIN_SEMANTIC_SCORE - 0.01 },
            SemanticHit { path: "c.md".into(), chunk_index: 0, score: MIN_SEMANTIC_SCORE },
            SemanticHit { path: "d.md".into(), chunk_index: 0, score: 0.05 },
            SemanticHit { path: "e.md".into(), chunk_index: 0, score: -0.2 },
        ];
        let kept = drop_noise_hits(hits);
        let paths: Vec<&str> = kept.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "c.md"]);
    }

    #[test]
    fn drop_noise_hits_empty_passthrough() {
        let kept = drop_noise_hits(Vec::new());
        assert!(kept.is_empty());
    }

    #[test]
    fn handles_are_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<QueryHandles>();
        assert_send_sync::<Arc<QueryHandles>>();
    }

    #[test]
    fn semantic_hit_serializes_to_camel_case() {
        let h = SemanticHit {
            path: "a/b.md".into(),
            chunk_index: 3,
            score: 0.42,
        };
        let json = serde_json::to_string(&h).unwrap();
        assert!(json.contains("\"chunkIndex\":3"), "got: {json}");
        assert!(json.contains("\"score\":0.42"), "got: {json}");
    }

    /// Ensure VectorIndex is queryable via the helper — exercises the
    /// path/sink composition without involving the live embedder. Uses
    /// hand-crafted unit vectors so the test runs even without the
    /// bundled model.
    #[test]
    fn helper_composes_sink_snapshot_correctly() {
        // We can't construct an EmbeddingService without the model, so
        // this test only verifies the snapshot-query side of the pipeline
        // by calling VectorIndex directly. The text→embed→query pipeline
        // is covered by `semantically_close_text_outranks_unrelated`.
        let idx = VectorIndex::new(4);
        let mut v = vec![0f32; super::super::DIM];
        v[0] = 1.0;
        idx.insert(PathBuf::from("only.md"), 0, &v);
        let hits = idx.query_with_paths(&v, 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, PathBuf::from("only.md"));
    }

    /// AC #4 for #202 — p50 query latency under 5 ms at 100k vectors
    /// (pre-fusion, i.e. HNSW + mapping-lookup only, no BM25 / RRF).
    /// The per-query breakdown measured here is:
    ///   - `service.embed` (~15 ms on cold ORT, ~2–5 ms warm)
    ///   - `VectorIndex::query_with_paths` with k=10, ef_search=64
    ///     (~100–500 µs against real-clustered data)
    ///
    /// The bench is `#[ignore]` because it builds 100k vectors and loads
    /// the full MiniLM model. Run with
    /// `cargo test --release --features embeddings -- --ignored bench_semantic_query`.
    #[test]
    #[ignore]
    fn bench_semantic_query_p50_under_5ms() {
        use std::time::{Duration, Instant};
        const N: usize = 100_000;
        const Q: usize = 100;

        let Some((svc, _chk)) = try_load() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(HnswSink::open(tmp.path().to_path_buf(), N));

        // Synthetic corpus — unit vectors derived from a simple hash.
        // Real embedding distributions cluster tighter than uniform noise,
        // so this is the pessimistic case for HNSW recall + traversal.
        let snap = sink.snapshot();
        let mut items: Vec<(PathBuf, usize, Vec<f32>)> = Vec::with_capacity(N);
        for i in 0..N as u64 {
            let mut s = i.wrapping_mul(0x9E3779B97F4A7C15);
            let mut v = Vec::with_capacity(super::super::DIM);
            for _ in 0..super::super::DIM {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                let bits = (s >> 32) as u32;
                v.push((bits as f32 / u32::MAX as f32) * 2.0 - 1.0);
            }
            let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            for x in &mut v {
                *x /= n;
            }
            items.push((PathBuf::from(format!("/v/{i}.md")), 0, v));
        }
        snap.bulk_insert(items);
        drop(snap);

        let h = handles_with(sink, svc);
        // Warm-up: one embed + one query to prime ORT + HNSW caches.
        let _ = semantic_search_query(&h, "warm up the embedder", 10).unwrap();

        let probes: Vec<String> = (0..Q)
            .map(|i| format!("query number {i} about various topics"))
            .collect();
        let mut samples = Vec::with_capacity(Q);
        for p in &probes {
            let t0 = Instant::now();
            let _ = semantic_search_query(&h, p, 10).unwrap();
            samples.push(t0.elapsed());
        }
        samples.sort();
        let p50 = samples[Q / 2];
        eprintln!("semantic_search p50 over {Q} queries @ {N} vectors: {p50:?}");
        assert!(
            p50 < Duration::from_millis(5),
            "p50 latency too slow: {p50:?}",
        );
    }
}
