// #357 — queue of plaintext paths dropped into locked encrypted folders.
//
// When the user drops a file (via Finder, Explorer, shell `mv`, another app)
// into an encrypted folder that is currently LOCKED, the watcher has no key
// to seal the file. Failing the drop outright is not an option — we cannot
// reject FS events back to the OS. Instead we remember the path, keep the
// plaintext on disk (a known gap — the user is warned in the UI), and seal
// every queued file for a root the moment the user unlocks it.
//
// In-memory only — queue state is deliberately not persisted. A crash
// between drop and unlock loses the pending list (but the file stays on
// disk for the user to re-trigger). Persistence is a future ticket.
//
// Per-root cap: 10_000 paths. A user who stuffs more than that into a
// single locked folder sees the oldest evictions logged with a warning.
// The bound prevents unbounded memory growth in pathological cases
// (e.g. an external sync tool stuck in a loop).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::error::VaultError;

/// Per-root queue state. The `VecDeque` is the source of truth for
/// insertion order + FIFO eviction; the `HashSet` is a companion index
/// that gives O(1) dedup on the hot path. Both must be kept in sync;
/// `enqueue_for_root` is the only call site that mutates them.
#[derive(Default)]
struct RootQueue {
    order: VecDeque<PathBuf>,
    membership: HashSet<PathBuf>,
}

/// Hard per-root cap. Beyond this we FIFO-evict the oldest entry so the
/// queue never grows without bound. 10k × ~200 B average PathBuf ≈ 2 MB
/// ceiling per root — acceptable for a queue that drains on the next
/// unlock.
pub(crate) const MAX_PENDING_PER_ROOT: usize = 10_000;

#[derive(Default)]
pub struct PendingEncryptionQueue {
    by_root: RwLock<HashMap<PathBuf, RootQueue>>,
}

