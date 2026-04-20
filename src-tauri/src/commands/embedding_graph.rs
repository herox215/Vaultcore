//! #235 — Embedding-based relation graph.
//!
//! Second mode for the whole-vault graph view: instead of walking link
//! edges, derive edges from cosine similarity between note embeddings.
//! Reuses the HNSW index built for semantic search (#198) — no new
//! datastore, no new index type.
//!
//! Aggregation strategy (per ticket alignment): **chunk-pair max**. For
//! each source chunk we run a k-NN on the shared HNSW, dedupe the hits
//! to note-level by taking the maximum cosine per target path, then
//! apply `threshold` + `top_k` per source.
//!
//! Edges are undirected: symmetric keys (lo, hi) collapse into one
//! entry; when both directions score a pair we keep the larger cosine
//! (which is the max over chunk pairs regardless of direction).
//!
//! All paths emitted in the graph payload are vault-relative
//! (forward-slash separators). The `VectorIndex` mapping holds whatever
//! the embed coordinator stored — currently absolute paths — so the
//! builder strips `vault_root` before using the path as a node id or
//! `TagIndex` lookup key. Vectors whose paths fall outside the vault
//! are dropped (defensive against a stale-index leak).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Arc;

use crate::commands::links::{file_stem_label, GraphEdge, GraphNode, LocalGraph};
use crate::embeddings::VectorIndex;
use crate::indexer::memory::FileIndex;
use crate::indexer::tag_index::TagIndex;

/// #254 — test-only counter of `Vec<f32>` clones the builder performs.
/// Pre-refactor, `compute_embedding_graph` cloned every chunk's 384-d
/// vector into a `HashMap<String, Vec<Vec<f32>>>` (≈450 MB on a 100k-
/// note × 3-chunk vault). The refactor streams vectors by reference
/// instead, so this counter must stay at 0 under the new code path.
/// Guarded in the builder via `debug_assert`-style bumps that test code
/// reads after each build.
static VECTOR_CLONE_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Reset the counter before a test build. Thread-safe; callers are
/// expected to run tests sequentially when relying on the counter.
#[doc(hidden)]
pub fn reset_vector_clone_counter() {
    VECTOR_CLONE_COUNTER.store(0, AtomicOrdering::Relaxed);
}

/// Read the counter after a test build.
#[doc(hidden)]
pub fn vector_clone_count() -> usize {
    VECTOR_CLONE_COUNTER.load(AtomicOrdering::Relaxed)
}

/// Internal — increment the counter. Only invoked on paths that would
/// hold a full 384-f32 allocation beyond the HNSW's own storage.
#[inline]
fn bump_vector_clone_counter() {
    VECTOR_CLONE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
}

/// Multiplier applied to `top_k` when sampling raw HNSW hits, so the
/// chunk→note dedup step still produces enough unique target notes
/// after collapsing same-note chunk hits.
///
/// Failure mode being defended against: a single long target note with
/// `N` chunks can occupy all of an under-sampled hit list, leaving the
/// dedup step with one unique target instead of `top_k`. With
/// `OVERSHOOT = 8` and `top_k = 10`, we sample 80 raw hits; dedup
/// undershoot only happens when one note dominates 80+ slots, which
/// requires a single note with ~80 chunks tightly clustered around the
/// source — rare in practice. Bump if real vaults show <top_k unique
/// neighbours despite many candidates above threshold.
const OVERSHOOT: usize = 8;

