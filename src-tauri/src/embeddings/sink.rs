//! `VectorSink` — where embedded chunk vectors land. Defined as a trait so
//! the embed-on-save coordinator (#196) can ship today against a no-op,
//! and #198's HNSW-backed implementation can drop in later without
//! touching the queue.
//!
//! Lifecycle contract: callers invoke `store(path, ...)` once per
//! coalesced save. The sink is responsible for replacing any prior
//! vectors associated with `path` (upsert semantics) — #200 will add an
//! explicit delete hook for rename/delete paths; for now an
//! upsert-replace is sufficient because every save produces a fresh
//! chunk set for the same path.

use std::path::Path;

use super::Chunk;

pub trait VectorSink: Send + Sync {
    fn store(&self, path: &Path, chunks_with_vectors: Vec<(Chunk, Vec<f32>)>);
}

/// Discards everything. Used while #198 is still pending.
pub struct NoopSink;

impl VectorSink for NoopSink {
    fn store(&self, _path: &Path, _chunks_with_vectors: Vec<(Chunk, Vec<f32>)>) {}
}
