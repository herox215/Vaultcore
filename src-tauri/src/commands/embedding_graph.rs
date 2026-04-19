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

use crate::commands::links::{file_stem_label, GraphEdge, GraphNode, LocalGraph};
use crate::embeddings::VectorIndex;
use crate::indexer::memory::FileIndex;
use crate::indexer::tag_index::TagIndex;

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

    // Phase 1 — snapshot all live chunks grouped by (vault-rel) path.
    // We collect vectors here so subsequent `vi.query` calls don't race
    // the layer iterator against later compactions.
    let mut chunks_by_path: HashMap<String, Vec<Vec<f32>>> = HashMap::new();
    let mut id_to_path: HashMap<u32, String> = HashMap::new();
    vi.for_each_live(|id, path, _chunk_idx, vec| {
        let Some(rel) = relativize(path, vault_root) else {
            return;
        };
        chunks_by_path
            .entry(rel.clone())
            .or_default()
            .push(vec.to_vec());
        id_to_path.insert(id, rel);
    });

    // Phase 2 — snapshot tags once. Holding the TagIndex lock for the
    // entire build (as `compute_link_graph` does) would block tag-panel
    // refreshes for seconds on a 100k vault. One pass, drop the lock,
    // then build.
    let tags_by_path: HashMap<String, Vec<String>> = chunks_by_path
        .keys()
        .map(|rel| (rel.clone(), ti.tags_for_file(rel)))
        .collect();

    // Phase 3 — for each source path × chunk, k-NN + chunk-pair-max
    // aggregation. Edges are keyed (lo, hi) so the symmetric pair
    // collapses naturally to one entry.
    let mut edge_weight: HashMap<(String, String), f32> = HashMap::new();
    let raw_k = top_k.saturating_mul(OVERSHOOT);
    for (src_rel, chunks) in &chunks_by_path {
        // Per source: target_rel → best cosine across all (src_chunk, hit) pairs.
        let mut best_per_target: HashMap<String, f32> = HashMap::new();
        for chunk_vec in chunks {
            for (hit_id, distance) in vi.query(chunk_vec, raw_k) {
                let Some(tgt_rel) = id_to_path.get(&hit_id) else {
                    continue; // tombstoned mid-build, or foreign-vault leak
                };
                if tgt_rel == src_rel {
                    continue;
                }
                let cos = (1.0_f32 - distance).clamp(0.0, 1.0);
                if !cos.is_finite() {
                    continue;
                }
                if cos < threshold {
                    continue;
                }
                let entry = best_per_target.entry(tgt_rel.clone()).or_insert(cos);
                if cos > *entry {
                    *entry = cos;
                }
            }
        }

        // Top-K cap per source. `total_cmp` is NaN-safe; we already
        // filtered non-finite cosines but use the safer comparator
        // anyway — partial_cmp would panic on a future regression.
        let mut neighbours: Vec<(String, f32)> = best_per_target.into_iter().collect();
        neighbours.sort_by(|a, b| b.1.total_cmp(&a.1));
        neighbours.truncate(top_k);

        for (tgt_rel, cos) in neighbours {
            let key = if src_rel < &tgt_rel {
                (src_rel.clone(), tgt_rel)
            } else {
                (tgt_rel, src_rel.clone())
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
    let mut node_list: Vec<GraphNode> = chunks_by_path
        .keys()
        .map(|rel| GraphNode {
            id: rel.clone(),
            label: file_stem_label(rel),
            path: rel.clone(),
            backlink_count: 0, // backlinks are a link-graph concept; N/A here.
            resolved: true,
            tags: tags_by_path.get(rel).cloned().unwrap_or_default(),
        })
        .collect();
    node_list.sort_by(|a, b| a.id.cmp(&b.id));

    let mut edge_list: Vec<GraphEdge> = edge_weight
        .into_iter()
        .map(|((from, to), w)| GraphEdge {
            from,
            to,
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
