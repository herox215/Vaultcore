//! `VectorSink` — where embedded chunk vectors land. Defined as a trait so
//! the embed-on-save coordinator (#196) can ship today against a no-op,
//! and #198's HNSW-backed implementation can drop in later without
//! touching the queue.
//!
//! Lifecycle contract: callers invoke `store(path, ...)` once per
//! coalesced save. The sink replaces any prior vectors associated with
//! `path` (upsert semantics). `delete(path)` (#201) is the explicit hook
//! for rename/delete dispatch — `store` already implies "drop prior
//! vectors then insert", but `delete` skips the embed work entirely.

use std::path::Path;
#[cfg(feature = "embeddings")]
use std::path::PathBuf;
#[cfg(feature = "embeddings")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "embeddings")]
use std::sync::{Arc, RwLock};

use super::Chunk;
#[cfg(feature = "embeddings")]
use super::VectorIndex;

pub trait VectorSink: Send + Sync {
    fn store(&self, path: &Path, chunks_with_vectors: Vec<(Chunk, Vec<f32>)>);
    /// Drop every vector associated with `path`. Default is a no-op so
    /// callers built before #201 (e.g. `NoopSink`) still compile without
    /// per-impl boilerplate.
    fn delete(&self, _path: &Path) {}
}

/// Discards everything. Used while #198 was pending and still useful for
/// tests that want to exercise the coordinator without an HNSW dep.
pub struct NoopSink;

impl VectorSink for NoopSink {
    fn store(&self, _path: &Path, _chunks_with_vectors: Vec<(Chunk, Vec<f32>)>) {}
}

/// `HnswSink` (#201 PR-A) — production sink backed by an in-memory
/// `VectorIndex` plus on-disk persistence under
/// `<vault>/.vaultcore/embeddings/`. Every embedded save replaces prior
/// vectors for the path; explicit `delete` tombstones them; compaction
/// fires off-thread when the index crosses #200's gating thresholds.
///
/// Concurrency: the inner index is held as `Arc<RwLock<Arc<VectorIndex>>>`
/// so reads (queries) take a brief read lock to clone the inner `Arc`
/// and then operate lock-free against that snapshot. Writes (compaction)
/// take the write lock once to swap in a fresh index. Stores and deletes
/// only need a read lock + the snapshot's own internal locks.
///
/// Drop semantics: the sink saves to disk on `Drop`, on a detached
/// background thread so vault switch / app close doesn't freeze the UI
/// for the seconds it takes to dump 100k vectors. The trade-off is that
/// a save in flight when the OS reaps the process is incomplete; the
/// next launch falls back to `load_or_empty` and the lost embeddings
/// will be re-emitted on next save (or by the #201 PR-B reindex worker).
#[cfg(feature = "embeddings")]
pub struct HnswSink {
    index: Arc<RwLock<Arc<VectorIndex>>>,
    save_dir: PathBuf,
    /// CAS guard against starting a second compaction while one is in
    /// flight. Set to `true` by the thread that wins the race; cleared
    /// when the compaction finishes (and self-checks one more time).
    compacting: Arc<AtomicBool>,
}

#[cfg(feature = "embeddings")]
impl HnswSink {
    /// Open or create the on-disk vector index at `save_dir`. Falls back
    /// to an empty index on missing/corrupt files (#199 AC #3).
    pub fn open(save_dir: PathBuf, capacity_hint: usize) -> Self {
        let _ = std::fs::create_dir_all(&save_dir);
        let index = VectorIndex::load_or_empty(&save_dir, capacity_hint);
        Self {
            index: Arc::new(RwLock::new(Arc::new(index))),
            save_dir,
            compacting: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Take a cheap snapshot of the inner index. Read-only callers
    /// (queries, save-on-Drop) use this to avoid holding the outer
    /// `RwLock` for the duration of work.
    pub fn snapshot(&self) -> Arc<VectorIndex> {
        Arc::clone(&self.index.read().expect("index lock"))
    }

    /// Persist the current snapshot synchronously. Used by tests and the
    /// future periodic-flush path (#201 PR-B).
    pub fn save_now(&self) -> Result<(), super::EmbeddingError> {
        self.snapshot().save(&self.save_dir)
    }

    fn maybe_compact(&self) {
        let snap = self.snapshot();
        if !snap.should_compact() {
            return;
        }
        if self
            .compacting
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let index_lock = Arc::clone(&self.index);
        let compacting = Arc::clone(&self.compacting);
        std::thread::spawn(move || {
            match snap.compact_into_fresh() {
                Ok(fresh) => {
                    let fresh_arc = Arc::new(fresh);
                    if let Ok(mut guard) = index_lock.write() {
                        let live = fresh_arc.live_len();
                        *guard = fresh_arc;
                        log::info!("VectorIndex compacted; live={live}");
                    }
                }
                Err(e) => log::warn!("compaction failed: {e}"),
            }
            compacting.store(false, Ordering::Release);
            // Trailing self-check: if more deletes piled up while we
            // were rebuilding, the next sink.delete() call won't always
            // observe should_compact() as true (it might if more
            // deletes landed). Probe once here so a steady delete
            // stream doesn't have to wait for a fresh user save to
            // notice.
            if let Ok(g) = index_lock.read() {
                if g.should_compact() {
                    log::info!("VectorIndex still over compaction threshold post-rebuild");
                }
            }
        });
    }
}

#[cfg(feature = "embeddings")]
impl VectorSink for HnswSink {
    fn store(&self, path: &Path, chunks_with_vectors: Vec<(Chunk, Vec<f32>)>) {
        if chunks_with_vectors.is_empty() {
            return;
        }
        let snap = self.snapshot();
        snap.mark_deleted(path);
        let items: Vec<(PathBuf, usize, Vec<f32>)> = chunks_with_vectors
            .into_iter()
            .enumerate()
            .map(|(i, (_chunk, v))| (path.to_path_buf(), i, v))
            .collect();
        snap.bulk_insert(items);
        self.maybe_compact();
    }

    fn delete(&self, path: &Path) {
        let snap = self.snapshot();
        if snap.mark_deleted(path) > 0 {
            self.maybe_compact();
        }
    }
}

#[cfg(feature = "embeddings")]
impl Drop for HnswSink {
    fn drop(&mut self) {
        let snap = self.snapshot();
        let dir = self.save_dir.clone();
        std::thread::spawn(move || {
            if let Err(e) = snap.save(&dir) {
                log::warn!("HnswSink save on drop failed: {e}");
            }
        });
    }
}

#[cfg(all(test, feature = "embeddings"))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn unit_vec(seed: u64) -> Vec<f32> {
        let mut s = seed.wrapping_mul(0x9E3779B97F4A7C15);
        let mut out = Vec::with_capacity(384);
        for _ in 0..384 {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let bits = (s >> 32) as u32;
            let f = (bits as f32 / u32::MAX as f32) * 2.0 - 1.0;
            out.push(f);
        }
        let n: f32 = out.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in &mut out {
            *x /= n;
        }
        out
    }

