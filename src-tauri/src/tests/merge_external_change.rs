// Issue #339: merge_external_change must be an authoritative write path —
// on "clean" it writes the merged bytes to disk, records write_ignore,
// and dispatches UpdateLinks / UpdateTags / Tantivy AddFile + Commit so
// the in-memory indexes never trail the on-disk state.
//
// Tests drive `merge_external_change_impl` in commands/vault.rs directly
// (tauri::State can't be constructed outside a running Tauri app, see
// tests/files.rs:16-20 for the convention).

#![cfg(test)]
#![allow(clippy::await_holding_lock)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use tokio::time::{sleep, timeout};

use crate::error::VaultError;
use crate::indexer::{IndexCmd, IndexCoordinator};
use crate::VaultState;

// ─── harness helpers ────────────────────────────────────────────────────────

fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

/// Build a VaultState with no IndexCoordinator wired up. Used for test #12
/// (channel-absent) and for the out-of-vault guard test where no index
/// operations are expected.
fn state_with_vault_no_coord(root: &Path) -> VaultState {
    let canonical = std::fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(crate::storage::VaultHandle::Posix(canonical));
    s
}

/// Build a VaultState with a fresh IndexCoordinator attached, sharing the
/// same `file_index` Arc (mirrors what `open_vault` does in production).
/// Runs a single `index_vault` pass so link/tag state is primed before the
/// test drives merges.
async fn state_with_vault_and_coord(root: &Path) -> VaultState {
    let canonical = std::fs::canonicalize(root).unwrap();
    let state = VaultState::default();
    *state.current_vault.lock().unwrap() = Some(crate::storage::VaultHandle::Posix(canonical.clone()));

    let coord =
        IndexCoordinator::new_with_file_index(&canonical, Arc::clone(&state.file_index))
            .await
            .expect("coord new");

    // Seed LinkGraph + TagIndex + Tantivy with the vault's current contents
    // so the tests can assert deltas against a known baseline.
    let handle = tauri::test::mock_app().handle().clone();
    coord
        .index_vault(&canonical, &handle)
        .await
        .expect("initial index_vault");

    *state.index_coordinator.lock().unwrap() = Some(coord);
    state
}

/// Write a `.md` file at `vault/rel`, creating parents as needed.
fn write_md(vault: &Path, rel: &str, body: &str) -> PathBuf {
    let abs = vault.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).expect("mkdir -p");
    }
    std::fs::write(&abs, body).expect("write md");
    abs
}

/// Flush the IndexCoordinator's command queue by sending Commit + spinning
/// until the mpsc has drained. IndexCmd processing is FIFO, so once our
/// Commit lands in the coordinator's reader the prior UpdateLinks /
/// UpdateTags commands have been applied to the in-memory indexes.
async fn drain(state: &VaultState) {
    let tx = {
        let guard = state.index_coordinator.lock().unwrap();
        guard.as_ref().map(|c| c.tx.clone())
    };
    if let Some(tx) = tx {
        let _ = tx.send(IndexCmd::Commit).await;
    }
    // Minimal yield so the worker task picks the command up.
    sleep(Duration::from_millis(50)).await;
}

