//! `reindex` (#201 PR-B) — resumable initial-embed worker.
//!
//! The embed-on-save coordinator (#196) only touches files the user edits
//! in the current session. For a vault that's been around since before
//! Semantic Search was enabled, we need a one-shot pass that walks every
//! `.md` file, hashes it, and enqueues stale/new files through the same
//! `EmbedCoordinator` pipeline as live edits. Unchanged files are
//! short-circuited by a content-hash checkpoint so a mid-reindex crash /
//! relaunch continues where it left off instead of redoing 40k files.
//!
//! ## Worker shape
//!
//! - Dedicated `std::thread` (not `tokio::spawn_blocking`) — walking,
//!   hashing and the checkpoint flush are blocking I/O, and we don't
//!   need a runtime in here because the `enqueue` callback handed in by
//!   the caller is synchronous (it just wraps `EmbedCoordinator::enqueue`,
//!   which already does a `try_send`).
//! - `Arc<AtomicBool>` cancel flag polled between files — a 100k-reindex
//!   must surrender within one file's worth of work (≤ a few ms).
//! - `ReindexProgress` events are invoked via a caller-provided closure;
//!   production wiring bridges that to a Tauri `embed://reindex_progress`
//!   event (the IPC layer, not this module, holds the AppHandle).
//!
//! ## Checkpoint shape
//!
//! A single JSON file under `<vault>/.vaultcore/embeddings/`:
//!
//! ```json
//! { "version": 1, "entries": { "folder/note.md": "<sha256hex>", ... } }
//! ```
//!
//! Keys are vault-relative paths with forward slashes so the checkpoint
//! survives a vault rename on the same OS. Values are the sha256 hex of
//! the file bytes at the last successful enqueue. Flushed every
//! `FLUSH_EVERY` enqueues and once more on exit (cancel or done) so the
//! worst-case re-work after a crash is ~100 files.
//!
//! A corrupt or version-mismatched checkpoint is treated as "no prior
//! progress" (logged at warn level, no hard failure). Concretely: a JSON
//! parse error, a missing `version`, or `version != CHECKPOINT_VERSION`
//! all yield a fresh empty checkpoint, and the full reindex runs. That
//! keeps the feature robust across upgrades without a migration path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

use crate::hash::hash_bytes;