    fn pair(seed: u64) -> (Chunk, Vec<f32>) {
        (
            Chunk {
                text: format!("seed-{seed}"),
                byte_offset: 0,
            },
            unit_vec(seed),
        )
    }

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
    fn store_then_query_finds_vector() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = HnswSink::open(tmp.path().to_path_buf(), 8);
        let path = PathBuf::from("a.md");
        sink.store(&path, vec![pair(1)]);

        let snap = sink.snapshot();
        let hits = snap.query_with_paths(&unit_vec(1), 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, path);
    }

    #[test]
    fn store_replaces_prior_vectors_for_same_path() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = HnswSink::open(tmp.path().to_path_buf(), 8);
        let path = PathBuf::from("dup.md");
        sink.store(&path, vec![pair(1), pair(2)]);
        sink.store(&path, vec![pair(3)]);

        let snap = sink.snapshot();
        // Old chunks tombstoned, only seed-3 remains live.
        assert_eq!(snap.live_len(), 1);
        // Query for the old vectors must not return them.
        let hits = snap.query_with_paths(&unit_vec(1), 5);
        assert!(hits.iter().all(|(_, _, d)| *d > 0.01),
            "old chunk should not be a near-zero hit, got {hits:?}");
    }

    #[test]
    fn delete_marks_path_tombstoned() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = HnswSink::open(tmp.path().to_path_buf(), 8);
        let p = PathBuf::from("gone.md");
        sink.store(&p, vec![pair(7)]);
        sink.delete(&p);

        let snap = sink.snapshot();
        assert_eq!(snap.live_len(), 0);
        assert_eq!(snap.tombstone_count(), 1);
        let hits = snap.query_with_paths(&unit_vec(7), 5);
        assert!(hits.iter().all(|(path, _, _)| path != &p));
    }

    #[test]
    fn delete_on_unknown_path_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = HnswSink::open(tmp.path().to_path_buf(), 8);
        sink.delete(Path::new("never-stored.md"));
        assert_eq!(sink.snapshot().len(), 0);
    }

    #[test]
    fn save_on_drop_persists_then_reloads() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        {
            let sink = HnswSink::open(dir.clone(), 8);
            sink.store(&PathBuf::from("persisted.md"), vec![pair(42)]);
            // Sink dropped here — Drop spawns a save thread.
        }
        // Wait for the save file to appear.
        let mapping = dir.join("vectors.mapping.json");
        assert!(
            wait_until(|| mapping.exists(), Duration::from_secs(5)),
            "save-on-Drop never wrote {}",
            mapping.display(),
        );
        // Wait briefly for the data dump to finish too — file_dump writes
        // graph + data + mapping in sequence, and our preflight check
        // requires both binary files present.
        let data = dir.join("vectors.hnsw.data");
        assert!(wait_until(|| data.exists(), Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(50));

        let reopened = HnswSink::open(dir, 8);
        let snap = reopened.snapshot();
        assert_eq!(snap.len(), 1);
        let hits = snap.query_with_paths(&unit_vec(42), 1);
        assert_eq!(hits[0].0, PathBuf::from("persisted.md"));
    }

    #[test]
    fn compaction_runs_when_threshold_crossed_and_keeps_index_queryable() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = HnswSink::open(tmp.path().to_path_buf(), 400);
        // Cross both gates: >64 tombstones AND >20% ratio.
        // 400 inserts, 100 deletes = 25%.
        for i in 0..400u64 {
            sink.store(&PathBuf::from(format!("c-{i}.md")), vec![pair(i)]);
        }
        for i in 0..100u64 {
            sink.delete(&PathBuf::from(format!("c-{i}.md")));
        }
        // After the last delete, maybe_compact() spawns a thread.
        // Wait for the rebuild to swap in a fresh index (live_len == 300,
        // tombstones cleared).
        let ok = wait_until(
            || {
                let s = sink.snapshot();
                s.tombstone_count() == 0 && s.len() == 300
            },
            Duration::from_secs(15),
        );
        assert!(
            ok,
            "compaction never landed: live={}, tombs={}, total={}",
            sink.snapshot().live_len(),
            sink.snapshot().tombstone_count(),
            sink.snapshot().len()
        );
        // A surviving path is still queryable.
        let hits = sink.snapshot().query_with_paths(&unit_vec(200), 1);
        assert_eq!(hits[0].0, PathBuf::from("c-200.md"));
    }
}