/// Bounded-poll barrier: evaluate `cond` every 25 ms up to 2 s, return when it
/// yields `true` or panic with a diagnostic message on timeout.
async fn wait_for<F: Fn() -> bool>(desc: &str, cond: F) {
    let res = timeout(Duration::from_secs(2), async {
        loop {
            if cond() {
                return;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(res.is_ok(), "wait_for timed out: {desc}");
}

// Tests drive the real `_impl` in commands/vault.rs directly — no mirror
// needed because merge_external_change_impl is `pub(crate)`.
use crate::commands::vault::{merge_external_change_impl, MergeCommandResult};

/// Destructure `MergeCommandResult` into flat `(outcome, merged_content,
/// new_hash)` triples so tests can assert without repeating a match at
/// every call site. The tagged enum is the source of truth on the
/// production side (see `commands/vault.rs::MergeCommandResult`); this
/// helper just saves boilerplate.
fn parts(r: &MergeCommandResult) -> (&'static str, &str, Option<&str>) {
    match r {
        MergeCommandResult::Clean {
            merged_content,
            new_hash,
        } => ("clean", merged_content.as_str(), Some(new_hash.as_str())),
        MergeCommandResult::Conflict { merged_content } => {
            ("conflict", merged_content.as_str(), None)
        }
    }
}

// ─── Test 1: add link ────────────────────────────────────────────────────────

#[test]
fn merge_clean_external_add_links_refreshes_backlinks() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        write_md(vault, "A.md", "# A\n");
        let b_abs = write_md(vault, "B.md", "[[A]]\n");

        let state = state_with_vault_and_coord(vault).await;

        // External tool adds a second link pointing at an unresolved target "C".
        let external = "[[A]]\n[[C]]\n";
        std::fs::write(&b_abs, external).unwrap();

        // Editor buffer still reflects the pre-external state.
        let editor = "[[A]]\n";
        let base = "[[A]]\n";

        let result = merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            editor.to_string(),
            base.to_string(),
        )
        .await
        .expect("merge ok");

        let (outcome, merged, _) = parts(&result);
        assert_eq!(outcome, "clean");
        assert_eq!(merged, external);

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().expect("coord present");
        let lg = coord.link_graph();

        wait_for("B.md outgoing contains A and C", || {
            let lg_guard = lg.lock().unwrap();
            let targets = lg_guard.outgoing_targets_for("B.md").unwrap_or_default();
            let raws: Vec<&str> = targets.iter().map(|(_, raw)| raw.as_str()).collect();
            raws.contains(&"A") && raws.contains(&"C")
        })
        .await;

        let lg_guard = lg.lock().unwrap();
        let unresolved = lg_guard.get_unresolved();
        assert!(
            unresolved
                .iter()
                .any(|u| u.source_path == "B.md" && u.target_raw == "C"),
            "expected B.md → C in unresolved, got {:?}",
            unresolved,
        );
    });
}

// ─── Test 2: remove link ─────────────────────────────────────────────────────

#[test]
fn merge_clean_external_remove_link_shrinks_backlinks() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        write_md(vault, "A.md", "# A\n");
        let b_abs = write_md(vault, "B.md", "[[A]]\n[[C]]\n");

        let state = state_with_vault_and_coord(vault).await;

        // External tool strips B.md to just a title — links gone.
        let external = "# B only\n";
        std::fs::write(&b_abs, external).unwrap();

        let result = merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "[[A]]\n[[C]]\n".to_string(),
            "[[A]]\n[[C]]\n".to_string(),
        )
        .await
        .expect("merge ok");

        assert_eq!(parts(&result).0, "clean");

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().expect("coord present");
        let lg = coord.link_graph();
        let fi = coord.file_index();

        wait_for("A.md backlinks drop to zero", || {
            let lg_guard = lg.lock().unwrap();
            let fi_guard = fi.read().unwrap();
            lg_guard.get_backlinks("A.md", &fi_guard).is_empty()
        })
        .await;

        let lg_guard = lg.lock().unwrap();
        assert!(
            !lg_guard
                .get_unresolved()
                .iter()
                .any(|u| u.source_path == "B.md" && u.target_raw == "C"),
            "C should no longer appear as unresolved from B.md",
        );
    });
}

// ─── Test 3: add tag ─────────────────────────────────────────────────────────

#[test]
fn merge_clean_external_tag_add_refreshes_tag_index() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        let b_abs = write_md(vault, "B.md", "# B\n");

        let state = state_with_vault_and_coord(vault).await;

        let external = "# B\n#new-tag\n";
        std::fs::write(&b_abs, external).unwrap();

        merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "# B\n".to_string(),
            "# B\n".to_string(),
        )
        .await
        .expect("merge ok");

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().expect("coord present");
        let ti = coord.tag_index();

        wait_for("new-tag indexed on B.md", || {
            let ti_guard = ti.lock().unwrap();
            ti_guard
                .tags_for_file("B.md")
                .iter()
                .any(|t| t == "new-tag")
        })
        .await;

        let ti_guard = ti.lock().unwrap();
        let count = ti_guard
            .list_tags()
            .into_iter()
            .find(|u| u.tag == "new-tag")
            .map(|u| u.count)
            .unwrap_or(0);
        assert_eq!(count, 1, "global tag count for new-tag == 1");
    });
}

// ─── Test 4: remove tag ──────────────────────────────────────────────────────

