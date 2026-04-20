// In-memory file metadata store.
//
// FileIndex is the authoritative in-memory map of vault files.  It is keyed by
// the canonical absolute path so look-ups survive symlink resolution and are
// O(1).  The SHA-256 hash stored in FileMeta enables incremental re-indexing:
// if the hash matches the previous entry the file is skipped (IDX-03).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
///
/// Issue #248 — a secondary `rel_to_abs` map turns previously O(n) lookups by
/// relative path (alias ops, rel→entry access) into O(1). Both maps are kept
/// in strict sync by every mutator; the invariant `entries.len() ==
/// rel_to_abs.len()` is asserted by unit tests. Call sites outside this
/// module must continue to go through the public API so the invariant holds.
#[derive(Debug, Default)]
pub struct FileIndex {
    entries: HashMap<PathBuf, FileMeta>,
    /// Vault-relative path → absolute path. Enables O(1) `rel_path → entry`
    /// lookup via `entries.get(abs_path)`. Kept in sync with `entries` by
    /// every mutator in this module.
    rel_to_abs: HashMap<String, PathBuf>,
}

impl FileIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or overwrite the entry at `abs_path`.
    ///
    /// If a prior entry at `abs_path` mapped to a different `relative_path`,
    /// the stale rel→abs entry is pruned so `rel_to_abs` never points at an
    /// abs_path whose stored meta has a different `relative_path`.
    pub fn insert(&mut self, abs_path: PathBuf, meta: FileMeta) {
        if let Some(existing) = self.entries.get(&abs_path) {
            if existing.relative_path != meta.relative_path {
                // Only drop the stale mapping if it still points at *this*
                // abs_path — another entry may have claimed that rel_path
                // between calls.
                if let Some(mapped) = self.rel_to_abs.get(&existing.relative_path) {
                    if mapped == &abs_path {
                        self.rel_to_abs.remove(&existing.relative_path);
                    }
                }
            }
        }
        self.rel_to_abs
            .insert(meta.relative_path.clone(), abs_path.clone());
        self.entries.insert(abs_path, meta);
    }

    pub fn get(&self, abs_path: &PathBuf) -> Option<&FileMeta> {
        self.entries.get(abs_path)
    }

    pub fn remove(&mut self, abs_path: &PathBuf) -> Option<FileMeta> {
        let removed = self.entries.remove(abs_path)?;
        // Only drop the rel→abs entry if it still points at the removed
        // abs_path. This guards against the theoretical race where two entries
        // briefly shared the same rel_path (shouldn't happen in practice, but
        // cheap to be precise).
        if let Some(mapped) = self.rel_to_abs.get(&removed.relative_path) {
            if mapped == abs_path {
                self.rel_to_abs.remove(&removed.relative_path);
            }
        }
        Some(removed)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.rel_to_abs.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Vault-relative paths of all indexed files (order not guaranteed).
    ///
    /// Allocates a fresh `Vec<String>` and clones every path — prefer
    /// `iter_relative_paths` when the caller only needs to borrow (#248).
    pub fn all_relative_paths(&self) -> Vec<String> {
        self.entries.values().map(|m| m.relative_path.clone()).collect()
    }

    /// Borrowed iterator over vault-relative paths. Zero allocations, zero
    /// clones — suitable for hot read-only paths that previously had to
    /// `all_relative_paths` just to iterate (#248).
    pub fn iter_relative_paths(&self) -> impl Iterator<Item = &str> {
        self.rel_to_abs.keys().map(|s| s.as_str())
    }

    pub fn all_entries(&self) -> impl Iterator<Item = (&PathBuf, &FileMeta)> {
        self.entries.iter()
    }

    /// O(1) lookup of a `FileMeta` by vault-relative path.
    pub fn entry_for_rel(&self, rel_path: &str) -> Option<&FileMeta> {
        let abs = self.rel_to_abs.get(rel_path)?;
        self.entries.get(abs)
    }

    /// O(1) reverse lookup: rel_path → canonical absolute path.
    pub fn abs_for_rel(&self, rel_path: &str) -> Option<&Path> {
        self.rel_to_abs.get(rel_path).map(|p| p.as_path())
    }

    /// O(1) existence check — avoids the `Vec` allocation of
    /// `all_relative_paths` when the caller only needs a yes/no.
    pub fn contains_rel(&self, rel_path: &str) -> bool {
        self.rel_to_abs.contains_key(rel_path)
    }

    /// Update the aliases slot for the entry matching `rel_path`. No-op when
    /// the rel_path is not in the index (aliases are populated as part of
    /// `AddFile`; this is only used for in-place refreshes from `UpdateLinks`).
    ///
    /// O(1) via the `rel_to_abs` index (#248).
    pub fn set_aliases_for_rel(&mut self, rel_path: &str, aliases: Vec<String>) {
        if let Some(abs) = self.rel_to_abs.get(rel_path) {
            if let Some(meta) = self.entries.get_mut(abs) {
                meta.aliases = aliases;
            }
        }
    }

    /// Return the aliases stored for `rel_path`, or an empty vector.
    ///
    /// O(1) via the `rel_to_abs` index (#248).
    pub fn aliases_for_rel(&self, rel_path: &str) -> Vec<String> {
        self.entry_for_rel(rel_path)
            .map(|m| m.aliases.clone())
            .unwrap_or_default()
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

    // ── #248: rel_path → entry O(1) index ──────────────────────────────────
    //
    // These tests pin the new contract: lookups and alias ops that previously
    // scanned `entries` linearly now go through `rel_to_abs`. Parity with the
    // pre-#248 behaviour is asserted on the original methods (`aliases_for_rel`,
    // `all_relative_paths`) as well as on the new O(1) entry points.

    #[test]
    fn entry_for_rel_roundtrip() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        idx.insert(PathBuf::from("/vault/sub/b.md"), make_meta("sub/b.md"));

        let a = idx.entry_for_rel("a.md").expect("a.md entry");
        assert_eq!(a.relative_path, "a.md");
        let b = idx.entry_for_rel("sub/b.md").expect("sub/b.md entry");
        assert_eq!(b.relative_path, "sub/b.md");
        assert!(idx.entry_for_rel("missing.md").is_none());
    }

    #[test]
    fn abs_for_rel_roundtrip() {
        let mut idx = FileIndex::new();
        let abs = PathBuf::from("/vault/sub/b.md");
        idx.insert(abs.clone(), make_meta("sub/b.md"));
        assert_eq!(idx.abs_for_rel("sub/b.md"), Some(abs.as_path()));
        assert_eq!(idx.abs_for_rel("nope"), None);
    }

    #[test]
    fn contains_rel_matches_entry_for_rel() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        assert!(idx.contains_rel("a.md"));
        assert!(!idx.contains_rel("missing.md"));
    }

    #[test]
    fn iter_relative_paths_matches_all_relative_paths() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        idx.insert(PathBuf::from("/vault/b.md"), make_meta("b.md"));
        idx.insert(PathBuf::from("/vault/sub/c.md"), make_meta("sub/c.md"));

        let mut from_iter: Vec<String> =
            idx.iter_relative_paths().map(|s| s.to_string()).collect();
        let mut from_vec = idx.all_relative_paths();
        from_iter.sort();
        from_vec.sort();
        assert_eq!(from_iter, from_vec);
    }

    #[test]
    fn set_aliases_for_rel_is_indexed() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        idx.set_aliases_for_rel("a.md", vec!["alpha".into(), "alef".into()]);
        assert_eq!(
            idx.aliases_for_rel("a.md"),
            vec!["alpha".to_string(), "alef".to_string()],
        );
        // No-op when the rel_path is not in the index (original contract).
        idx.set_aliases_for_rel("missing.md", vec!["x".into()]);
        assert_eq!(idx.aliases_for_rel("missing.md"), Vec::<String>::new());
    }

    #[test]
    fn remove_drops_rel_index_entry() {
        let mut idx = FileIndex::new();
        let path = PathBuf::from("/vault/a.md");
        idx.insert(path.clone(), make_meta("a.md"));
        assert!(idx.contains_rel("a.md"));
        idx.remove(&path);
        assert!(!idx.contains_rel("a.md"));
        assert!(idx.abs_for_rel("a.md").is_none());
        assert_eq!(idx.aliases_for_rel("a.md"), Vec::<String>::new());
    }

    #[test]
    fn clear_drops_rel_index_entries() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), make_meta("a.md"));
        idx.insert(PathBuf::from("/vault/b.md"), make_meta("b.md"));
        idx.clear();
        assert!(!idx.contains_rel("a.md"));
        assert!(!idx.contains_rel("b.md"));
        assert_eq!(idx.iter_relative_paths().count(), 0);
    }

    #[test]
    fn overwriting_insert_refreshes_rel_index() {
        // Re-inserting the same abs_path with a different relative_path must
        // drop the stale rel→abs mapping so lookups don't return ghosts.
        let mut idx = FileIndex::new();
        let abs = PathBuf::from("/vault/a.md");
        idx.insert(abs.clone(), make_meta("old.md"));
        assert!(idx.contains_rel("old.md"));

        idx.insert(abs.clone(), make_meta("new.md"));
        assert!(!idx.contains_rel("old.md"), "stale rel mapping should be removed");
        assert!(idx.contains_rel("new.md"));
        // Invariant: the two maps have the same size.
        assert_eq!(idx.len(), idx.iter_relative_paths().count());
    }

    #[test]
    fn rel_index_invariant_holds_under_churn() {
        // Insert/remove churn — the invariant |entries| == |rel_to_abs| must
        // survive every mutation (see issue #248 risk section).
        let mut idx = FileIndex::new();
        for i in 0..50 {
            let rel = format!("n{:03}.md", i);
            idx.insert(PathBuf::from(format!("/vault/{}", rel)), make_meta(&rel));
        }
        assert_eq!(idx.len(), 50);
        assert_eq!(idx.iter_relative_paths().count(), 50);

        for i in (0..50).step_by(2) {
            idx.remove(&PathBuf::from(format!("/vault/n{:03}.md", i)));
        }
        assert_eq!(idx.len(), 25);
        assert_eq!(idx.iter_relative_paths().count(), 25);

        // Every surviving rel must resolve via the rel index.
        for i in (1..50).step_by(2) {
            let rel = format!("n{:03}.md", i);
            assert!(idx.contains_rel(&rel));
            assert_eq!(
                idx.entry_for_rel(&rel).map(|m| m.relative_path.as_str()),
                Some(rel.as_str()),
            );
        }
    }

    #[test]
    fn aliases_for_rel_parity_with_legacy_linear_scan() {
        // Behavioural parity: the new O(1) path returns the same aliases the
        // pre-#248 linear scan would have returned for each seeded entry.
        let mut idx = FileIndex::new();
        let seeds = [
            ("a.md", vec!["alpha".to_string()]),
            ("sub/b.md", vec!["beta".to_string(), "bravo".to_string()]),
            ("c.md", Vec::<String>::new()),
        ];
        for (rel, aliases) in &seeds {
            idx.insert(
                PathBuf::from(format!("/vault/{}", rel)),
                FileMeta {
                    relative_path: (*rel).to_string(),
                    hash: "h".into(),
                    title: "t".into(),
                    aliases: aliases.clone(),
                },
            );
        }
        for (rel, expected) in &seeds {
            assert_eq!(&idx.aliases_for_rel(rel), expected);
        }
        // Absent path → empty vec (matches legacy behaviour).
        assert_eq!(idx.aliases_for_rel("zzz.md"), Vec::<String>::new());
    }
}