/// Filename of the checkpoint JSON under `<vault>/.vaultcore/embeddings/`.
pub const CHECKPOINT_FILE: &str = "reindex.checkpoint.json";
/// Current on-disk layout version. Bumped when the schema changes in a
/// breaking way; older versions load as empty (force full re-walk).
pub const CHECKPOINT_VERSION: u32 = 1;
/// Flush cadence: every N successful enqueues we atomically write the
/// checkpoint. Trades worst-case re-work (≤ N files) against disk churn.
const FLUSH_EVERY: usize = 100;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReindexPhase {
    /// Enumerating `.md` files under the vault root.
    Scan,
    /// Hashing + enqueuing stale files.
    Index,
    /// Worker exited normally, every file processed.
    Done,
    /// Worker exited due to a user cancel; checkpoint was flushed.
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReindexProgress {
    /// Files processed (hashed) so far.
    pub done: usize,
    /// Total files discovered during scan. Zero while `phase == Scan`.
    pub total: usize,
    /// Subset of `done` that matched checkpoint hash — no enqueue.
    pub skipped: usize,
    /// Subset of `done` that was actually enqueued for embedding.
    pub embedded: usize,
    pub phase: ReindexPhase,
    /// Linearly-extrapolated seconds remaining. `None` while scanning or
    /// when the worker is idle (done == 0 or total - done == 0).
    pub eta_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CheckpointFile {
    version: u32,
    /// vault-relative forward-slash path → sha256 hex of file bytes
    entries: HashMap<String, String>,
}

impl Default for CheckpointFile {
    fn default() -> Self {
        Self { version: CHECKPOINT_VERSION, entries: HashMap::new() }
    }
}

/// Cancellation + join handle for a running reindex. Returned by
/// [`start_reindex`] and typically parked in `VaultState` so a second
/// reindex request cancels the first before spawning.
pub struct ReindexHandle {
    cancel: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl ReindexHandle {
    /// Set the cancel flag. The worker polls it between files; callers
    /// that want to block until the worker exits should follow with
    /// [`join`](Self::join).
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    /// Wait for the worker thread to exit. Safe to call multiple times;
    /// subsequent calls are a no-op.
    pub fn join(&self) {
        if let Some(h) = self.join.lock().expect("reindex join lock").take() {
            let _ = h.join();
        }
    }

    /// Convenience: cancel then join. Used on vault switch so the old
    /// worker doesn't keep mutating the freshly-replaced coordinator.
    pub fn cancel_and_join(&self) {
        self.cancel();
        self.join();
    }
}

/// Spawn the reindex worker. The returned handle holds the cancel flag
/// and the thread join; drop it without joining to detach, or call
/// `cancel_and_join` for cooperative shutdown.
///
/// - `enqueue(path, content) -> bool`: invoked for every file whose hash
///   differs from the checkpoint. The closure must be non-blocking
///   (wraps `EmbedCoordinator::enqueue`). Returns `true` iff the content
///   landed — the checkpoint is only updated on `true`, so a transient
///   `Closed` result will be retried on the next reindex.
/// - `on_progress(ReindexProgress)`: invoked on every phase change and
///   after every file. Production wiring emits a Tauri event; tests
///   push into a Mutex<Vec<_>>.
pub fn start_reindex<F, P>(
    vault_root: PathBuf,
    checkpoint_dir: PathBuf,
    enqueue: F,
    on_progress: P,
) -> Arc<ReindexHandle>
where
    F: Fn(&Path, String) -> bool + Send + Sync + 'static,
    P: Fn(ReindexProgress) + Send + Sync + 'static,
{
    let cancel = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(ReindexHandle {
        cancel: Arc::clone(&cancel),
        join: Mutex::new(None),
    });

    let join = std::thread::Builder::new()
        .name("vc-reindex".into())
        .spawn(move || {
            run(vault_root, checkpoint_dir, cancel, enqueue, on_progress);
        })
        .expect("spawn reindex thread");

    *handle.join.lock().expect("reindex join lock") = Some(join);
    handle
}

fn run<F, P>(
    vault_root: PathBuf,
    checkpoint_dir: PathBuf,
    cancel: Arc<AtomicBool>,
    enqueue: F,
    on_progress: P,
) where
    F: Fn(&Path, String) -> bool,
    P: Fn(ReindexProgress),
{
    let _ = std::fs::create_dir_all(&checkpoint_dir);
    let checkpoint_path = checkpoint_dir.join(CHECKPOINT_FILE);
    let mut checkpoint = load_checkpoint(&checkpoint_path);

    on_progress(ReindexProgress {
        done: 0,
        total: 0,
        skipped: 0,
        embedded: 0,
        phase: ReindexPhase::Scan,
        eta_seconds: None,
    });

    let files: Vec<PathBuf> = WalkDir::new(&vault_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e))
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    let total = files.len();

    let started = Instant::now();
    let mut done = 0usize;
    let mut skipped = 0usize;
    let mut embedded = 0usize;
    let mut since_flush = 0usize;

    // Initial Index emission so the frontend can swap the statusbar from
    // "Scanning" to "0 / total" before the first file completes.
    on_progress(ReindexProgress {
        done: 0,
        total,
        skipped: 0,
        embedded: 0,
        phase: ReindexPhase::Index,
        eta_seconds: None,
    });

    for abs in files {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        let rel_key = rel_key(&vault_root, &abs);
        let (did_skip, did_embed) = process_file(&abs, &rel_key, &mut checkpoint, &enqueue);
        if did_skip {
            skipped += 1;
        }
        if did_embed {
            embedded += 1;
            since_flush += 1;
        }
        done += 1;

        emit_progress(&on_progress, done, total, skipped, embedded, started);

        if since_flush >= FLUSH_EVERY {
            if let Err(e) = save_checkpoint(&checkpoint_path, &checkpoint) {
                log::warn!("reindex: checkpoint flush failed: {e}");
            }
            since_flush = 0;
        }
    }

    if let Err(e) = save_checkpoint(&checkpoint_path, &checkpoint) {
        log::warn!("reindex: final checkpoint save failed: {e}");
    }

    let phase = if cancel.load(Ordering::Acquire) {
        ReindexPhase::Cancelled
    } else {
        ReindexPhase::Done
    };
    on_progress(ReindexProgress {
        done,
        total,
        skipped,
        embedded,
        phase,
        eta_seconds: None,
    });
}

/// Hash, compare, enqueue. Returns `(did_skip, did_embed)`. Exactly one
/// of the two is true when the file was readable; both false on read
/// error or non-UTF-8 content (we log and move on).
fn process_file<F>(
    abs: &Path,
    rel_key: &str,
    checkpoint: &mut CheckpointFile,
    enqueue: &F,
) -> (bool, bool)
where
    F: Fn(&Path, String) -> bool,
{
    let bytes = match std::fs::read(abs) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("reindex: read {} failed: {e}", abs.display());
            return (false, false);
        }
    };
    let hash = hash_bytes(&bytes);

    if checkpoint.entries.get(rel_key) == Some(&hash) {
        return (true, false);
    }

    let content = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("reindex: {} not utf-8 ({e}); skipping", abs.display());
            return (false, false);
        }
    };

    if enqueue(abs, content) {
        checkpoint.entries.insert(rel_key.to_string(), hash);
        (false, true)
    } else {
        (false, false)
    }
}