impl PendingEncryptionQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enqueue `path` under `root`. Dedups exact-match paths in O(1)
    /// via the companion `HashSet`. Enforces `MAX_PENDING_PER_ROOT`
    /// with FIFO eviction + `log::warn!` so overflow is observable.
    pub fn enqueue_for_root(&self, root: PathBuf, path: PathBuf) -> Result<(), VaultError> {
        let mut g = self.by_root.write().map_err(|_| VaultError::LockPoisoned)?;
        let queue = g.entry(root.clone()).or_default();
        if queue.membership.contains(&path) {
            return Ok(());
        }
        if queue.order.len() >= MAX_PENDING_PER_ROOT {
            if let Some(evicted) = queue.order.pop_front() {
                queue.membership.remove(&evicted);
                log::warn!(
                    "pending-encryption queue for {} at cap {}; evicting oldest {} — \
                     the evicted file remains plaintext on disk until the user \
                     re-triggers (e.g. by saving it from inside VaultCore).",
                    root.display(),
                    MAX_PENDING_PER_ROOT,
                    evicted.display(),
                );
            }
        }
        queue.membership.insert(path.clone());
        queue.order.push_back(path);
        Ok(())
    }

    /// Remove and return every queued path for `root`. Returns an empty
    /// vec if the root has no pending entries — the unlock path calls
    /// this unconditionally.
    pub fn drain_root(&self, root: &Path) -> Result<Vec<PathBuf>, VaultError> {
        let mut g = self.by_root.write().map_err(|_| VaultError::LockPoisoned)?;
        let drained = g
            .remove(root)
            .map(|q| q.order.into_iter().collect())
            .unwrap_or_default();
        Ok(drained)
    }

    /// Snapshot queue length for `root` — used by tests and by future
    /// UI to display "N file(s) pending for this locked folder".
    pub fn len_for_root(&self, root: &Path) -> usize {
        match self.by_root.read() {
            Ok(g) => g.get(root).map(|q| q.order.len()).unwrap_or(0),
            Err(_) => 0,
        }
    }

    /// Wipe all pending entries across every root. Called on vault
    /// close / switch so queued paths for vault A cannot be drained
    /// into vault B's keyring.
    pub fn clear(&self) -> Result<(), VaultError> {
        let mut g = self.by_root.write().map_err(|_| VaultError::LockPoisoned)?;
        g.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn enqueue_and_drain_roundtrip() {
        let q = PendingEncryptionQueue::new();
        let root = p("/vault/secret");
        q.enqueue_for_root(root.clone(), p("/vault/secret/a.png")).unwrap();
        q.enqueue_for_root(root.clone(), p("/vault/secret/b.jpg")).unwrap();
        q.enqueue_for_root(root.clone(), p("/vault/secret/c.pdf")).unwrap();

        let mut drained = q.drain_root(&root).unwrap();
        drained.sort();
        assert_eq!(
            drained,
            vec![
                p("/vault/secret/a.png"),
                p("/vault/secret/b.jpg"),
                p("/vault/secret/c.pdf"),
            ]
        );
        // Second drain is empty.
        assert!(q.drain_root(&root).unwrap().is_empty());
    }

    #[test]
    fn drain_nonexistent_root_yields_empty_vec() {
        let q = PendingEncryptionQueue::new();
        assert!(q.drain_root(&p("/never/seen")).unwrap().is_empty());
    }

    #[test]
    fn enqueue_dedups_same_path_for_same_root() {
        let q = PendingEncryptionQueue::new();
        let root = p("/vault/secret");
        q.enqueue_for_root(root.clone(), p("/vault/secret/x.png")).unwrap();
        q.enqueue_for_root(root.clone(), p("/vault/secret/x.png")).unwrap();
        q.enqueue_for_root(root.clone(), p("/vault/secret/x.png")).unwrap();
        assert_eq!(q.len_for_root(&root), 1);
        assert_eq!(q.drain_root(&root).unwrap(), vec![p("/vault/secret/x.png")]);
    }

    #[test]
    fn enqueue_different_roots_stay_isolated() {
        let q = PendingEncryptionQueue::new();
        let root_a = p("/vault/a");
        let root_b = p("/vault/b");
        q.enqueue_for_root(root_a.clone(), p("/vault/a/one.png")).unwrap();
        q.enqueue_for_root(root_b.clone(), p("/vault/b/two.png")).unwrap();
        assert_eq!(q.len_for_root(&root_a), 1);
        assert_eq!(q.len_for_root(&root_b), 1);
        let drained_a = q.drain_root(&root_a).unwrap();
        assert_eq!(drained_a, vec![p("/vault/a/one.png")]);
        // B unchanged.
        assert_eq!(q.len_for_root(&root_b), 1);
    }

    #[test]
    fn queue_enforces_fifo_cap_with_eviction() {
        let q = PendingEncryptionQueue::new();
        let root = p("/vault/big");
        // Fill to cap + 5 extra.
        for i in 0..(MAX_PENDING_PER_ROOT + 5) {
            let path = root.join(format!("file-{i}.bin"));
            q.enqueue_for_root(root.clone(), path).unwrap();
        }
        let drained = q.drain_root(&root).unwrap();
        // The oldest 5 are evicted; survivors are the tail.
        assert_eq!(drained.len(), MAX_PENDING_PER_ROOT);
        assert_eq!(drained[0], root.join("file-5.bin"));
        assert_eq!(
            drained[MAX_PENDING_PER_ROOT - 1],
            root.join(format!("file-{}.bin", MAX_PENDING_PER_ROOT + 4)),
        );
    }

    #[test]
    fn clear_wipes_every_root() {
        let q = PendingEncryptionQueue::new();
        q.enqueue_for_root(p("/a"), p("/a/1")).unwrap();
        q.enqueue_for_root(p("/b"), p("/b/1")).unwrap();
        q.clear().unwrap();
        assert!(q.drain_root(&p("/a")).unwrap().is_empty());
        assert!(q.drain_root(&p("/b")).unwrap().is_empty());
    }
}
