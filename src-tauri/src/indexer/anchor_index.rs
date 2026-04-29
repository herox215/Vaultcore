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
    /// Pre-built wire-format payload — what `get_resolved_anchors` returns.
    /// We don't keep `AnchorTable` separately: only the payload is read
    /// downstream, and storing both doubles memory + risks drift.
    payload: HashMap<String, AnchorKeySet>,
}

impl AnchorIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the anchor data for a single file via raw inputs. Idempotent.
    /// Used by the watcher path (`UpdateLinks`) which holds the AnchorTable
    /// directly. Cold-start uses `update_file_with_payload` to skip the
    /// table-keeping that would balloon the cold-start buffer.
    pub fn update_file(&mut self, rel_path: &str, content: &str, table: AnchorTable) {
        let payload = build_anchor_key_set(content, &table);
        self.update_file_with_payload(rel_path, payload);
    }

    /// Replace the anchor data for a single file with a precomputed payload.
    /// Used by the cold-start flush so we never carry raw file contents
    /// past the per-file loop body.
    pub fn update_file_with_payload(&mut self, rel_path: &str, payload: AnchorKeySet) {
        self.payload.insert(rel_path.to_string(), payload);
    }

    /// Drop every anchor entry for a file (used on delete and rename-old).
    pub fn remove_file(&mut self, rel_path: &str) {
        self.payload.remove(rel_path);
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
    fn update_overwrites_previous_entry() {
        let mut idx = AnchorIndex::new();
        let md1 = "first ^a\n";
        let md2 = "second ^b\n";
        idx.update_file("note.md", md1, extract_anchors(md1));
        idx.update_file("note.md", md2, extract_anchors(md2));
        let payload = idx.snapshot_payload();
        let entry = payload.get("note.md").expect("entry must exist");
        assert_eq!(entry.blocks.len(), 1);
        assert_eq!(entry.blocks[0].id, "b");
    }

    #[test]
    fn remove_drops_payload() {
        let mut idx = AnchorIndex::new();
        let md = "para ^id\n";
        idx.update_file("n.md", md, extract_anchors(md));
        idx.remove_file("n.md");
        assert!(!idx.snapshot_payload().contains_key("n.md"));
    }

    #[test]
    fn update_file_with_payload_round_trips() {
        let mut idx = AnchorIndex::new();
        let md = "para ^id\n";
        let table = extract_anchors(md);
        let payload = super::super::anchors::build_anchor_key_set(md, &table);
        idx.update_file_with_payload("n.md", payload);
        let snap = idx.snapshot_payload();
        assert!(snap.contains_key("n.md"));
        assert_eq!(snap["n.md"].blocks[0].id, "id");
    }
}