#[test]
fn merge_clean_external_tag_remove_refreshes_tag_index() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        let b_abs = write_md(vault, "B.md", "# B\n#old-tag\n");

        let state = state_with_vault_and_coord(vault).await;

        let external = "# B\n";
        std::fs::write(&b_abs, external).unwrap();

        merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "# B\n#old-tag\n".to_string(),
            "# B\n#old-tag\n".to_string(),
        )
        .await
        .expect("merge ok");

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().expect("coord present");
        let ti = coord.tag_index();

        wait_for("old-tag no longer indexed on B.md", || {
            let ti_guard = ti.lock().unwrap();
            !ti_guard
                .tags_for_file("B.md")
                .iter()
                .any(|t| t == "old-tag")
        })
        .await;

        let ti_guard = ti.lock().unwrap();
        let still_there = ti_guard.list_tags().into_iter().any(|u| u.tag == "old-tag");
        assert!(!still_there, "old-tag should be gone from the global list");
    });
}

// ─── Test 5: authoritative disk write ────────────────────────────────────────

#[test]
fn merge_clean_writes_merged_bytes_to_disk() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        let b_abs = write_md(vault, "B.md", "base\n");

        let state = state_with_vault_and_coord(vault).await;

        // External adds a line; editor adds a different line. Three-way
        // merge resolves cleanly (non-overlapping additions).
        let external = "base\nexternal line\n";
        std::fs::write(&b_abs, external).unwrap();

        let editor = "editor line\nbase\n";
        let base = "base\n";

        let result = merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            editor.to_string(),
            base.to_string(),
        )
        .await
        .expect("merge ok");

        let (outcome, merged, _) = parts(&result);
        assert_eq!(outcome, "clean");

        let on_disk = std::fs::read_to_string(&b_abs).unwrap();
        assert_eq!(
            on_disk, merged,
            "disk must match merged_content after authoritative write",
        );
    });
}

// ─── Test 6: write_ignore recorded before disk write ─────────────────────────

#[test]
fn merge_clean_records_write_ignore_before_disk_write() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        let b_abs = write_md(vault, "B.md", "base\n");

        let state = state_with_vault_and_coord(vault).await;

        let external = "base\nexternal\n";
        std::fs::write(&b_abs, external).unwrap();

        merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "editor\nbase\n".to_string(),
            "base\n".to_string(),
        )
        .await
        .expect("merge ok");

        let canonical = std::fs::canonicalize(&b_abs).unwrap();
        let guard = state.write_ignore.lock().unwrap();
        assert!(
            guard.should_ignore(&canonical),
            "write_ignore must record canonical path so the resulting watcher event is suppressed",
        );
    });
}

// ─── Test 7: new_hash contract ───────────────────────────────────────────────

#[test]
fn merge_clean_returns_hash_of_merged_content() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        let b_abs = write_md(vault, "B.md", "base\n");

        let state = state_with_vault_and_coord(vault).await;

        let external = "base\nexternal\n";
        std::fs::write(&b_abs, external).unwrap();

        let result = merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "editor\nbase\n".to_string(),
            "base\n".to_string(),
        )
        .await
        .expect("merge ok");

        let (_, merged, new_hash) = parts(&result);
        let expected = crate::hash::hash_bytes(merged.as_bytes());
        assert_eq!(
            new_hash,
            Some(expected.as_str()),
            "new_hash must equal SHA-256 of merged_content on clean",
        );
    });
}

// ─── Test 8: frontmatter alias dropped ───────────────────────────────────────

#[test]
fn merge_clean_frontmatter_alias_drop_refreshes_resolver() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        // Aliases are normalized to lowercase in FileMeta — see
        // frontmatter.rs::aliases_list_form test fixture.
        let b_abs = write_md(
            vault,
            "B.md",
            "---\naliases: [beealias]\n---\n# B\n",
        );

        let state = state_with_vault_and_coord(vault).await;

        // Precondition: alias IS indexed after the initial index_vault pass.
        // Without this guard the post-merge assertion would pass trivially
        // even if the dispatch fix never runs.
        {
            let coord_guard = state.index_coordinator.lock().unwrap();
            let coord = coord_guard.as_ref().unwrap();
            let fi = coord.file_index();
            let fi_guard = fi.read().unwrap();
            let aliases = fi_guard.aliases_for_rel("B.md");
            assert!(
                aliases.iter().any(|a| a == "beealias"),
                "precondition failed: initial index_vault must have seeded alias, got {:?}",
                aliases,
            );
        }

        // External removes the alias.
        let external = "# B\n";
        std::fs::write(&b_abs, external).unwrap();

        merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "---\naliases: [beealias]\n---\n# B\n".to_string(),
            "---\naliases: [beealias]\n---\n# B\n".to_string(),
        )
        .await
        .expect("merge ok");

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().expect("coord present");
        let fi = coord.file_index();

        wait_for("beealias dropped from FileMeta", || {
            let fi_guard = fi.read().unwrap();
            let aliases = fi_guard.aliases_for_rel("B.md");
            !aliases.iter().any(|a| a == "beealias")
        })
        .await;
    });
}

