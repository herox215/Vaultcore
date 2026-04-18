//! Issue #137 — read/write contention micro-bench for FileIndex.
//!
//! Default-ignored so it never fires in regular `cargo test` runs. Execute
//! explicitly with:
//!
//! ```sh
//! cargo test --manifest-path src-tauri/Cargo.toml --release \
//!     tests::file_index_contention -- --ignored --nocapture
//! ```
//!
//! The goal is to answer issue #137's question: would migrating
//! `Arc<Mutex<FileIndex>>` to `Arc<RwLock<FileIndex>>` meaningfully
//! unblock concurrent read-heavy workloads (search_filename, link
//! autocomplete, tag panel refresh, backlinks)?
//!
//! ── Workload ──────────────────────────────────────────────────────────
//! - Populate a FileIndex with 100_000 entries (matches spec §1.3 target).
//! - Spawn N reader threads that repeatedly walk `all_relative_paths()`
//!   (the hot path hit by search_filename, resolved_map, and
//!   link-autocomplete).
//! - Spawn 1 writer thread that performs insert/remove churn at a low
//!   duty cycle (matches the file-watcher cadence — writes are rare).
//! - Measure wall-clock time for each reader to complete K iterations.
//!
//! Record p50/p95/p99 of completion time per reader under Mutex and
//! RwLock. A material p95 win on RwLock supports the migration; a tiny
//! or negative delta closes the ticket as a no-op.

use crate::indexer::memory::{FileIndex, FileMeta};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

// ── Parameters ────────────────────────────────────────────────────────
const VAULT_SIZE: usize = 100_000;
const READER_THREADS: usize = 16;
const READER_ITERATIONS: usize = 10;
const WRITE_CHURN_INTERVAL: Duration = Duration::from_millis(2);

fn make_file_index() -> FileIndex {
    let mut idx = FileIndex::new();
    for i in 0..VAULT_SIZE {
        let rel = format!("folder{}/note{:06}.md", i % 64, i);
        idx.insert(
            PathBuf::from(format!("/vault/{}", rel)),
            FileMeta {
                relative_path: rel,
                hash: "0".repeat(64),
                title: format!("Note {}", i),
                aliases: Vec::new(),
            },
        );
    }
    idx
}

fn percentile(values: &mut [Duration], p: f64) -> Duration {
    values.sort();
    let idx = ((values.len() as f64 - 1.0) * p).round() as usize;
    values[idx]
}

#[test]
#[ignore] // run explicitly with --ignored for bench data (#137)
fn bench_mutex_read_contention() {
    let idx = Arc::new(Mutex::new(make_file_index()));
    let stop_writer = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Writer: periodic insert/remove churn
    let writer_idx = Arc::clone(&idx);
    let writer_stop = Arc::clone(&stop_writer);
    let writer = thread::spawn(move || {
        let mut i = VAULT_SIZE;
        while !writer_stop.load(std::sync::atomic::Ordering::Relaxed) {
            {
                let mut g = writer_idx.lock().unwrap();
                let rel = format!("churn/note{:06}.md", i);
                g.insert(
                    PathBuf::from(format!("/vault/{}", rel)),
                    FileMeta {
                        relative_path: rel,
                        hash: "0".repeat(64),
                        title: "t".into(),
                        aliases: Vec::new(),
                    },
                );
                g.remove(&PathBuf::from(format!("/vault/churn/note{:06}.md", i)));
            }
            i = i.wrapping_add(1);
            thread::sleep(WRITE_CHURN_INTERVAL);
        }
    });

    let mut handles = Vec::new();
    for _ in 0..READER_THREADS {
        let r_idx = Arc::clone(&idx);
        handles.push(thread::spawn(move || {
            let start = Instant::now();
            for _ in 0..READER_ITERATIONS {
                let g = r_idx.lock().unwrap();
                let n = g.all_relative_paths().len();
                assert!(n >= VAULT_SIZE);
            }
            start.elapsed()
        }));
    }

    let mut times: Vec<Duration> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    stop_writer.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();

    let p50 = percentile(&mut times.clone(), 0.50);
    let p95 = percentile(&mut times.clone(), 0.95);
    let p99 = percentile(&mut times, 0.99);
    println!(
        "[Mutex] {} readers × {} iters, 100k entries — p50={:?} p95={:?} p99={:?}",
        READER_THREADS, READER_ITERATIONS, p50, p95, p99,
    );
}

#[test]
#[ignore] // run explicitly with --ignored for bench data (#137)
fn bench_rwlock_read_contention() {
    let idx = Arc::new(RwLock::new(make_file_index()));
    let stop_writer = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let writer_idx = Arc::clone(&idx);
    let writer_stop = Arc::clone(&stop_writer);
    let writer = thread::spawn(move || {
        let mut i = VAULT_SIZE;
        while !writer_stop.load(std::sync::atomic::Ordering::Relaxed) {
            {
                let mut g = writer_idx.write().unwrap();
                let rel = format!("churn/note{:06}.md", i);
                g.insert(
                    PathBuf::from(format!("/vault/{}", rel)),
                    FileMeta {
                        relative_path: rel,
                        hash: "0".repeat(64),
                        title: "t".into(),
                        aliases: Vec::new(),
                    },
                );
                g.remove(&PathBuf::from(format!("/vault/churn/note{:06}.md", i)));
            }
            i = i.wrapping_add(1);
            thread::sleep(WRITE_CHURN_INTERVAL);
        }
    });

    let mut handles = Vec::new();
    for _ in 0..READER_THREADS {
        let r_idx = Arc::clone(&idx);
        handles.push(thread::spawn(move || {
            let start = Instant::now();
            for _ in 0..READER_ITERATIONS {
                let g = r_idx.read().unwrap();
                let n = g.all_relative_paths().len();
                assert!(n >= VAULT_SIZE);
            }
            start.elapsed()
        }));
    }

    let mut times: Vec<Duration> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    stop_writer.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();

    let p50 = percentile(&mut times.clone(), 0.50);
    let p95 = percentile(&mut times.clone(), 0.95);
    let p99 = percentile(&mut times, 0.99);
    println!(
        "[RwLock] {} readers × {} iters, 100k entries — p50={:?} p95={:?} p99={:?}",
        READER_THREADS, READER_ITERATIONS, p50, p95, p99,
    );
}
