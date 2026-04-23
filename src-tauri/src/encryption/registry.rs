// Locked-path registry + in-memory derived-key cache.
//
// Every FS/indexer/link-graph/search entry point gates against this
// registry with `is_locked(path)`. The set stores CANONICAL absolute
// paths of encrypted folder roots that are currently locked. The
// frontend's auto-lock timer + manual-lock action both flow through
// `lock_root`; `unlock_root` removes the entry and stashes the derived
// key so content reads can proceed.
//
// Lock ordering (enforced by convention, not types):
//   current_vault  →  index_coordinator  →  locked_paths
//   file_index is independent; never held simultaneously with locked_paths.
//
// Keys live in a separate mutex (`Keyring`) so read-heavy `is_locked`
// lookups don't contend with the write-path that updates keys.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use zeroize::Zeroizing;

use crate::encryption::crypto::KEY_LEN;
use crate::error::VaultError;

/// Newtype wrapping a path the caller asserts is already canonical.
/// `is_locked` accepts only this — compilation-forced contract so PR 1b
/// cannot silently pass a non-canonical path and see a false negative
/// on macOS (`/var` vs `/private/var`), Windows (`\\?\C:`) or symlinks.
#[derive(Debug, Clone)]
pub struct CanonicalPath(PathBuf);

impl CanonicalPath {
    /// Canonicalize `path` on the filesystem. Errors bubble up so the
    /// call site handles "file does not exist" distinctly from "locked".
    pub fn canonicalize(path: &Path) -> std::io::Result<Self> {
        Ok(Self(std::fs::canonicalize(path)?))
    }

    /// Escape hatch for callers that already hold a canonical `PathBuf`
    /// (e.g. `ensure_inside_vault` has just canonicalized the target
    /// and does not want to syscall twice). Marked with a name that
    /// makes the assumption visible at every call site.
    pub fn assume_canonical(path: PathBuf) -> Self {
        Self(path)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Default)]
pub struct LockedPathRegistry {
    roots: RwLock<HashSet<PathBuf>>,
}

