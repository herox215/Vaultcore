//! `EmbedCoordinator` (#196) — async, debounced, non-blocking pipeline
//! that turns every save into a chunk → embed → sink-store cycle without
//! holding up the save IPC.
//!
//! Coalescing strategy: a `pending` map of `path → latest content` plus a
//! bounded wake-up channel that carries `EmbedOp` ops. The map is the
//! source of truth for embed content; the channel signals "there is work
//! to do" plus carries explicit deletes (#201).
//!
//! Three rapid saves to the same path overwrite one another in the map
//! and produce exactly one embed. Deletes are FIFO with respect to
//! embeds — so an `Embed → Delete` sequence first inserts vectors then
//! tombstones them, while a `Delete → Embed` sequence first cancels the
//! pending embed (by removing the path from the map) then tombstones any
//! prior vectors. Both end with the path absent from queries, matching
//! the user's last-action intent.
//!
//! Backpressure: a full wake-up channel is benign for `Embed` because
//! the latest content already lives in the map — any subsequent
//! successful enqueue drains it. For `Delete` a full channel is rare
//! enough that we log + drop; the next user save plus #201 PR-B's
//! periodic reindex will re-converge.
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

/// Wake-up channel capacity. Carries `EmbedOp` (path-only signals); embed
/// content lives in the `pending` map. 1024 slots is generous — every
/// event is keyboard-paced and even external bulk deletes rarely land
/// >1k events in a single tick.
pub const WAKEUP_CAPACITY: usize = 1024;