// ─── Test 9: conflict path — no write, no dispatch ───────────────────────────

#[test]
fn merge_conflict_keeps_local_and_skips_disk_write_and_dispatch() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        // Overlapping edits on the same line → merge conflict.
        let b_abs = write_md(vault, "B.md", "common line\n");

        let state = state_with_vault_and_coord(vault).await;

        let external = "external flavour\n";
        std::fs::write(&b_abs, external).unwrap();

        let editor = "editor flavour\n";
        let base = "common line\n";

        let result = merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            editor.to_string(),
            base.to_string(),
        )
        .await
        .expect("merge ok");

        let (outcome, merged, new_hash) = parts(&result);
        assert_eq!(outcome, "conflict");
        assert_eq!(merged, editor);
        assert!(
            new_hash.is_none(),
            "new_hash must be None on conflict — backend did not write",
        );

        // Disk still holds the external content (the backend did NOT write).
        let on_disk = std::fs::read_to_string(&b_abs).unwrap();
        assert_eq!(on_disk, external);

        // write_ignore was NOT populated (conflict path short-circuits).
        let canonical = std::fs::canonicalize(&b_abs).unwrap();
        let guard = state.write_ignore.lock().unwrap();
        assert!(
            !guard.should_ignore(&canonical),
            "conflict path must not record write_ignore",
        );
    });
}

// ─── Test 10: non-md defensive branch ────────────────────────────────────────

#[test]
fn merge_non_md_file_does_not_dispatch_index() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        // .canvas files aren't indexed into LinkGraph / TagIndex. If the
        // IPC layer ever fuzzes a .canvas path into merge_external_change
        // we must not corrupt the graph with canvas-derived text.
        let c_abs = vault.join("board.canvas");
        std::fs::write(&c_abs, "base\n").unwrap();

        let state = state_with_vault_and_coord(vault).await;

        let external = "base\nchanged\n";
        std::fs::write(&c_abs, external).unwrap();

        let result = merge_external_change_impl(
            &state,
            c_abs.to_string_lossy().into_owned(),
            "base\n".to_string(),
            "base\n".to_string(),
        )
        .await
        .expect("merge ok");

        assert_eq!(parts(&result).0, "clean");

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().expect("coord present");
        let lg = coord.link_graph();
        let lg_guard = lg.lock().unwrap();
        assert!(
            lg_guard.outgoing_for("board.canvas").is_none(),
            "non-md path must not appear as a link-graph source",
        );
    });
}

// ─── Test 11: path outside vault ─────────────────────────────────────────────

#[test]
fn merge_outside_vault_returns_permission_denied_and_does_not_dispatch() {
    tokio_test_block_on(async {
        let vault = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let evil = outside.path().join("secret.md");
        std::fs::write(&evil, "pwn\n").unwrap();

        let state = state_with_vault_no_coord(vault.path());

        let result = merge_external_change_impl(
            &state,
            evil.to_string_lossy().into_owned(),
            "editor\n".to_string(),
            "base\n".to_string(),
        )
        .await;

        match result {
            Err(VaultError::PermissionDenied { .. }) => {}
            other => panic!("expected PermissionDenied, got {:?}", other),
        }

        // Disk unchanged.
        assert_eq!(std::fs::read_to_string(&evil).unwrap(), "pwn\n");
    });
}

// ─── Test 12 (bis): delete evicts the deleted file from LinkGraph + TagIndex ─

