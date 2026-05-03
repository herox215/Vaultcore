//! Content-addressed blob store under `<metadata>/sync-history/<hash[..2]>/<hash>`.
//!
//! Stores up to `retain_per_file` versions per `(vault_id, path)` (LRU
//! eviction is handled in [`super::state`]). The on-disk layout is
//! sharded by the first two hex chars of the SHA-256 to keep any one
//! directory bounded even on vaults with many distinct revisions.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::ContentHash;

/// Per-file version retention. v1 keeps the last 2 (epic #73 spec).
#[derive(Debug, Clone, Copy)]
pub struct HistoryConfig {
    pub retain_per_file: usize,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self { retain_per_file: 2 }
    }
}

#[derive(Debug)]
pub struct History {
    root: PathBuf,
    config: HistoryConfig,
}

impl History {
    pub fn new(root: PathBuf, config: HistoryConfig) -> Self {
        Self { root, config }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config(&self) -> HistoryConfig {
        self.config
    }

    /// Write a blob keyed by `content_hash`. Returns the path relative to
    /// `root` so it can be stored in the `blob_path` column. Idempotent —
    /// if the blob already exists with matching content the write is
    /// skipped.
    pub fn put_blob(&self, content_hash: ContentHash, content: &[u8]) -> io::Result<PathBuf> {
        let (shard, name) = shard_for(&content_hash);
        let abs_dir = self.root.join(&shard);
        fs::create_dir_all(&abs_dir)?;
        let abs_path = abs_dir.join(&name);
        if !abs_path.exists() {
            // Atomic-write via tmp + rename so a crash mid-write never
            // leaves a half-written blob under its real hash name.
            let tmp = abs_dir.join(format!(".{name}.tmp"));
            fs::write(&tmp, content)?;
            fs::rename(&tmp, &abs_path)?;
        }
        Ok(PathBuf::from(shard).join(name))
    }

    pub fn read_blob(&self, rel: &Path) -> io::Result<Vec<u8>> {
        fs::read(self.root.join(rel))
    }

    /// Best-effort: walk the on-disk shards and delete blobs not
    /// referenced by `live_rel_paths`. Caller passes the set of
    /// blob-paths still referenced from `sync_history` after eviction.
    pub fn gc_orphans(&self, live_rel_paths: &std::collections::HashSet<PathBuf>) -> io::Result<usize> {
        if !self.root.exists() {
            return Ok(0);
        }
        let mut removed = 0;
        for shard_entry in fs::read_dir(&self.root)? {
            let shard_entry = shard_entry?;
            if !shard_entry.file_type()?.is_dir() {
                continue;
            }
            let shard_name = shard_entry.file_name();
            let shard_path = shard_entry.path();
            for blob_entry in fs::read_dir(&shard_path)? {
                let blob_entry = blob_entry?;
                let file_name = blob_entry.file_name();
                // Skip in-flight `.<name>.tmp` files from `put_blob`.
                if file_name.to_string_lossy().starts_with('.') {
                    continue;
                }
                let rel = PathBuf::from(&shard_name).join(&file_name);
                if !live_rel_paths.contains(&rel) && blob_entry.path().is_file() {
                    fs::remove_file(blob_entry.path())?;
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }
}

/// `("ab", "abcdef…")` — two-char shard + full hex name.
fn shard_for(hash: &ContentHash) -> (String, String) {
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    let shard = hex[..2].to_string();
    (shard, hex)
}