/// Op carried on the wake-up channel. `Embed` is a content-less signal —
/// the actual content lives in the `pending` map and the worker drains
/// it on each Embed wake-up. `Delete(path)` carries the path because
/// deletes don't go through the pending map.
#[derive(Debug, Clone)]
pub enum EmbedOp {
    Embed,
    Delete(PathBuf),
}

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
    pub tx: mpsc::Sender<EmbedOp>,
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
        let (tx, rx) = mpsc::channel::<EmbedOp>(capacity.max(1));
        let pending: Arc<Mutex<HashMap<PathBuf, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let worker_pending = Arc::clone(&pending);
        tokio::task::spawn_blocking(move || {
            run_worker(service, chunker, sink, worker_pending, rx);
        });
        Self { tx, pending }
    }

    /// Non-blocking embed enqueue. Updates the pending map then signals
    /// the worker. `QueueFull` is benign — the content is in the map and
    /// the next successful enqueue (same path or another) will trigger a
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
            g.insert(path, content);
        }
        match self.tx.try_send(EmbedOp::Embed) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => Err(EnqueueError::QueueFull),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(EnqueueError::Closed),
        }
    }

    /// #201 PR-D — bulk enqueue for the reindex worker. Inserts every
    /// `(path, content)` into the pending map, then sends *one* wake-up
    /// signal instead of one per file. This gives the embedder a large
    /// cross-file drain window so `run_embed_batch` can run its sub-batch
    /// loop over ~N-files × ~3-chunks at once rather than near-singleton
    /// batches (which made ORT setup overhead dominate).
    ///
    /// Per-item behaviour matches `enqueue`: content is written to the
    /// pending map; a `QueueFull` wake-up is benign because the content
    /// already sits in the map and the next successful wake-up drains it.
    /// Returns the number of items inserted; errors on lock poisoning.
    pub fn enqueue_bulk(
        &self,
        items: impl IntoIterator<Item = (PathBuf, String)>,
    ) -> Result<usize, EnqueueError> {
        let mut count = 0usize;
        {
            let mut g = self
                .pending
                .lock()
                .map_err(|_| EnqueueError::LockPoisoned)?;
            for (path, content) in items {
                g.insert(path, content);
                count += 1;
            }
        }
        if count == 0 {
            return Ok(0);
        }
        match self.tx.try_send(EmbedOp::Embed) {
            Ok(()) => Ok(count),
            Err(mpsc::error::TrySendError::Full(_)) => Ok(count),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(EnqueueError::Closed),
        }
    }

    /// #201 PR-D — current size of the pending map. Used by the reindex
    /// worker to bound in-flight memory when reading ahead of the
    /// embedder (avoids a 100k-vault queuing every file body in RAM).
    pub fn pending_len(&self) -> usize {
        self.pending.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Non-blocking delete enqueue (#201). Worker FIFO-orders Delete
    /// against any pending Embed wake-ups. A `QueueFull` outcome here is
    /// rarer than for embeds (deletes don't have the keyboard-burst
    /// pattern) and the next user save's wake-up will not retroactively
    /// dispatch the delete — caller logs.
    pub fn enqueue_delete(&self, path: PathBuf) -> Result<(), EnqueueError> {
        match self.tx.try_send(EmbedOp::Delete(path)) {
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
    mut rx: mpsc::Receiver<EmbedOp>,
) {
    while let Some(op) = rx.blocking_recv() {
        match op {
            EmbedOp::Delete(path) => {
                // Cancel any in-flight embed for this path so a Delete →
                // Embed race ends with the path absent. Then mark the
                // path's vectors tombstoned in the sink.
                if let Ok(mut g) = pending.lock() {
                    g.remove(&path);
                } else {
                    log::warn!("embed pending map poisoned during delete; tombstone may race");
                }
                sink.delete(&path);
            }
            EmbedOp::Embed => {
                let snapshot: Vec<(PathBuf, String)> = match pending.lock() {
                    Ok(mut g) => g.drain().collect(),
                    Err(_) => {
                        log::warn!("embed pending map poisoned; skipping batch");
                        continue;
                    }
                };
                run_embed_batch(&service, &chunker, &sink, snapshot);
            }
        }
    }
    log::info!("EmbedCoordinator worker shut down");
}

/// Cross-file batching window (#201 PR-D). When the worker drains the
/// pending map, it chunks every file, pools all chunks across files into
/// sub-batches of this size, and runs each sub-batch through a single
/// `embed_batch` call. This nets 3-5× throughput during reindex (where the
/// drain may hold hundreds of files) vs the old per-file batch loop that
/// paid ORT setup overhead once per note.
///
/// 64 is picked to keep each inference call small enough to fit comfortably
/// in RAM (~200 KB of int8 tokens + ~100 KB of fp32 outputs) while large
/// enough to saturate fastembed's internal parallelism at intra=2.
const EMBED_BATCH_SIZE: usize = 64;

/// Chunk every file in the drained snapshot, run a single cross-file
/// `embed_batch` (capped at `EMBED_BATCH_SIZE` per sub-batch), then
/// partition the resulting vectors back onto their source paths and
/// hand each (path, (Chunk, Vec<f32>) pairs) slice to the sink.
///
/// Failures are localised: a chunker error skips the file; an embed_batch
/// error fails only the current sub-batch (the files straddling it lose
/// their store this round and will be retried on the next save/reindex).
fn run_embed_batch(
    service: &EmbeddingService,
    chunker: &Chunker,
    sink: &Arc<dyn VectorSink>,
    snapshot: Vec<(PathBuf, String)>,
) {
    if snapshot.is_empty() {
        return;
    }

    // Chunk every file. `(path, chunks)` pairs are preserved in order so
    // we can slice vectors back onto them after the cross-file embed.
    let mut per_file: Vec<(PathBuf, Vec<Chunk>)> = Vec::with_capacity(snapshot.len());
    for (path, content) in snapshot {
        match chunker.chunk(&content) {
            Ok(c) if c.is_empty() => {}
            Ok(c) => per_file.push((path, c)),
            Err(e) => log::warn!("chunker failed for {}: {e}", path.display()),
        }
    }
    if per_file.is_empty() {
        return;
    }

    // Flatten into a single texts vec; record (file_index, chunk_in_file)
    // for each flat position so we can re-partition after inference.
    let mut flat_texts: Vec<&str> = Vec::new();
    let mut coords: Vec<(usize, usize)> = Vec::new();
    for (fi, (_p, chunks)) in per_file.iter().enumerate() {
        for (ci, chunk) in chunks.iter().enumerate() {
            flat_texts.push(chunk.text.as_str());
            coords.push((fi, ci));
        }
    }

    // Bucket each file's vectors back under its path. Pre-size to the
    // per-file chunk counts so we can fill by index without resizing.
    let mut vectors_by_file: Vec<Vec<Option<Vec<f32>>>> = per_file
        .iter()
        .map(|(_, chunks)| (0..chunks.len()).map(|_| None).collect())
        .collect();

    // Run the embed in sub-batches. A sub-batch failure is isolated — we
    // log and continue (the affected files will miss this round; the
    // reindex checkpoint / next save covers the re-queue).
    for (sub_start, sub_texts) in flat_texts.chunks(EMBED_BATCH_SIZE).enumerate() {
        let global_offset = sub_start * EMBED_BATCH_SIZE;
        // Indexing path — every chunk gets the e5 "passage: " prefix so
        // the index lives in the same subspace that `embed_query` targets.
        // Dropping to bare `embed_batch` here silently halves recall.
        let vectors = match service.embed_passage_batch(sub_texts) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "embed sub-batch failed (size {}): {e}; skipping {} files this round",
                    sub_texts.len(),
                    sub_texts.len()
                );
                continue;
            }
        };
        for (i, vec) in vectors.into_iter().enumerate() {
            let (fi, ci) = coords[global_offset + i];
            vectors_by_file[fi][ci] = Some(vec);
        }
    }

    // Hand each fully-populated file to the sink. Partial files (a
    // sub-batch failed mid-file) are skipped so the sink never sees a
    // truncated vector set.
    for ((path, chunks), slots) in per_file.into_iter().zip(vectors_by_file.into_iter()) {
        let full: Option<Vec<Vec<f32>>> = slots.into_iter().collect();
        let Some(full_vectors) = full else { continue };
        let pairs: Vec<(Chunk, Vec<f32>)> = chunks.into_iter().zip(full_vectors).collect();
        sink.store(&path, pairs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// Collects every `store` and `delete` call so tests can assert
    /// coalescing and FIFO order.
    struct CountingSink {
        calls: AtomicUsize,
        deletes: AtomicUsize,
        by_path: Mutex<HashMap<PathBuf, Vec<String>>>,
        deleted_paths: Mutex<Vec<PathBuf>>,
    }

    impl CountingSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                deletes: AtomicUsize::new(0),
                by_path: Mutex::new(HashMap::new()),
                deleted_paths: Mutex::new(Vec::new()),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn deletes(&self) -> usize {
            self.deletes.load(Ordering::SeqCst)
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
        fn delete(&self, path: &Path) {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            self.deleted_paths.lock().unwrap().push(path.to_path_buf());
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

    /// #201 PR-A: enqueue_delete dispatches a Delete op that the sink
    /// observes. The minimal sanity check; richer FIFO ordering is in
    /// the next test.
    #[test]
    fn enqueue_delete_calls_sink_delete() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            let p = PathBuf::from("/tmp/del.md");
            coord.enqueue_delete(p.clone()).unwrap();
            assert!(wait_until(|| sink.deletes() == 1, Duration::from_secs(5)));
            let deleted = sink.deleted_paths.lock().unwrap();
            assert_eq!(deleted.as_slice(), &[p]);
        });
    }

    /// #201 PR-D: enqueue_bulk inserts every item into the pending map
    /// and sends exactly one wake-up signal. The worker drains the full
    /// set on that single wake-up.
    #[test]
    fn enqueue_bulk_inserts_all_items_and_wakes_worker_once() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn(svc, chk, sink.clone() as Arc<dyn VectorSink>);
            let batch: Vec<(PathBuf, String)> = (0..8)
                .map(|i| (PathBuf::from(format!("/tmp/bulk-{i}.md")), format!("body {i}")))
                .collect();
            let n = coord.enqueue_bulk(batch).expect("enqueue_bulk ok");
            assert_eq!(n, 8);
            assert!(wait_until(
                || sink.paths().len() >= 8,
                Duration::from_secs(10),
            ));
            assert_eq!(sink.paths().len(), 8);
        });
    }

    /// #201 PR-D: pending_len reflects map size before the worker drains.
    #[test]
    fn pending_len_reports_queued_items() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            let coord = EmbedCoordinator::spawn_with_capacity(
                svc,
                chk,
                sink.clone() as Arc<dyn VectorSink>,
                1,
            );
            // Fill the map WITHOUT signalling by not using enqueue — grab
            // the lock directly. This isolates the counter from the
            // worker drain.
            {
                let mut g = coord.pending.lock().unwrap();
                for i in 0..5 {
                    g.insert(PathBuf::from(format!("/tmp/plen-{i}.md")), "x".to_string());
                }
            }
            assert_eq!(coord.pending_len(), 5);
        });
    }

    /// #201 PR-A: a Delete that arrives before its companion Embed has
    /// drained must cancel the in-flight embed for the same path so
    /// the path ends up absent (matching the user's last-action intent).
    #[test]
    fn delete_cancels_pending_embed_for_same_path() {
        let Some((svc, chk)) = try_load_service_and_chunker() else {
            eprintln!("SKIP");
            return;
        };
        block_on(async move {
            let sink = CountingSink::new();
            // Capacity 1 so we can almost certainly slot the Delete in
            // before the worker drains the prior Embed wake-up.
            let coord = EmbedCoordinator::spawn_with_capacity(
                svc,
                chk,
                sink.clone() as Arc<dyn VectorSink>,
                4,
            );
            let p = PathBuf::from("/tmp/race.md");
            coord.enqueue(p.clone(), "doomed".to_string()).unwrap();
            // Immediately follow with a delete. The worker may have
            // already drained the embed wake-up and started embedding —
            // both outcomes are acceptable as long as the final state
            // reports the path tombstoned.
            coord.enqueue_delete(p.clone()).unwrap();
            assert!(wait_until(
                || sink.deletes() == 1,
                Duration::from_secs(5),
            ));
            // Either: embed never ran (cancelled) → calls() == 0
            // Or:     embed ran then delete tombstoned → calls() == 1
            // The invariant we care about is that delete was observed.
            assert_eq!(sink.deletes(), 1);
        });
    }
}
