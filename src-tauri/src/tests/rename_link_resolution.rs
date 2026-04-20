// Regression test for: in-folder wiki-link clicks create a root-level note
// instead of opening the renamed target.
//
// Scenario (from UAT, paraphrased):
//   - `folder/A.md` contains `[[B]]`
//   - `folder/B.md` exists
//   - The user renames `folder/B.md` → `folder/B-new.md`
//   - The link text in `folder/A.md` is rewritten to `[[B-new]]` (good)
//   - But clicking `[[B-new]]` creates `B-new.md` at the vault root instead of
//     opening `folder/B-new.md` (bug)
//
// Root-cause hypothesis this test pins down:
//   - The frontend click handler consults `get_resolved_links`, which is
//     derived from `FileIndex::all_relative_paths()`.
//   - `rename_file_impl` (src/commands/files.rs) renames on disk and records
//     both paths in `write_ignore`, suppressing the watcher's rename event.
//   - Because the watcher is suppressed, no `IndexCmd::{AddFile, DeleteFile}`
//     ever fires for the rename. The `FileIndex` keeps the stale OLD rel_path
//     (`folder/B.md`) and never learns about the NEW rel_path
//     (`folder/B-new.md`).
//   - `resolve_link("B-new", "folder/", &fi.all_relative_paths())` therefore
//     returns `None`, which the frontend interprets as "create at root".
//
// The test asserts the backend-resolver invariant: after a rename, the NEW
// rel_path must be resolvable from the perspective of an in-folder source.
// If this ever passes on current main, the bug is elsewhere (e.g. the
// frontend's `resolvedLinks` cache).

use crate::commands::files::rename_file_impl;
use crate::indexer::link_graph::resolve_link;
use crate::indexer::memory::{FileIndex, FileMeta};
use crate::VaultState;

use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

fn state_with_vault(root: &std::path::Path) -> VaultState {
    let canonical = fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(canonical);
    s
}

/// Seed the FileIndex the same way `IndexCoordinator::index_vault` does: one
/// entry per .md file, keyed by canonical absolute path, with a vault-relative
/// forward-slash string in `FileMeta.relative_path`.
fn seed_file_index(fi: &mut FileIndex, vault_root: &std::path::Path, rel_paths: &[&str]) {
    let canonical = fs::canonicalize(vault_root).unwrap();
    for rel in rel_paths {
        let abs = canonical.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        fi.insert(
            abs,
            FileMeta {
                relative_path: (*rel).to_string(),
                hash: "seed".to_string(),
                title: rel.to_string(),
                aliases: Vec::new(),
            },
        );
    }
}

/// Regression guard: `[[B-new]]` clicked from `folder/A.md` must resolve to
/// `folder/B-new.md`, not fall through to the frontend's create-at-root
/// fallback. Fails today because `rename_file_impl` does not update the
/// in-memory `FileIndex` — the rel_path map the click handler consults keeps
/// the stale OLD path.
#[test]
fn rename_keeps_in_folder_wiki_link_resolvable() {
    let dir = tempdir().unwrap();
    let vault_root = dir.path();

    // Build vault on disk: folder/A.md → [[B]], folder/B.md
    let folder = vault_root.join("folder");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("A.md"), "See [[B]] for context.\n").unwrap();
    fs::write(folder.join("B.md"), "# B\n").unwrap();

    let state = state_with_vault(vault_root);

    // Mirror what `IndexCoordinator::index_vault` does on vault open: build a
    // populated FileIndex so the click-time resolver (`get_resolved_links` →
    // `resolve_link` over FileIndex::all_relative_paths) has realistic input.
    let mut fi = FileIndex::new();
    seed_file_index(&mut fi, vault_root, &["folder/A.md", "folder/B.md"]);

    // Pre-rename sanity: the click-time resolver finds `folder/B.md` from
    // inside `folder/`. If this fails, the test fixture is wrong.
    let all_pre: Vec<String> = fi.all_relative_paths();
    assert_eq!(
        resolve_link("B", "folder/", &all_pre).as_deref(),
        Some("folder/B.md"),
        "pre-rename fixture broken — resolver should find folder/B.md from folder/",
    );

    // Perform the rename through the production code path.
    let old_abs = folder.join("B.md");
    let rename_result = rename_file_impl(
        &state,
        old_abs.to_string_lossy().into_owned(),
        "B-new.md".into(),
    )
    .expect("rename_file_impl must succeed");

    // Disk is renamed (sanity — not the assertion under test).
    assert!(folder.join("B-new.md").exists(), "disk rename must succeed");
    assert!(!old_abs.exists(), "old path must be gone on disk");
    assert!(rename_result.new_path.ends_with("B-new.md"));

    // === REGRESSION ASSERTION ===
    //
    // A user clicking `[[B-new]]` from inside `folder/A.md` triggers the
    // click handler, which looks up `get_resolved_links()`. That command is
    // built from `FileIndex::all_relative_paths()` via `resolve_link`.
    // After the rename we require the NEW path to be resolvable. This is
    // exactly what the failing UAT step expects; the current implementation
    // returns `None`, so the frontend falls into the create-at-root branch.
    let all_post: Vec<String> = fi.all_relative_paths();
    let resolved = resolve_link("B-new", "folder/", &all_post);
    assert_eq!(
        resolved.as_deref(),
        Some("folder/B-new.md"),
        "clicking [[B-new]] from folder/A.md must resolve to folder/B-new.md, \
         not fall through to a root-level create. FileIndex after rename: {:?}",
        all_post,
    );

    // Tightening guard: the stale OLD rel_path must NOT linger in FileIndex
    // either — otherwise a stem collision (`B`) with a pre-existing root-level
    // `B.md` could re-route backlinks to the dead entry.
    let has_stale_old = fi.contains_rel("folder/B.md");
    assert!(
        !has_stale_old,
        "FileIndex must not retain the renamed-away rel_path folder/B.md",
    );
}

// Silence unused import warnings in the rare case PathBuf isn't needed — keep
// the import so future assertions can reach for it without re-threading.
#[allow(dead_code)]
fn _keep_pathbuf_in_scope() -> PathBuf {
    PathBuf::new()
}
