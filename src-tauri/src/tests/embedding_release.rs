//! #244 — RAM release regression guard.
//!
//! Locks in the invariant that disabling semantic search at runtime
//! drops every `Arc<EmbeddingService>` held by `VaultState`, so the
//! model weights + ORT session memory are released. See issue #244
//! for the bug and proposal; the teardown path is
//! `embeddings::teardown_for_disable(&VaultState)`.
//!
//! Skips cleanly when the bundled model isn't available (same pattern
//! as every other #[cfg(feature = "embeddings")] test in this module).

#![cfg(feature = "embeddings")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::embeddings::{
    teardown_for_disable, Chunker, EmbedCoordinator, EmbeddingService, HnswSink, QueryHandles,
    VectorSink,
};
use crate::VaultState;

/// Best-effort service load. Returns `None` when the runtime dylib or
/// the bundled model isn't present (dev machines / CI without resources).
fn try_load() -> Option<(Arc<EmbeddingService>, Arc<Chunker>)> {
    let svc = EmbeddingService::load(None).ok()?;
    let chk = Chunker::load(None).ok()?;
    Some((svc, chk))
}

/// Populate `VaultState` with a live embed coordinator + query handles,
/// exactly as `open_vault` does. Returns a `Weak<EmbeddingService>` clone
/// the caller can use to probe whether the Arc has been fully dropped.
fn arm_state(
    state: &VaultState,
    svc: Arc<EmbeddingService>,
    chk: Arc<Chunker>,
    embed_dir: std::path::PathBuf,
) -> std::sync::Weak<EmbeddingService> {
    let svc_for_query = Arc::clone(&svc);
    let svc_weak = Arc::downgrade(&svc);
    let sink_concrete = Arc::new(HnswSink::open(embed_dir, 64));
    let sink: Arc<dyn VectorSink> =
        Arc::clone(&sink_concrete) as Arc<dyn VectorSink>;
    let coord = EmbedCoordinator::spawn(svc, chk, sink);
    {
        let mut guard = state.embed_coordinator.lock().unwrap();
        *guard = Some(coord);
    }
    {
        let mut guard = state.query_handles.lock().unwrap();
        *guard = Some(Arc::new(QueryHandles {
            service: svc_for_query,
            sink: sink_concrete,
        }));
    }
    svc_weak
}

fn wait_weak_dead(weak: &std::sync::Weak<EmbeddingService>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if weak.upgrade().is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    weak.upgrade().is_none()
}

/// After `teardown_for_disable`, every slot in `VaultState` that holds
/// an `Arc<EmbeddingService>` must be cleared AND the worker thread
/// must exit so its own Arc clone drops. The `Weak` we held from the
/// original load must no longer upgrade.
#[test]
fn teardown_releases_embedding_service_arc() {
    let Some((svc, chk)) = try_load() else {
        eprintln!("SKIP teardown_releases_embedding_service_arc: model not bundled");
        return;
    };

    // We need a tokio runtime for `EmbedCoordinator::spawn` (it uses
    // `tokio::task::spawn_blocking`). Build a minimal current-thread runtime
    // and block the whole test inside it, matching the existing
    // `embed_coordinator` module tests.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        let state = VaultState::default();
        let tmp = tempfile::tempdir().unwrap();
        let weak = arm_state(&state, svc, chk, tmp.path().to_path_buf());

        // Sanity: Arc is live right now — the state itself holds two
        // strong references (coordinator worker + query_handles), so
        // upgrade must still succeed.
        assert!(
            weak.upgrade().is_some(),
            "pre-teardown: service Arc must still be live",
        );

        teardown_for_disable(&state);

        // After teardown the three slots must be empty.
        assert!(
            state.embed_coordinator.lock().unwrap().is_none(),
            "embed_coordinator must be None after teardown",
        );
        assert!(
            state.query_handles.lock().unwrap().is_none(),
            "query_handles must be None after teardown",
        );
        assert!(
            state.reindex_handle.lock().unwrap().is_none(),
            "reindex_handle must be None after teardown",
        );

        // The worker holds its own Arc clone and releases it only after
        // it finishes draining the channel — give it a few hundred ms
        // for `blocking_recv` to unblock and the task to wind down.
        assert!(
            wait_weak_dead(&weak, Duration::from_secs(5)),
            "post-teardown: EmbeddingService Arc must be fully dropped — {} strong refs remain",
            weak.strong_count(),
        );
    });
}
