//! #244 — runtime teardown of the embedding stack on semantic-search
//! disable. Will own the invariant that every `Arc<EmbeddingService>`
//! held by `VaultState` is dropped so the ONNX session memory (model
//! weights + arenas) is freed.
//!
//! Stub landed first so the regression test in `tests::embedding_release`
//! has a symbol to call. The stub intentionally does nothing — the real
//! teardown lands in the follow-up commit and the test flips from red
//! to green there.

use crate::VaultState;

/// Drop every piece of embedding-related state so the `EmbeddingService`
/// Arc held inside `QueryHandles` and the `EmbedCoordinator` worker is
/// released.
///
/// TODO(#244): implement. Currently a stub so the failing regression
/// test in `tests::embedding_release` compiles against a real symbol.
pub fn teardown_for_disable(_state: &VaultState) {
    // intentionally empty — real teardown in the next commit
}
