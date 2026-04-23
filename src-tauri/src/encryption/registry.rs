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

#[derive(Default)]
pub struct LockedPathRegistry {
    roots: RwLock<HashSet<PathBuf>>,
}

impl LockedPathRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if `path` sits inside any currently-locked root
    /// (including the root itself). `path` must be canonical — callers
    /// are responsible for canonicalizing before calling.
    pub fn is_locked(&self, path: &Path) -> bool {
        let guard = match self.roots.read() {
            Ok(g) => g,
            Err(_) => return true, // fail-closed on poisoned state
        };
        if guard.is_empty() {
            return false;
        }
        path.ancestors().any(|a| guard.contains(a))
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

    pub fn snapshot(&self) -> Vec<PathBuf> {
        match self.roots.read() {
            Ok(g) => g.iter().cloned().collect(),
            Err(_) => Vec::new(),
        }
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

    /// Run `f` with a read-only reference to the key for `root`. Keeps
    /// the key behind the mutex; callers receive the `f` return value.
    pub fn with_key<R>(
        &self,
        root: &Path,
        f: impl FnOnce(&[u8; KEY_LEN]) -> R,
    ) -> Result<Option<R>, VaultError> {
        let g = self.keys.lock().map_err(|_| VaultError::LockPoisoned)?;
        Ok(g.get(root).map(|k| f(k)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_locks_nothing() {
        let r = LockedPathRegistry::new();
        assert!(!r.is_locked(Path::new("/tmp/vault/note.md")));
    }

    #[test]
    fn lock_root_marks_descendants_locked() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/secret")).unwrap();
        assert!(r.is_locked(Path::new("/vault/secret")));
        assert!(r.is_locked(Path::new("/vault/secret/note.md")));
        assert!(r.is_locked(Path::new("/vault/secret/sub/deep.md")));
        assert!(!r.is_locked(Path::new("/vault/plain/note.md")));
    }

    #[test]
    fn unlock_root_frees_subtree() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/secret")).unwrap();
        r.unlock_root(Path::new("/vault/secret")).unwrap();
        assert!(!r.is_locked(Path::new("/vault/secret/note.md")));
    }

    #[test]
    fn lock_all_seeds_multiple_roots() {
        let r = LockedPathRegistry::new();
        r.lock_all(vec![
            PathBuf::from("/vault/a"),
            PathBuf::from("/vault/b"),
        ])
        .unwrap();
        assert!(r.is_locked(Path::new("/vault/a/x.md")));
        assert!(r.is_locked(Path::new("/vault/b/y.md")));
        assert!(!r.is_locked(Path::new("/vault/c/z.md")));
    }

    #[test]
    fn clear_wipes_state() {
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/a")).unwrap();
        r.clear().unwrap();
        assert!(!r.is_locked(Path::new("/vault/a")));
    }

    #[test]
    fn sibling_path_with_shared_prefix_not_locked() {
        // Guard against `starts_with(str)` misuse — `/vault/secretplans`
        // must NOT be locked just because `/vault/secret` is.
        let r = LockedPathRegistry::new();
        r.lock_root(PathBuf::from("/vault/secret")).unwrap();
        assert!(!r.is_locked(Path::new("/vault/secretplans/note.md")));
    }

    #[test]
    fn keyring_zeroizes_on_remove() {
        // We can't observe zeroization directly, but we can confirm the
        // slot is gone and the Zeroizing drop path ran without panicking.
        let k = Keyring::new();
        let key = Zeroizing::new([1u8; KEY_LEN]);
        k.insert(PathBuf::from("/vault/a"), key).unwrap();
        let got = k
            .with_key(Path::new("/vault/a"), |b| b[0])
            .unwrap();
        assert_eq!(got, Some(1));
        k.remove(Path::new("/vault/a")).unwrap();
        let gone = k
            .with_key(Path::new("/vault/a"), |_| ())
            .unwrap();
        assert!(gone.is_none());
    }
}