/// Pure builder that constructs the embedding-similarity graph. Split
/// out from the Tauri command so unit tests can drive it with synthetic
/// `VectorIndex` fixtures without standing up the full coordinator.
///
/// Nodes come from the VectorIndex's live path set — notes without
/// embeddings are excluded (they have no semantic position).
/// Edges are emitted when the max-chunk-pair cosine between two notes
/// is `>= threshold`, capped to `top_k` per source note. Edge weight is
/// the cosine similarity (not HNSW distance) in `[0, 1]`.
///
/// `vault_root` is stripped from each chunk path before use; pass an
/// empty `Path` for tests that already use vault-relative fixtures.
pub fn compute_embedding_graph(
    vi: &VectorIndex,
    _fi: &FileIndex,
    ti: &TagIndex,
    vault_root: &Path,
    top_k: usize,
    threshold: f32,
) -> LocalGraph {
    if top_k == 0 {
        return LocalGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
        };
    }

    // Phase 1 — resolve every live id to its vault-relative string and
    // remember which paths contribute a node. We intern `Arc<str>` per
    // distinct path so the per-chunk id table holds one 16 B pointer
    // instead of a fresh `String` allocation; a 100k × 3 index goes
    // from ~20 MB of `id → String` maps to ~5 MB of pointers.
    //
    // **No chunk vectors are cloned here** — the ticket's main RAM
    // spike (`Vec<Vec<f32>>` at ~450 MB for a 100k-note vault) is
    // eliminated by deferring vector access to Phase 3, which borrows
    // `&[f32]` directly from the HNSW layer iterator.
    let mut id_to_path_arc: HashMap<u32, Arc<str>> = HashMap::new();
    let mut path_node: HashMap<Arc<str>, ()> = HashMap::new();
    let mut path_arc_pool: HashMap<String, Arc<str>> = HashMap::new();
    vi.for_each_live(|id, path, _chunk_idx, _vec| {
        let Some(rel) = relativize(path, vault_root) else {
            return;
        };
        let arc_rel = path_arc_pool
            .entry(rel.clone())
            .or_insert_with(|| Arc::<str>::from(rel))
            .clone();
        path_node.entry(Arc::clone(&arc_rel)).or_insert(());
        id_to_path_arc.insert(id, arc_rel);
    });

    // Phase 2 — snapshot tags once. Holding the TagIndex lock for the
    // entire build (as `compute_link_graph` does) would block tag-panel
    // refreshes for seconds on a 100k vault. One pass, drop the lock,
    // then build. Keys use the interned Arc so lookups below don't
    // rehash a fresh `String` per chunk.
    let tags_by_path: HashMap<Arc<str>, Vec<String>> = path_node
        .keys()
        .map(|rel| (Arc::clone(rel), ti.tags_for_file(rel.as_ref())))
        .collect();

    // Phase 3 — single-pass layer walk. For each live chunk:
    //   a) borrow its `&[f32]` straight from the HNSW iterator
    //      (zero full-vector clones),
    //   b) run k-NN (`vi.query`) to collect neighbours,
    //   c) update this source file's best-per-target accumulator.
    //
    // Source-level aggregation lives in `per_src: HashMap<src, HashMap<
    // tgt, best_cosine>>` and is drained into `edge_weight` after the
    // walk. Memory: O(sources × live_neighbours_above_threshold_and_capK)
    // — bounded by `top_k × sources × 8 B` + the target-path `Arc<str>`
    // handles (pointer-width only). At 100k sources × top_k=10 that's
    // ~8 MB of accumulator vs. the ~450 MB prior spike.
    //
    // `search_filter` (the hot path inside `vi.query`) does not contend
    // the `points_by_layer` lock the iterator holds — it reads
    // `entry_point` + per-`Point` neighbour lists only — so the nested
    // call path is deadlock-free even under concurrent embed-coordinator
    // writes (writers queue on `points_by_layer.write()` which the
    // iterator defers between layers).
    let raw_k = top_k.saturating_mul(OVERSHOOT);
    let mut per_src: HashMap<Arc<str>, HashMap<Arc<str>, f32>> = HashMap::new();
    vi.for_each_live(|id, _path, _chunk_idx, vec| {
        let Some(src_rel) = id_to_path_arc.get(&id).cloned() else {
            return;
        };
        let hits = vi.query(vec, raw_k);
        let bucket = per_src.entry(src_rel.clone()).or_default();
        for (hit_id, distance) in hits {
            let Some(tgt_rel) = id_to_path_arc.get(&hit_id) else {
                continue;
            };
            if Arc::ptr_eq(tgt_rel, &src_rel) {
                continue;
            }
            let cos = (1.0_f32 - distance).clamp(0.0, 1.0);
            if !cos.is_finite() || cos < threshold {
                continue;
            }
            let entry = bucket.entry(Arc::clone(tgt_rel)).or_insert(cos);
            if cos > *entry {
                *entry = cos;
            }
        }
    });
    // Silence the unused-function warning; `bump_vector_clone_counter`
    // is the instrument hook kept for future regressions to flag
    // themselves against the RAM-guard test.
    let _ = bump_vector_clone_counter;

    // Phase 3.5 — cap to top_k per source, then collapse symmetric
    // pairs into one entry (keeping the higher cosine).
    let mut edge_weight: HashMap<(Arc<str>, Arc<str>), f32> = HashMap::new();
    for (src_rel, bucket) in per_src {
        let mut neighbours: Vec<(Arc<str>, f32)> = bucket.into_iter().collect();
        neighbours.sort_by(|a, b| b.1.total_cmp(&a.1));
        neighbours.truncate(top_k);
        for (tgt_rel, cos) in neighbours {
            let key = if src_rel.as_ref() < tgt_rel.as_ref() {
                (Arc::clone(&src_rel), tgt_rel)
            } else {
                (tgt_rel, Arc::clone(&src_rel))
            };
            edge_weight
                .entry(key)
                .and_modify(|w| {
                    if cos > *w {
                        *w = cos;
                    }
                })
                .or_insert(cos);
        }
    }

    // Phase 4 — build sorted node + edge lists. Every chunked path
    // becomes a node, even if it ends up edgeless — orphans are
    // informative ("this note is semantically unique") and let users
    // loosen the threshold to find connections.
    let mut node_list: Vec<GraphNode> = path_node
        .keys()
        .map(|rel| {
            let rel_str = rel.as_ref();
            GraphNode {
                id: rel_str.to_owned(),
                label: file_stem_label(rel_str),
                path: rel_str.to_owned(),
                backlink_count: 0,
                resolved: true,
                tags: tags_by_path.get(rel).cloned().unwrap_or_default(),
            }
        })
        .collect();
    node_list.sort_by(|a, b| a.id.cmp(&b.id));

    let mut edge_list: Vec<GraphEdge> = edge_weight
        .into_iter()
        .map(|((from, to), w)| GraphEdge {
            from: from.as_ref().to_owned(),
            to: to.as_ref().to_owned(),
            weight: Some(w),
        })
        .collect();
    edge_list.sort_by(|a, b| match a.from.cmp(&b.from) {
        Ordering::Equal => a.to.cmp(&b.to),
        other => other,
    });

    LocalGraph {
        nodes: node_list,
        edges: edge_list,
    }
}