impl LockedPathRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if the canonical path sits inside any currently-
    /// locked root (including the root itself). The `CanonicalPath`
    /// newtype enforces canonicalization at the type level — callers
    /// that hold only a raw `&Path` must build one via
    /// `CanonicalPath::canonicalize` first.
    pub fn is_locked(&self, path: &CanonicalPath) -> bool {
        let guard = match self.roots.read() {
            Ok(g) => g,
            Err(_) => return true, // fail-closed on poisoned state
        };
        if guard.is_empty() {
            return false;
        }
        path.as_path().ancestors().any(|a| guard.contains(a))
    }

    pub fn lock_root(&self, root: PathBuf) -> Result<(), VaultError> {
        let mut g = self.roots.write().map_err(|_| VaultError::LockPoisoned)?;
        g.insert(root);
        Ok(())
    }

    pub fn unlock_root(&self, root: &Path) -> Result<bool, VaultError> {
        let mut g = self.roots.write().map_err(|_| VaultError::LockPoisoned)?;
        Ok(g.remove(root))
    }

    pub fn lock_all(&self, roots: impl IntoIterator<Item = PathBuf>) -> Result<(), VaultError> {
        let mut g = self.roots.write().map_err(|_| VaultError::LockPoisoned)?;
        for r in roots {
            g.insert(r);
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<(), VaultError> {
        let mut g = self.roots.write().map_err(|_| VaultError::LockPoisoned)?;
        g.clear();
        Ok(())
    }

    /// Returns all currently-locked roots. Fails closed on poisoned
    /// state — parity with `is_locked`, so a callsite that renders UI
    /// ("show lock icons for these roots") never silently sees an
    /// empty list when the registry is broken.
    pub fn snapshot(&self) -> Result<Vec<PathBuf>, VaultError> {
        let g = self.roots.read().map_err(|_| VaultError::LockPoisoned)?;
        Ok(g.iter().cloned().collect())
    }
}

/// In-memory derived-key cache. One entry per currently-unlocked root.
/// Keys are `Zeroizing` so a drop wipes the bytes; the whole Keyring is
/// cleared on vault close + app quit.
#[derive(Default)]
pub struct Keyring {
    keys: Mutex<HashMap<PathBuf, Zeroizing<[u8; KEY_LEN]>>>,
}

impl Keyring {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, root: PathBuf, key: Zeroizing<[u8; KEY_LEN]>) -> Result<(), VaultError> {
        let mut g = self.keys.lock().map_err(|_| VaultError::LockPoisoned)?;
        g.insert(root, key);
        Ok(())
    }

    pub fn remove(&self, root: &Path) -> Result<(), VaultError> {
        let mut g = self.keys.lock().map_err(|_| VaultError::LockPoisoned)?;
        g.remove(root); // drop() runs Zeroize
        Ok(())
    }

    pub fn clear(&self) -> Result<(), VaultError> {
        let mut g = self.keys.lock().map_err(|_| VaultError::LockPoisoned)?;
        g.clear();
        Ok(())
    }

    /// Clone the derived key for `root` into a fresh `Zeroizing<[u8;32]>`
    /// and release the mutex before the caller does any work with it.
    /// Callers perform decrypt using the returned key without serializing
    /// on the keyring mutex — critical for the hot read path (editor +
    /// indexer + search can all decrypt concurrently).
    ///
    /// Returns `None` if the root is not currently unlocked.
    pub fn key_clone(&self, root: &Path) -> Result<Option<Zeroizing<[u8; KEY_LEN]>>, VaultError> {
        let g = self.keys.lock().map_err(|_| VaultError::LockPoisoned)?;
        Ok(g.get(root).map(|k| {
            let mut out = Zeroizing::new([0u8; KEY_LEN]);
            out.copy_from_slice(k.as_slice());
            out
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(p: &str) -> CanonicalPath {
        CanonicalPath::assume_canonical(PathBuf::from(p))
    }

    #[test]
    fn empty_registry_locks_nothing() {
        let r = LockedPathRegistry::new();
        assert!(!r.is_locked(&canon("/tmp/vault/note.md")));
    }

    #[test]
    fn lock_root_marks_descendants_locked() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/secret")).unwrap();
        assert!(r.is_locked(&canon("/vault/secret")));
        assert!(r.is_locked(&canon("/vault/secret/note.md")));
        assert!(r.is_locked(&canon("/vault/secret/sub/deep.md")));
        assert!(!r.is_locked(&canon("/vault/plain/note.md")));
    }

    #[test]
    fn unlock_root_frees_subtree() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/secret")).unwrap();
        r.unlock_root(Path::new("/vault/secret")).unwrap();
        assert!(!r.is_locked(&canon("/vault/secret/note.md")));
    }

    #[test]
    fn lock_all_seeds_multiple_roots() {
        let r = LockedPathRegistry::new();
        r.lock_all(vec![
            PathBuf::from("/vault/a"),
            PathBuf::from("/vault/b"),
        ])
        .unwrap();
        assert!(r.is_locked(&canon("/vault/a/x.md")));
        assert!(r.is_locked(&canon("/vault/b/y.md")));
        assert!(!r.is_locked(&canon("/vault/c/z.md")));
    }

    #[test]
    fn clear_wipes_state() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/a")).unwrap();
        r.clear().unwrap();
        assert!(!r.is_locked(&canon("/vault/a")));
    }

    #[test]
    fn sibling_path_with_shared_prefix_not_locked() {
        // Guard against `starts_with(str)` misuse — `/vault/secretplans`
        // must NOT be locked just because `/vault/secret` is.
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/secret")).unwrap();
        assert!(!r.is_locked(&canon("/vault/secretplans/note.md")));
    }

    #[test]
    fn snapshot_returns_all_locked_roots() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/a")).unwrap();
        r.lock_root(PathBuf::from("/vault/b")).unwrap();
        let mut got = r.snapshot().unwrap();
        got.sort();
        assert_eq!(
            got,
            vec![PathBuf::from("/vault/a"), PathBuf::from("/vault/b")]
        );
    }

    #[test]
    fn keyring_clone_and_release() {
        let k = Keyring::new();
        let key = Zeroizing::new([1u8; KEY_LEN]);
        k.insert(PathBuf::from("/vault/a"), key).unwrap();
        let got = k.key_clone(Path::new("/vault/a")).unwrap().unwrap();
        assert_eq!(got[0], 1);
        // Cloned bytes are equal but live in a separate allocation — the
        // mutex is released by the time the caller reads the key.
        drop(got);
        k.remove(Path::new("/vault/a")).unwrap();
        let gone = k.key_clone(Path::new("/vault/a")).unwrap();
        assert!(gone.is_none());
    }
}
