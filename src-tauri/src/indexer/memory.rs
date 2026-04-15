// In-memory file metadata store.
//
// FileIndex is the authoritative in-memory map of vault files.  It is keyed by
// the canonical absolute path so look-ups survive symlink resolution and are
// O(1).  The SHA-256 hash stored in FileMeta enables incremental re-indexing:
// if the hash matches the previous entry the file is skipped (IDX-03).

use std::collections::HashMap;
use std::path::PathBuf;

/// Per-file metadata cached in memory.
#[derive(Debug, Clone)]
pub struct FileMeta {
    /// Vault-relative path with forward-slash separators on all platforms.
    pub relative_path: String,
    /// SHA-256 hex digest of the raw file bytes.
    pub hash: String,
    /// First `# ` heading text, or the filename stem as fallback.
    pub title: String,
    /// YAML frontmatter `aliases:` values (lowercased, order preserved).
    /// Issue #60 — empty when the file has no frontmatter or no aliases key.
    pub aliases: Vec<String>,
}

/// In-memory index of vault files keyed by canonical absolute path.
#[derive(Debug, Default)]
pub struct FileIndex {
    entries: HashMap<PathBuf, FileMeta>,
}

impl FileIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, abs_path: PathBuf, meta: FileMeta) {
        self.entries.insert(abs_path, meta);
    }

    pub fn get(&self, abs_path: &PathBuf) -> Option<&FileMeta> {
        self.entries.get(abs_path)
    }

    pub fn remove(&mut self, abs_path: &PathBuf) -> Option<FileMeta> {
        self.entries.remove(abs_path)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Vault-relative paths of all indexed files (order not guaranteed).
    pub fn all_relative_paths(&self) -> Vec<String> {
        self.entries.values().map(|m| m.relative_path.clone()).collect()
    }

    pub fn all_entries(&self) -> impl Iterator<Item = (&PathBuf, &FileMeta)> {
        self.entries.iter()
    }

    /// Update the aliases slot for the entry matching `rel_path`. No-op when
    /// the rel_path is not in the index (aliases are populated as part of
    /// `AddFile`; this is only used for in-place refreshes from `UpdateLinks`).
    pub fn set_aliases_for_rel(&mut self, rel_path: &str, aliases: Vec<String>) {
        for meta in self.entries.values_mut() {
            if meta.relative_path == rel_path {
                meta.aliases = aliases;
                return;
            }
        }
    }

    /// Return the aliases stored for `rel_path`, or an empty vector.
    pub fn aliases_for_rel(&self, rel_path: &str) -> Vec<String> {
        for meta in self.entries.values() {
            if meta.relative_path == rel_path {
                return meta.aliases.clone();
            }
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_meta(rel: &str) -> FileMeta {
        FileMeta {
            relative_path: rel.to_string(),
            hash: "abc123".to_string(),
            title: "Test".to_string(),
            aliases: Vec::new(),
        }
    }

    #[test]
    fn insert_get_round_trip() {
        let mut idx = FileIndex::new();
        let path = PathBuf::from("/vault/note.md");
        idx.insert(path.clone(), make_meta("note.md"));
        let got = idx.get(&path).expect("entry should exist");
        assert_eq!(got.relative_path, "note.md");
    }

    #[test]
    fn remove_deletes_entry() {
        let mut idx = FileIndex::new();
        let path = PathBuf::from("/vault/note.md");
        idx.insert(path.clone(), make_meta("note.md"));
        assert!(idx.remove(&path).is_some());
        assert!(idx.get(&path).is_none());
    }

    #[test]
    fn all_relative_paths_returns_inserted() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        idx.insert(PathBuf::from("/vault/b.md"), make_meta("b.md"));
        let mut paths = idx.all_relative_paths();
        paths.sort();
        assert_eq!(paths, vec!["a.md", "b.md"]);
    }

    #[test]
    fn len_and_is_empty() {
        let mut idx = FileIndex::new();
        assert!(idx.is_empty());
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        assert_eq!(idx.len(), 1);
        assert!(!idx.is_empty());
    }
}
