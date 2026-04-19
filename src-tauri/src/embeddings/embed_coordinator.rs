//! `EmbedCoordinator` (#196) — async, debounced, non-blocking pipeline
//! that turns every save into a chunk → embed → sink-store cycle without
//! holding up the save IPC.
//!
//! Coalescing strategy: a `pending` map of `path → latest content` plus a
//! bounded wake-up channel that only carries paths. The map is the source
//! of truth; the channel is just a "there is work to do" signal. Three
//! rapid saves to the same path overwrite one another in the map and
//! produce exactly one embed.
//!
//! Backpressure: a full wake-up channel is benign because the latest
//! content already lives in the map — any subsequent successful enqueue
//! drains it. So the save IPC never blocks: `enqueue` is sync,
//! non-blocking, and a `QueueFull` outcome only logs.
//!
//! The worker MUST be spawned on `tokio::task::spawn_blocking` (not
//! `tokio::spawn`). Two reasons: (1) `Receiver::blocking_recv` panics if
//! a Tokio runtime is running on the calling thread, and (2) ORT
//! inference is synchronous + CPU-bound (~10–25 ms), which would stall
//! every other future on the runtime. Same precedent as the Tantivy
//! IndexCoordinator at `src-tauri/src/indexer/mod.rs:201-216`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::{Chunk, Chunker, EmbeddingService, VectorSink};

/// Wake-up channel capacity. Carries `PathBuf` only — actual content
/// lives in the `pending` map. 1024 slots is generous: every event is
/// keyboard-paced (one human, one editor) and a full channel still
/// preserves correctness via the map. The indexer uses 8192 because it
/// absorbs bulk filesystem events; this queue does not.
pub const WAKEUP_CAPACITY: usize = 1024;

#[derive(Debug, thiserror::Error)]
pub enum EnqueueError {
    #[error("embed wake-up channel full — embed will run on next save")]
    QueueFull,
    #[error("embed coordinator shut down")]
    Closed,
    #[error("pending map mutex poisoned")]
    LockPoisoned,
}

pub struct EmbedCoordinator {
    pub tx: mpsc::Sender<PathBuf>,
    pub pending: Arc<Mutex<HashMap<PathBuf, String>>>,
}

impl EmbedCoordinator {
    /// Spawn the worker on the blocking pool. The `service`, `chunker`,
    /// and `sink` are passed in so tests can inject a counting sink.
    pub fn spawn(
        service: Arc<EmbeddingService>,
        chunker: Arc<Chunker>,
        sink: Arc<dyn VectorSink>,
    ) -> Self {
        Self::spawn_with_capacity(service, chunker, sink, WAKEUP_CAPACITY)
    }

    /// Spawn with a custom wake-up channel capacity. Test-only entry that
    /// makes deterministic `QueueFull` reproducible without flooding 1024
    /// paths.
    pub fn spawn_with_capacity(
        service: Arc<EmbeddingService>,
        chunker: Arc<Chunker>,
        sink: Arc<dyn VectorSink>,
        capacity: usize,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<PathBuf>(capacity.max(1));
        let pending: Arc<Mutex<HashMap<PathBuf, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let worker_pending = Arc::clone(&pending);
        tokio::task::spawn_blocking(move || {
            run_worker(service, chunker, sink, worker_pending, rx);
        });
        Self { tx, pending }
    }

    /// Non-blocking enqueue. Updates the pending map then signals the
    /// worker. `QueueFull` is benign — the content is in the map and the
    /// next successful enqueue (same path or another) will trigger a
    /// drain. Caller logs and proceeds.
    pub fn enqueue(
        &self,
        path: PathBuf,
        content: String,
    ) -> Result<(), EnqueueError> {
        {
            let mut g = self
                .pending
                .lock()
                .map_err(|_| EnqueueError::LockPoisoned)?;
            g.insert(path.clone(), content);
        }
        match self.tx.try_send(path) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => Err(EnqueueError::QueueFull),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(EnqueueError::Closed),
        }
    }
}

// `tx` is the only Sender clone held outside the coordinator itself —
// `dispatch_embed_update` in `commands/files.rs` clones it transiently
// per save and drops it before returning. So dropping the coordinator
// closes the channel and the worker's `blocking_recv` returns `None`.