#[test]
fn delete_evicts_deleted_file_from_link_graph_and_tag_index() {
    // Covers the #339 audit gap: before the fix, delete_file recorded
    // write_ignore and moved the file to .trash but never dispatched
    // RemoveLinks / RemoveTags, leaving the graphs stale.
    //
    // Drives `delete_file_impl` directly — dispatch lives inside `_impl`
    // (see commands/files.rs::delete_file_impl), so this test covers the
    // exact production contract the tauri wrapper exercises, not a
    // side-channel of manually-chained helpers.
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        // A.md carries its own tags so we can assert both link-graph AND
        // tag-index eviction for the deleted file.
        let a_abs = write_md(vault, "A.md", "# A\n[[B]]\n#alpha\n#shared\n");
        write_md(vault, "B.md", "[[A]]\n#shared\n");

        let state = state_with_vault_and_coord(vault).await;

        // Precondition: indexes reflect the seeded content. Without this
        // the post-delete assertions could pass trivially on an empty
        // graph. We assert every piece the fix is supposed to evict.
        {
            let coord_guard = state.index_coordinator.lock().unwrap();
            let coord = coord_guard.as_ref().unwrap();
            let lg = coord.link_graph();
            let ti = coord.tag_index();

            let lg_guard = lg.lock().unwrap();
            assert!(
                lg_guard.outgoing_for("A.md").is_some(),
                "A.md must be a link-graph source pre-delete",
            );
            drop(lg_guard);

            let ti_guard = ti.lock().unwrap();
            assert!(
                ti_guard.tags_for_file("A.md").iter().any(|t| t == "alpha"),
                "A.md must carry #alpha pre-delete",
            );
            assert_eq!(
                ti_guard
                    .list_tags()
                    .into_iter()
                    .find(|u| u.tag == "shared")
                    .map(|u| u.count)
                    .unwrap_or(0),
                2,
                "#shared must be on both files pre-delete",
            );
        }

        // Drive the real production contract: delete_file_impl performs
        // the disk rename AND the index dispatch. If a future change
        // removes the dispatch from _impl, the assertions below break.
        crate::commands::files::delete_file_impl(&state, a_abs.to_string_lossy().into_owned())
            .await
            .expect("delete ok");

        drain(&state).await;

        let coord_guard = state.index_coordinator.lock().unwrap();
        let coord = coord_guard.as_ref().unwrap();
        let lg = coord.link_graph();
        let ti = coord.tag_index();

        // A.md evicted from LinkGraph: no outgoing, no tag entries.
        wait_for("A.md dropped from link graph", || {
            lg.lock().unwrap().outgoing_for("A.md").is_none()
        })
        .await;
        wait_for("A.md dropped from tag index", || {
            ti.lock().unwrap().tags_for_file("A.md").is_empty()
        })
        .await;

        // Global tag counts shrink: #alpha is gone entirely, #shared drops to 1.
        let ti_guard = ti.lock().unwrap();
        assert!(
            !ti_guard.list_tags().iter().any(|u| u.tag == "alpha"),
            "#alpha should be gone from the global list",
        );
        assert_eq!(
            ti_guard
                .list_tags()
                .into_iter()
                .find(|u| u.tag == "shared")
                .map(|u| u.count)
                .unwrap_or(0),
            1,
            "#shared count must drop to 1 (only B.md remains)",
        );

        // Incoming edge from B.md → A.md is still present in LinkGraph,
        // because RemoveLinks only evicts A as a SOURCE. Re-resolving
        // every file that pointed at A is a separate responsibility
        // (cascade re-resolution on delete) and isn't what #339 fixes —
        // we assert the incoming-edge shape here to lock the CURRENT
        // contract in place, so a future cascade-resolution change
        // deliberately breaks this assertion and forces a re-read.
        let lg_guard = lg.lock().unwrap();
        let incoming = lg_guard
            .incoming_for("A.md")
            .cloned()
            .unwrap_or_default();
        assert!(
            incoming.iter().any(|src| src == "B.md"),
            "B.md's [[A]] edge is expected to remain in LinkGraph after A's deletion \
             (cascade re-resolution is out of #339 scope); got incoming = {incoming:?}",
        );
    });
}

// ─── Test 12: channel absent (no IndexCoordinator) ──────────────────────────

#[test]
fn merge_channel_absent_does_not_error() {
    tokio_test_block_on(async {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();
        let b_abs = write_md(vault, "B.md", "base\n");

        let state = state_with_vault_no_coord(vault);

        let external = "base\nexternal\n";
        std::fs::write(&b_abs, external).unwrap();

        let result = merge_external_change_impl(
            &state,
            b_abs.to_string_lossy().into_owned(),
            "editor\nbase\n".to_string(),
            "base\n".to_string(),
        )
        .await;

        // Must succeed even with no coordinator — dispatches no-op when
        // the coordinator isn't attached (see dispatch_self_write contract).
        assert!(result.is_ok(), "merge must not error without a coordinator");
        let r = result.unwrap();
        assert_eq!(parts(&r).0, "clean");
    });
}