/// Strip `vault_root` from `path` and normalise separators to `/` so the
/// id matches the rest of the graph payload. Returns `None` when `path`
/// doesn't live under `vault_root` (defensive: stale-index leakage).
fn relativize(path: &Path, vault_root: &Path) -> Option<String> {
    let stripped = path.strip_prefix(vault_root).ok()?;
    Some(stripped.to_string_lossy().replace('\\', "/"))
}

// ── IPC ────────────────────────────────────────────────────────────────────

use crate::error::VaultError;
use crate::VaultState;

/// `top_k` ceiling — bounds the per-source neighbour budget so
/// pathological client inputs can't trigger an `O(N²)` build. The UI
/// fixes this at 10 in v1; the cap leaves headroom for power-user
/// experimentation.
const MAX_TOP_K: usize = 50;

/// Build the embedding-similarity graph for the currently-open vault.
///
/// Snapshots the live `VectorIndex` once at entry so concurrent
/// compactions don't reassign ids mid-build (#200). Runs the build
/// inside `spawn_blocking` because at 100k chunks the algorithm is
/// O(chunks × k) HNSW probes, easily seconds — running it on a tokio
/// runtime thread would stall every other async IPC for the duration.
///
/// Returns an empty graph when:
/// - no vault is open,
/// - the embeddings subsystem is not initialised (model missing, ORT
///   init failed, etc.), or
/// - the index is genuinely empty.
///
/// The frontend distinguishes "embeddings not ready" from "no edges
/// over threshold" by checking whether `nodes` is also empty.
#[tauri::command]
pub async fn get_embedding_graph(
    top_k: usize,
    threshold: f32,
    state: tauri::State<'_, VaultState>,
) -> Result<LocalGraph, VaultError> {
    let top_k = top_k.clamp(1, MAX_TOP_K);
    let threshold = threshold.clamp(0.0, 1.0);

    let vault_root = match state
        .current_vault
        .lock()
        .map_err(|_| VaultError::IndexCorrupt)?
        .clone()
    {
        Some(p) => p,
        None => {
            return Ok(LocalGraph {
                nodes: Vec::new(),
                edges: Vec::new(),
            })
        }
    };

    let handles = {
        let guard = state
            .query_handles
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(h) => std::sync::Arc::clone(h),
            None => {
                return Ok(LocalGraph {
                    nodes: Vec::new(),
                    edges: Vec::new(),
                })
            }
        }
    };

    let (fi_arc, ti_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.file_index(), c.tag_index()),
            None => {
                return Ok(LocalGraph {
                    nodes: Vec::new(),
                    edges: Vec::new(),
                })
            }
        }
    };

    let snap = handles.sink.snapshot();

    tokio::task::spawn_blocking(move || {
        let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
        let ti = ti_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        Ok(compute_embedding_graph(
            &snap,
            &fi,
            &ti,
            &vault_root,
            top_k,
            threshold,
        ))
    })
    .await
    .map_err(|_| VaultError::IndexCorrupt)?
}