fn emit_progress<P: Fn(ReindexProgress)>(
    on_progress: &P,
    done: usize,
    total: usize,
    skipped: usize,
    embedded: usize,
    started: Instant,
) {
    let eta_seconds = if done > 0 && total > done {
        let elapsed = started.elapsed().as_secs_f64();
        let per = elapsed / done as f64;
        Some((per * (total - done) as f64) as u64)
    } else {
        None
    };
    on_progress(ReindexProgress {
        done,
        total,
        skipped,
        embedded,
        phase: ReindexPhase::Index,
        eta_seconds,
    });
}

fn rel_key(vault_root: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault_root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_excluded(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_str().unwrap_or("");
    entry.depth() > 0 && name.starts_with('.')
}

fn load_checkpoint(path: &Path) -> CheckpointFile {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return CheckpointFile::default(),
    };
    match serde_json::from_str::<CheckpointFile>(&raw) {
        Ok(c) if c.version == CHECKPOINT_VERSION => c,
        Ok(c) => {
            log::warn!(
                "reindex checkpoint version {} unsupported (expected {}); starting fresh",
                c.version,
                CHECKPOINT_VERSION
            );
            CheckpointFile::default()
        }
        Err(e) => {
            log::warn!("reindex checkpoint corrupt ({e}); starting fresh");
            CheckpointFile::default()
        }
    }
}

