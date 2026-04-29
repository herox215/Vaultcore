// Per-vault anchor index — maps `rel_path -> AnchorTable` for every indexed
// `.md` file. Sibling to `LinkGraph` and `TagIndex` so the same Arc<Mutex<>>
// + accessor pattern carries over.
//
// Two consumers:
//   - `get_resolved_anchors` (Tauri command) returns a snapshot per vault open.
//   - `resolve_anchor` is called by the rename-cascade Rust path so anchors
//     survive a rename without a frontend round-trip.

use std::collections::HashMap;

use super::anchors::{build_anchor_key_set, AnchorKeySet, AnchorTable};

#[derive(Debug, Default)]
pub struct AnchorIndex {
    by_path: HashMap<String, AnchorTable>,
    /// Pre-built wire-format payload kept in lock-step with `by_path`. The
    /// hot get_resolved_anchors path returns this without re-walking the
    /// table on every IPC, mirroring the prebuilt-cache idea behind
    /// `StemIndex` for the link-resolution path.
    payload: HashMap<String, AnchorKeySet>,
}

impl AnchorIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the anchor data for a single file. Idempotent: a second call
    /// for the same path overwrites the first.
    pub fn update_file(&mut self, rel_path: &str, content: &str, table: AnchorTable) {
        let payload = build_anchor_key_set(content, &table);
        self.payload.insert(rel_path.to_string(), payload);
        self.by_path.insert(rel_path.to_string(), table);
    }

    /// Drop every anchor entry for a file (used on delete and rename-old).
    pub fn remove_file(&mut self, rel_path: &str) {
        self.by_path.remove(rel_path);
        self.payload.remove(rel_path);
    }

    /// Re-key an existing entry on rename — anchor data is keyed by rel_path
    /// only (anchor content is independent of filename), so rename does not
    /// invalidate the table itself. Cheaper than removing + re-extracting.
    pub fn rename_file(&mut self, old_rel: &str, new_rel: &str) {
        if let Some(table) = self.by_path.remove(old_rel) {
            self.by_path.insert(new_rel.to_string(), table);
        }
        if let Some(payload) = self.payload.remove(old_rel) {
            self.payload.insert(new_rel.to_string(), payload);
        }
    }

    pub fn anchors_for(&self, rel_path: &str) -> Option<&AnchorTable> {
        self.by_path.get(rel_path)
    }

    /// Snapshot for the wire payload — clones the precomputed map, no
    /// re-walking. Drop this guard before any await point.
    pub fn snapshot_payload(&self) -> HashMap<String, AnchorKeySet> {
        self.payload.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::anchors::extract_anchors;

    #[test]
    fn rename_moves_entry_without_recomputing() {
        let mut idx = AnchorIndex::new();
        let md = "para ^id1\n";
        let table = extract_anchors(md);
        idx.update_file("old.md", md, table);
        idx.rename_file("old.md", "new.md");
        assert!(idx.anchors_for("old.md").is_none());
        assert!(idx.anchors_for("new.md").is_some());
        let payload = idx.snapshot_payload();
        assert!(payload.contains_key("new.md"));
        assert!(!payload.contains_key("old.md"));
    }

    #[test]
    fn update_overwrites_previous_entry() {
        let mut idx = AnchorIndex::new();
        let md1 = "first ^a\n";
        let md2 = "second ^b\n";
        idx.update_file("note.md", md1, extract_anchors(md1));
        idx.update_file("note.md", md2, extract_anchors(md2));
        let table = idx.anchors_for("note.md").unwrap();
        assert_eq!(table.blocks.len(), 1);
        assert_eq!(table.blocks[0].id, "b");
    }

    #[test]
    fn remove_drops_both_table_and_payload() {
        let mut idx = AnchorIndex::new();
        let md = "para ^id\n";
        idx.update_file("n.md", md, extract_anchors(md));
        idx.remove_file("n.md");
        assert!(idx.anchors_for("n.md").is_none());
        assert!(!idx.snapshot_payload().contains_key("n.md"));
    }
}
