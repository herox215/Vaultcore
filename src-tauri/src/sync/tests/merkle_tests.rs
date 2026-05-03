//! TDD coverage for #420 Merkle reconciliation.

use std::sync::Arc;

use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use tempfile::TempDir;

use crate::sync::clock::TestClock;
use crate::sync::history::HistoryConfig;
use crate::sync::merkle::{diff_paths, hash_file_content, MerkleNode, MerkleTree, NodeKind};
use crate::sync::state::SyncState;

const VAULT: &str = "vault-uuid";

fn open_state(tmp: &TempDir) -> Arc<SyncState> {
    Arc::new(
        SyncState::open_with(
            tmp.path(),
            "SELFPEER".into(),
            Arc::new(TestClock::new(1_700_000_000)),
            HistoryConfig::default(),
        )
        .unwrap(),
    )
}

#[test]
fn merkle_root_changes_only_when_content_changes() {
    let tmp = TempDir::new().unwrap();
    let state = open_state(&tmp);
    let tree = MerkleTree::new(&state, VAULT);

    tree.upsert_file("notes/a.md", hash_file_content(b"hello")).unwrap();
    let r1 = tree.root().unwrap().expect("root after first upsert");

    // Re-upsert with the same content → identical root.
    tree.upsert_file("notes/a.md", hash_file_content(b"hello")).unwrap();
    let r2 = tree.root().unwrap().unwrap();
    assert_eq!(r1, r2, "identical content must not change root");

    // Different content → different root.
    tree.upsert_file("notes/a.md", hash_file_content(b"world")).unwrap();
    let r3 = tree.root().unwrap().unwrap();
    assert_ne!(r1, r3, "content change must propagate to root");

    // Adding a sibling under the same folder → different root.
    tree.upsert_file("notes/b.md", hash_file_content(b"second")).unwrap();
    let r4 = tree.root().unwrap().unwrap();
    assert_ne!(r3, r4);

    // Removing the sibling → root reverts to r3.
    tree.remove_file("notes/b.md").unwrap();
    let r5 = tree.root().unwrap().unwrap();
    assert_eq!(r3, r5, "removing a file must restore the prior root");
}

/// Property test: incremental upserts must produce the same root as a
/// full rebuild from the final file set, for any randomized order.
#[test]
fn merkle_incremental_update_matches_full_recompute() {
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    for trial in 0..16 {
        let tmp = TempDir::new().unwrap();
        let state = open_state(&tmp);
        let tree = MerkleTree::new(&state, VAULT);

        // Random vault: 3-25 files spread across 1-4 dirs.
        let n_files = rng.gen_range(3..=25);
        let mut files: Vec<(String, [u8; 32])> = (0..n_files)
            .map(|i| {
                let depth = rng.gen_range(0..=2);
                let mut path = String::new();
                for _ in 0..depth {
                    let dir = rng.gen_range(0..=3);
                    path.push_str(&format!("d{dir}/"));
                }
                path.push_str(&format!("note-{trial}-{i}.md"));
                let content: Vec<u8> = (0..rng.gen_range(1..32)).map(|_| rng.r#gen()).collect();
                (path, hash_file_content(&content))
            })
            .collect();

        // Path-collision dedup.
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files.dedup_by(|a, b| a.0 == b.0);

        // Apply incrementally in a randomized order.
        let mut order: Vec<usize> = (0..files.len()).collect();
        order.shuffle(&mut rng);
        for &i in &order {
            tree.upsert_file(&files[i].0, files[i].1).unwrap();
        }
        let incremental = tree.root().unwrap().unwrap();

        // Full rebuild from the same input.
        let other_tmp = TempDir::new().unwrap();
        let state2 = open_state(&other_tmp);
        let tree2 = MerkleTree::new(&state2, VAULT);
        tree2.rebuild_full(files.iter().cloned()).unwrap();
        let full = tree2.root().unwrap().unwrap();

        assert_eq!(
            incremental, full,
            "trial {trial}: incremental != full rebuild on input {files:?}"
        );
    }
}

#[test]
fn merkle_descent_finds_differing_paths_only() {
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    let state_a = open_state(&tmp_a);
    let state_b = open_state(&tmp_b);
    let tree_a = MerkleTree::new(&state_a, VAULT);
    let tree_b = MerkleTree::new(&state_b, VAULT);

    // Common files.
    for (path, content) in [
        ("notes/a.md", "alpha"),
        ("notes/b.md", "beta"),
        ("daily/2026-05-03.md", "today"),
    ] {
        let h = hash_file_content(content.as_bytes());
        tree_a.upsert_file(path, h).unwrap();
        tree_b.upsert_file(path, h).unwrap();
    }

    // Divergent file: A has "alpha-v2", B has "alpha".
    tree_a.upsert_file("notes/a.md", hash_file_content(b"alpha-v2")).unwrap();

    // File only in B: notes/c.md (peer is missing it on A's side).
    tree_b.upsert_file("notes/c.md", hash_file_content(b"gamma")).unwrap();

    // A descends and emits paths where it differs from B's view.
    let mut peer = |p: &str| tree_b.node(p).ok().flatten();
    let differing = diff_paths(&tree_a, &mut peer).unwrap();
    // Differing must include `notes/a.md` (content mismatch). It must
    // NOT include `notes/b.md` or `daily/2026-05-03.md`.
    assert!(differing.contains(&"notes/a.md".to_string()));
    assert!(!differing.contains(&"notes/b.md".to_string()));
    assert!(!differing.contains(&"daily/2026-05-03.md".to_string()));
}

#[test]
fn merkle_children_returns_direct_children_only() {
    let tmp = TempDir::new().unwrap();
    let state = open_state(&tmp);
    let tree = MerkleTree::new(&state, VAULT);
    tree.upsert_file("notes/a.md", hash_file_content(b"a")).unwrap();
    tree.upsert_file("notes/sub/b.md", hash_file_content(b"b")).unwrap();
    tree.upsert_file("daily/d.md", hash_file_content(b"d")).unwrap();

    let root_children: Vec<MerkleNode> = tree.children("").unwrap();
    let names: Vec<&str> = root_children.iter().map(|c| c.path.as_str()).collect();
    assert!(names.contains(&"notes"), "names: {names:?}");
    assert!(names.contains(&"daily"), "names: {names:?}");
    // No file leaves at root level.
    for c in &root_children {
        assert_eq!(c.kind, NodeKind::Folder, "root children must be folders, got {c:?}");
    }

    let notes_children: Vec<MerkleNode> = tree.children("notes").unwrap();
    let notes_names: Vec<&str> = notes_children.iter().map(|c| c.path.as_str()).collect();
    assert!(notes_names.contains(&"notes/a.md"));
    assert!(notes_names.contains(&"notes/sub"));
    // notes/sub/b.md is two levels deep — NOT in notes/'s direct children.
    assert!(!notes_names.contains(&"notes/sub/b.md"));
}