fn save_checkpoint(path: &Path, checkpoint: &CheckpointFile) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string(checkpoint)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    fn write_md(root: &Path, rel: &str, body: &str) -> PathBuf {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, body).unwrap();
        p
    }

    fn wait_until<F: Fn() -> bool>(cond: F, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        cond()
    }

    #[derive(Default)]
    struct Recorder {
        enqueued: Mutex<Vec<(PathBuf, String)>>,
        progress: Mutex<Vec<ReindexProgress>>,
    }

    impl Recorder {
        fn enqueued_paths(&self) -> Vec<PathBuf> {
            self.enqueued
                .lock()
                .unwrap()
                .iter()
                .map(|(p, _)| p.clone())
                .collect()
        }
        fn last_phase(&self) -> Option<ReindexPhase> {
            self.progress.lock().unwrap().last().map(|p| p.phase.clone())
        }
    }

    fn run_reindex_blocking(
        vault: &Path,
        ckpt_dir: &Path,
    ) -> (Arc<Recorder>, Arc<ReindexHandle>) {
        let rec = Arc::new(Recorder::default());
        let enqueue_rec = Arc::clone(&rec);
        let progress_rec = Arc::clone(&rec);
        let handle = start_reindex(
            vault.to_path_buf(),
            ckpt_dir.to_path_buf(),
            move |path, content| {
                enqueue_rec
                    .enqueued
                    .lock()
                    .unwrap()
                    .push((path.to_path_buf(), content));
                true
            },
            move |p| progress_rec.progress.lock().unwrap().push(p),
        );
        handle.join();
        (rec, handle)
    }

    #[test]
    fn checkpoint_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(CHECKPOINT_FILE);
        let mut ckpt = CheckpointFile::default();
        ckpt.entries.insert("a/b.md".into(), "deadbeef".into());
        ckpt.entries.insert("c.md".into(), "cafebabe".into());
        save_checkpoint(&path, &ckpt).unwrap();

        let loaded = load_checkpoint(&path);
        assert_eq!(loaded.version, CHECKPOINT_VERSION);
        assert_eq!(loaded.entries.len(), 2);
        assert_eq!(loaded.entries.get("a/b.md").map(String::as_str), Some("deadbeef"));
    }

    #[test]
    fn corrupt_checkpoint_starts_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(CHECKPOINT_FILE);
        std::fs::write(&path, "this is not json {{{").unwrap();
        let loaded = load_checkpoint(&path);
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.version, CHECKPOINT_VERSION);
    }

    #[test]
    fn version_mismatch_starts_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(CHECKPOINT_FILE);
        std::fs::write(&path, r#"{"version":999,"entries":{"x.md":"h"}}"#).unwrap();
        let loaded = load_checkpoint(&path);
        assert!(loaded.entries.is_empty());
    }

    #[test]
    fn first_run_enqueues_every_md_file() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        write_md(vault.path(), "a.md", "note one");
        write_md(vault.path(), "sub/b.md", "note two");
        write_md(vault.path(), "sub/c.md", "note three");
        // Non-md: must be ignored.
        write_md(vault.path(), "ignored.txt", "not markdown");

        let (rec, _h) = run_reindex_blocking(vault.path(), ckpt.path());
        assert_eq!(rec.enqueued_paths().len(), 3);
        assert_eq!(rec.last_phase(), Some(ReindexPhase::Done));
    }

    #[test]
    fn skips_unchanged_files_on_second_run() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        write_md(vault.path(), "a.md", "stable");
        write_md(vault.path(), "b.md", "also stable");

        let (rec1, _) = run_reindex_blocking(vault.path(), ckpt.path());
        assert_eq!(rec1.enqueued_paths().len(), 2);

        let (rec2, _) = run_reindex_blocking(vault.path(), ckpt.path());
        assert_eq!(
            rec2.enqueued_paths().len(),
            0,
            "second run must not re-enqueue unchanged files"
        );
        // Last progress reports all files skipped.
        let last = rec2.progress.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.done, 2);
        assert_eq!(last.skipped, 2);
        assert_eq!(last.embedded, 0);
        assert_eq!(last.phase, ReindexPhase::Done);
    }

    #[test]
    fn re_enqueues_stale_file_when_hash_changes() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        let a = write_md(vault.path(), "a.md", "v1");
        write_md(vault.path(), "b.md", "unchanged");

        let (_rec1, _) = run_reindex_blocking(vault.path(), ckpt.path());

        // Modify a.md — hash changes, b.md stays pinned.
        std::fs::write(&a, "v2-totally-different").unwrap();

        let (rec2, _) = run_reindex_blocking(vault.path(), ckpt.path());
        let paths = rec2.enqueued_paths();
        assert_eq!(paths.len(), 1, "only the stale file re-enqueues, got {paths:?}");
        assert!(paths[0].ends_with("a.md"));
    }

    #[test]
    fn skips_dot_directories() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        write_md(vault.path(), "note.md", "real");
        write_md(vault.path(), ".vaultcore/ignored.md", "should be skipped");
        write_md(vault.path(), ".git/also.md", "also skipped");
        write_md(vault.path(), ".obsidian/cfg.md", "obsidian config");

        let (rec, _) = run_reindex_blocking(vault.path(), ckpt.path());
        let paths = rec.enqueued_paths();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("note.md"));
    }

    #[test]
    fn empty_vault_emits_done_with_zero_total() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        let (rec, _) = run_reindex_blocking(vault.path(), ckpt.path());
        assert_eq!(rec.enqueued_paths().len(), 0);
        let last = rec.progress.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.total, 0);
        assert_eq!(last.done, 0);
        assert_eq!(last.phase, ReindexPhase::Done);
    }

    #[test]
    fn cancellation_stops_worker_and_persists_progress() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        for i in 0..400 {
            write_md(vault.path(), &format!("n-{i:04}.md"), &format!("body {i}"));
        }

        let rec = Arc::new(Recorder::default());
        let enqueue_rec = Arc::clone(&rec);
        let progress_rec = Arc::clone(&rec);
        // Slow the enqueue so we can observe cancellation mid-stream.
        let handle = start_reindex(
            vault.path().to_path_buf(),
            ckpt.path().to_path_buf(),
            move |path, content| {
                std::thread::sleep(Duration::from_millis(2));
                enqueue_rec
                    .enqueued
                    .lock()
                    .unwrap()
                    .push((path.to_path_buf(), content));
                true
            },
            move |p| progress_rec.progress.lock().unwrap().push(p),
        );
        // Let it process a chunk then cancel.
        assert!(wait_until(
            || rec.enqueued.lock().unwrap().len() >= 20,
            Duration::from_secs(10),
        ));
        handle.cancel();
        handle.join();

        let enqueued = rec.enqueued.lock().unwrap().len();
        assert!(
            enqueued < 400,
            "cancellation must stop before processing all 400 files (got {enqueued})"
        );
        let last = rec.progress.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.phase, ReindexPhase::Cancelled);

        // Checkpoint flushed — a second run picks up where the first left off
        // (skipped == already-processed count, new enqueues cover the tail).
        let (rec2, _) = run_reindex_blocking(vault.path(), ckpt.path());
        let last2 = rec2.progress.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last2.total, 400);
        assert_eq!(last2.done, 400);
        assert!(
            last2.skipped >= enqueued - 1,
            "resumed run must skip at least what PR-1 already flushed: enq={enqueued}, skip={}",
            last2.skipped
        );
    }

    /// Lost-enqueue guard: if the caller's enqueue closure returns false
    /// (simulating `EmbedCoordinator::enqueue` → `Closed`), the checkpoint
    /// must NOT record that file, so the next run retries it.
    #[test]
    fn failed_enqueue_is_retried_next_run() {
        let vault = tempfile::tempdir().unwrap();
        let ckpt = tempfile::tempdir().unwrap();
        write_md(vault.path(), "a.md", "hello");

        let rec = Arc::new(Recorder::default());
        let enqueue_rec = Arc::clone(&rec);
        let progress_rec = Arc::clone(&rec);
        let handle = start_reindex(
            vault.path().to_path_buf(),
            ckpt.path().to_path_buf(),
            move |path, content| {
                enqueue_rec
                    .enqueued
                    .lock()
                    .unwrap()
                    .push((path.to_path_buf(), content));
                false // simulate Closed
            },
            move |p| progress_rec.progress.lock().unwrap().push(p),
        );
        handle.join();
        assert_eq!(rec.enqueued.lock().unwrap().len(), 1);

        // Second run: enqueue is still empty (checkpoint didn't record).
        let (rec2, _) = run_reindex_blocking(vault.path(), ckpt.path());
        assert_eq!(
            rec2.enqueued.lock().unwrap().len(),
            1,
            "stale file with no checkpoint entry must be retried"
        );
    }
}
