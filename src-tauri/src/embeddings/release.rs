//! #244 — runtime teardown of the embedding stack on semantic-search
//! disable. Owns the invariant that every `Arc<EmbeddingService>` held
//! by `VaultState` is dropped so the ONNX session memory (model weights
//! + arenas) is freed.
//!
//! The global ORT environment stays mapped for the lifetime of the
//! process — `ort::init_from().commit()` is a one-shot via the
//! `RUNTIME_INIT` OnceLock in `embeddings/mod.rs` and the ORT API has
//! no safe tear-down. Residual cost is the ~35-50 MB of the mapped
//! libonnxruntime, documented in #244's "out of scope".

use crate::VaultState;

/// Drop every piece of embedding-related state so the `EmbeddingService`
/// Arc held inside `QueryHandles` and the `EmbedCoordinator` worker is
/// released. Safe to call repeatedly; each slot is set to `None` whether
/// or not it was populated.
///
/// Order matters:
/// 1. Cancel the reindex worker — its `enqueue_bulk` path clones the
///    coordinator's `Sender`, and cancelling makes it stop so the clone
///    drops before we touch the coordinator slot.
/// 2. Drop `embed_coordinator` — releases the primary `Sender` and the
///    strong Arc clone of `EmbeddingService` held by the coordinator
///    struct.
/// 3. Drop `query_handles` — releases the `Arc<EmbeddingService>` shared
///    with the semantic/hybrid search IPC handlers.
///
/// Once every `Sender` clone outside this module has also dropped
/// (watcher-held clone replaced on next `open_vault`; any in-flight
/// `dispatch_embed_update` clone drops when the save IPC returns), the
/// coordinator worker's `blocking_recv` returns `None` and the task
/// exits, dropping the last `Arc<EmbeddingService>`.
pub fn teardown_for_disable(state: &VaultState) {
    if let Ok(mut guard) = state.reindex_handle.lock() {
        if let Some(h) = guard.take() {
            h.cancel();
        }
    }
    if let Ok(mut guard) = state.embed_coordinator.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = state.query_handles.lock() {
        *guard = None;
    }
}