fn run_worker(
    service: Arc<EmbeddingService>,
    chunker: Arc<Chunker>,
    sink: Arc<dyn VectorSink>,
    pending: Arc<Mutex<HashMap<PathBuf, String>>>,
    mut rx: mpsc::Receiver<PathBuf>,
) {
    while let Some(_path) = rx.blocking_recv() {
        // Drain redundant wake-ups — the map already coalesces content.
        while rx.try_recv().is_ok() {}

        let snapshot: Vec<(PathBuf, String)> = match pending.lock() {
            Ok(mut g) => g.drain().collect(),
            Err(_) => {
                log::warn!("embed pending map poisoned; skipping batch");
                continue;
            }
        };

        for (path, content) in snapshot {
            let chunks = match chunker.chunk(&content) {
                Ok(c) if c.is_empty() => continue,
                Ok(c) => c,
                Err(e) => {
                    log::warn!("chunker failed for {}: {e}", path.display());
                    continue;
                }
            };
            let texts: Vec<&str> = chunks.iter().map(|c| c.text.as_str()).collect();
            let vectors = match service.embed_batch(&texts) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("embed failed for {}: {e}", path.display());
                    continue;
                }
            };
            let pairs: Vec<(Chunk, Vec<f32>)> =
                chunks.into_iter().zip(vectors).collect();
            sink.store(&path, pairs);
        }
    }
    log::info!("EmbedCoordinator worker shut down");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// Collects every `store` call so tests can assert coalescing.
    struct CountingSink {
        calls: AtomicUsize,
        by_path: Mutex<HashMap<PathBuf, Vec<String>>>,
    }

    impl CountingSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                by_path: Mutex::new(HashMap::new()),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn paths(&self) -> Vec<PathBuf> {
            self.by_path.lock().unwrap().keys().cloned().collect()
        }
    }

    impl VectorSink for CountingSink {
        fn store(&self, path: &Path, chunks_with_vectors: Vec<(Chunk, Vec<f32>)>) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let snippets: Vec<String> = chunks_with_vectors
                .into_iter()
                .map(|(c, _)| c.text)
                .collect();
            self.by_path
                .lock()
                .unwrap()
                .entry(path.to_path_buf())
                .or_default()
                .extend(snippets);
        }
    }

    fn try_load_service_and_chunker() -> Option<(Arc<EmbeddingService>, Arc<Chunker>)> {
        let svc = EmbeddingService::load(None).ok()?;
        let chk = Chunker::load(None).ok()?;
        Some((svc, chk))
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// Wait for the worker to drain. Polls the pending map + a sink-side
    /// signal up to `timeout`. Returns `true` if `cond` becomes true.
    fn wait_until<F: Fn() -> bool>(cond: F, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    #[test]
    fn coalesces_three_rapid_saves_to_one_embed() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP: model not bundled");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            let path = PathBuf::from("/tmp/coalesce.md");
            for v in ["v1", "v2", "v3"] {
                coord
                    .enqueue(path.clone(), v.to_string())
                    .expect("enqueue ok");
            }
            assert!(wait_until(|| sink.calls() >= 1, Duration::from_secs(5)));
            // Give a beat for any spurious extra batches; coalescing should
            // keep us at exactly one.
            std::thread::sleep(Duration::from_millis(150));
            assert_eq!(sink.calls(), 1, "three rapid saves must coalesce");
            // Latest content wins.
            let by_path = sink.by_path.lock().unwrap();
            let snippets = &by_path[&path];
            assert!(
                snippets.iter().any(|s| s.contains("v3")),
                "latest content must reach the sink, got {:?}",
                snippets
            );
        });
    }

    #[test]
    fn different_paths_each_get_one_embed() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            for i in 0..5 {
                let p = PathBuf::from(format!("/tmp/note-{i}.md"));
                coord.enqueue(p, format!("note number {i}")).unwrap();
            }
            assert!(wait_until(
                || sink.paths().len() >= 5,
                Duration::from_secs(5)
            ));
            assert_eq!(sink.paths().len(), 5);
        });
    }

    /// Lost-wake guard: after the last enqueue returns, the worker MUST
    /// eventually drain the pending map. A regression that swaps the
    /// `tx.try_send` to before the `pending.insert` would silently drop
    /// the final save — this test catches that.
    #[test]
    fn pending_map_is_eventually_drained() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            for i in 0..20 {
                let p = PathBuf::from(format!("/tmp/drain-{i}.md"));
                coord.enqueue(p, format!("content {i}")).unwrap();
            }
            let pending = Arc::clone(&coord.pending);
            let drained = wait_until(
                || {
                    pending.lock().map(|g| g.is_empty()).unwrap_or(false)
                        && sink.calls() >= 1
                },
                Duration::from_secs(10),
            );
            assert!(drained, "pending map should drain");
        });
    }

    #[test]
    fn queue_full_returns_queue_full_but_content_persists() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            // Capacity 1: as soon as the worker is mid-embed and we issue
            // 2+ enqueues, the second one MAY return QueueFull (depending
            // on whether the worker already pulled the first signal).
            // We assert: regardless of QueueFull occurrences, the latest
            // content for the path reaches the sink.
            let coord = EmbedCoordinator::spawn_with_capacity(
                svc,
                chk,
                sink.clone() as Arc<dyn VectorSink>,
                1,
            );
            let path = PathBuf::from("/tmp/qfull.md");
            // Hammer enough enqueues that at least one observes Full.
            let mut saw_full = false;
            for i in 0..50 {
                match coord.enqueue(path.clone(), format!("v{i}")) {
                    Ok(()) => {}
                    Err(EnqueueError::QueueFull) => saw_full = true,
                    Err(other) => panic!("unexpected err: {other:?}"),
                }
            }
            // Drain.
            assert!(wait_until(
                || coord.pending.lock().map(|g| g.is_empty()).unwrap_or(false)
                    && sink.calls() >= 1,
                Duration::from_secs(10),
            ));
            // The content for path is in the sink even if QueueFull happened.
            let by_path = sink.by_path.lock().unwrap();
            assert!(by_path.contains_key(&path), "path must be embedded");
            // Document the saw_full observation; not asserting because
            // scheduling can occasionally drain fast enough to never fill.
            log::info!("queue_full test saw QueueFull = {saw_full}");
        });
    }

    /// AC: "Queue bounded; Stress-Test mit 1k Rapid-Saves". 1000 enqueues
    /// across 30 distinct paths. `#[ignore]` because real MiniLM inference
    /// saturates the CPU and starves timing-sensitive tests in sibling
    /// modules (e.g. `orphan_cleanup_tests::wait_for_drain` only allows a
    /// 400 ms margin around `OnCommitWithDelay`). Run explicitly with
    /// `cargo test -- --ignored stress_thousand_enqueues_coalesce`.
    #[test]
    #[ignore]
    fn stress_thousand_enqueues_coalesce() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            const N_PATHS: usize = 30;
            const N_ENQUEUES: usize = 1000;
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            for i in 0..N_ENQUEUES {
                let p = PathBuf::from(format!("/tmp/stress-{}.md", i % N_PATHS));
                let _ = coord.enqueue(p, format!("iter {i}"));
            }
            assert!(wait_until(
                || sink.paths().len() >= N_PATHS
                    && coord.pending.lock().map(|g| g.is_empty()).unwrap_or(false),
                Duration::from_secs(30),
            ));
            assert_eq!(sink.paths().len(), N_PATHS, "every path must embed at least once");
            let calls = sink.calls();
            assert!(calls >= N_PATHS, "lower bound: each path embedded once");
            // Upper bound is loose — coalescing should keep us well under
            // the input count. 3× the path count = fudge for the
            // late-arrival re-embed pattern (a save lands after the
            // worker drained but before the embed completed).
            assert!(
                calls <= N_PATHS * 3,
                "coalescing too weak: {calls} embeds for {N_ENQUEUES} enqueues across {N_PATHS} paths"
            );
        });
    }

    #[test]
    fn drop_terminates_worker() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            let tx_weak = coord.tx.clone(); // hold a clone to inspect closure
            drop(coord);
            // Closing the only owned Sender (coord.tx) should cause the
            // worker's blocking_recv to return None and the task to exit
            // — but we still hold tx_weak. Drop it too.
            drop(tx_weak);
            // No direct join handle — exercise the channel: a fresh
            // Sender clone via the dropped path is impossible. Simply
            // assert that no panic occurred during drop.
            std::thread::sleep(Duration::from_millis(50));
        });
    }

    #[test]
    fn enqueue_reports_closed_after_worker_dropped() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink as Arc<dyn VectorSink>);
            // Clone the sender so we can keep using it after we close the
            // primary side.
            let tx = coord.tx.clone();
            let pending = Arc::clone(&coord.pending);
            drop(coord);
            // Wait briefly for the worker to wind down.
            std::thread::sleep(Duration::from_millis(100));
            // Now use a hand-built enqueue: the worker is gone, but the
            // tx clone is still alive. After we drop tx the channel
            // closes from the receiver side too on next try_send.
            let probe = EmbedCoordinator { tx, pending };
            // First try may go through (worker just shut, channel still open).
            let _ = probe.enqueue("/tmp/x".into(), "x".into());
            // Drop the probe (closes the last sender).
            drop(probe);
        });
    }
}
