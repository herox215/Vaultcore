// Ticket #179 regression guard — `IndexCoordinator::index_vault` must read
// every `.md` file AT MOST ONCE per invocation. Before the fix, the indexer
// did a full second filesystem pass just to feed `LinkGraph::update_file` and
// `TagIndex::update_file`, doubling cold-start disk I/O on large vaults.
//
// These tests use a `#[cfg(test)]`-only read counter planted inside
// `indexer/mod.rs` (no trait refactor, no Fs abstraction). Tests interact
// with it via `reset_read_count()` / `read_count()` exported under
// `pub(crate)` visibility.
//
// Clippy's `await_holding_lock` + `type_complexity` fire on the test-only
// serialisation mutex and the hand-rolled snapshot tuple. Both are
// intentional in this tightly scoped test module (see `read_count_lock` and
// `BaselineSnapshot` below) and not worth refactoring: the lock only guards
// the global `READ_COUNT` atomic for the handful of tests in this file, and
// `BaselineSnapshot` is self-documenting at the call site.

#![cfg(test)]
#![allow(clippy::await_holding_lock)]
#![allow(clippy::type_complexity)]

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

use tempfile::TempDir;

use crate::indexer::{read_count, reset_read_count, IndexCoordinator};
use crate::indexer::link_graph::extract_links;
use crate::indexer::tag_index::extract_inline_tag_occurrences;

/// Global lock shared by every test in this module.
///
/// `READ_COUNT` lives in a process-wide atomic so tests running in parallel
/// would otherwise observe each others' reads. `cargo test` runs tests on
/// multiple threads by default; rather than force users to pass
/// `--test-threads=1`, the lock serialises any test that asserts on the
/// counter. `mock_app()` also allocates a MockRuntime webview per call so
/// keeping these sequential reduces peak memory too.
fn read_count_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Build a throwaway Tauri `AppHandle` the `index_vault` signature can accept.
///
/// `tauri::test::mock_app()` builds a full in-process `App<MockRuntime>` with
/// a no-op asset resolver and no real windows. We only need its `AppHandle`
/// so `index_vault` can call `.emit()` — the progress events are discarded.
fn mock_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
    tauri::test::mock_app().handle().clone()
}

/// Write a `.md` file at `vault/rel`, creating parents if needed.
fn write_md(vault: &Path, rel: &str, body: &str) {
    let abs = vault.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).expect("mkdir -p");
    }
    std::fs::write(&abs, body).expect("write md");
}

// ── Read-count assertions ────────────────────────────────────────────────────

#[tokio::test]
async fn index_vault_reads_each_file_at_most_once() {
    let _guard = read_count_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    // 20 deterministic `.md` files with varied content: wiki-links, tags,
    // frontmatter aliases, nested folders. The exact mix doesn't matter —
    // only that each file is read ONCE during `index_vault`.
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    const N: usize = 20;
    for i in 0..N {
        let body = format!(
            "---\naliases: [alias{i}]\n---\n# Title {i}\n\nSee [[note{next}]]\n#tag{i}\n",
            i = i,
            next = (i + 1) % N,
        );
        let rel = if i % 3 == 0 {
            format!("folder{}/note{}.md", i % 4, i)
        } else {
            format!("note{}.md", i)
        };
        write_md(vault, &rel, &body);
    }

    let coord = IndexCoordinator::new(vault).await.expect("new coord");
    reset_read_count();
    let handle = mock_handle();
    let info = coord
        .index_vault(vault, &handle)
        .await
        .expect("index_vault");
    assert_eq!(info.file_count, N, "file_count matches seeded files");

    let reads = read_count();
    assert_eq!(
        reads, N,
        "expected each of {N} files read exactly once, got {reads}"
    );
}

#[tokio::test]
async fn index_vault_all_current_still_single_read() {
    let _guard = read_count_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    // Running `index_vault` twice: the hash cache will report
    // `already_current == true` for every file on the second pass. The old
    // code still re-read each file once for hashing AND again for the
    // link/tag pass — 2N reads. After the fix the second run stays at N.
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    const N: usize = 10;
    for i in 0..N {
        write_md(
            vault,
            &format!("n{}.md", i),
            &format!("# N{}\n[[n{}]]\n#t{}\n", i, (i + 1) % N, i),
        );
    }

    let coord = IndexCoordinator::new(vault).await.expect("new coord");
    let handle = mock_handle();

    // First run seeds the hash cache.
    reset_read_count();
    coord.index_vault(vault, &handle).await.expect("run 1");
    assert_eq!(read_count(), N, "run 1 reads each file once");

    // Second run: hash-unchanged branch. Still at most one read per file.
    reset_read_count();
    coord.index_vault(vault, &handle).await.expect("run 2");
    let second = read_count();
    assert_eq!(
        second, N,
        "run 2 must not double-read already-current files (got {second})"
    );
}

#[tokio::test]
async fn index_vault_empty_vault() {
    let _guard = read_count_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    let coord = IndexCoordinator::new(vault).await.expect("new coord");
    reset_read_count();
    let handle = mock_handle();
    let info = coord.index_vault(vault, &handle).await.expect("empty");

    assert_eq!(info.file_count, 0, "no .md files => empty index");
    assert_eq!(read_count(), 0, "empty vault triggers zero reads");

    // Link graph + tag index must also be empty.
    let lg = coord.link_graph();
    let lg_guard = lg.lock().unwrap();
    assert_eq!(lg_guard.get_unresolved().len(), 0);
    drop(lg_guard);

    let ti = coord.tag_index();
    let ti_guard = ti.lock().unwrap();
    assert!(ti_guard.list_tags().is_empty());
}

#[tokio::test]
async fn index_vault_non_utf8_midvault() {
    let _guard = read_count_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    // 3 valid UTF-8 `.md` files + 1 binary `.md` with invalid UTF-8 bytes.
    // The binary file must be silently skipped (IDX-08) — no panic, no
    // entry in file_list, LinkGraph, or TagIndex. Reads attempted for the
    // bad file DO count toward the counter (the read itself happens and
    // then fails UTF-8 decoding), so the ceiling is N_total == 4.
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    write_md(vault, "a.md", "# A\n[[b]]\n#alpha\n");
    write_md(vault, "b.md", "# B\n[[c]]\n#beta\n");

    // Binary file — invalid UTF-8 sequence in the middle of the content.
    let binary_path = vault.join("binary.md");
    let mut bad: Vec<u8> = b"# before\n".to_vec();
    bad.extend_from_slice(&[0xFF, 0xFE, 0xFD, 0xFC]); // invalid UTF-8
    bad.extend_from_slice(b"\n# after\n");
    std::fs::write(&binary_path, &bad).unwrap();

    write_md(vault, "c.md", "# C\n[[a]]\n#gamma\n");

    let coord = IndexCoordinator::new(vault).await.expect("new coord");
    reset_read_count();
    let handle = mock_handle();
    let info = coord.index_vault(vault, &handle).await.expect("mixed utf8");

    assert_eq!(info.file_count, 3, "binary.md must not appear in file_list");
    assert!(
        !info.file_list.iter().any(|p| p == "binary.md"),
        "binary.md should be absent from file_list: {:?}",
        info.file_list
    );

    let reads = read_count();
    assert!(
        reads <= 4,
        "counter ≤ total candidate files: got {reads}, expected ≤ 4"
    );

    // LinkGraph: no outgoing entry for binary.md.
    let lg = coord.link_graph();
    let lg_guard = lg.lock().unwrap();
    assert!(
        lg_guard.outgoing_for("binary.md").is_none(),
        "binary.md must not appear as a link-graph source"
    );
    drop(lg_guard);

    // TagIndex: no tag entries attributable to binary.md.
    let ti = coord.tag_index();
    let ti_guard = ti.lock().unwrap();
    assert!(
        ti_guard.tags_for_file("binary.md").is_empty(),
        "binary.md must not appear in the tag index"
    );
}

// ── Baseline-parity test (post-fix still matches pre-fix observable state) ──

/// Same deterministic 10-file vault fixture used below. Kept in a helper so
/// the baseline and post-fix assertions operate on byte-identical input.
fn seed_baseline_vault(vault: &Path) {
    // Mix of resolved wiki-links, unresolved wiki-links, nested folders, tags.
    write_md(vault, "hub.md", "# Hub\n[[a]]\n[[missing-note]]\n#hubtag\n");
    write_md(vault, "a.md", "# A\n[[hub]]\n[[b]]\n#shared\n");
    write_md(vault, "b.md", "# B\n[[c]]\n#shared\n#solo-b\n");
    write_md(vault, "c.md", "# C\n[[hub]]\n");
    write_md(vault, "folder/d.md", "# D\n[[a]]\n[[folder/e]]\n#nested\n");
    write_md(vault, "folder/e.md", "# E\n[[d]]\n");
    write_md(vault, "folder/sub/f.md", "# F\n[[hub]]\n#deep\n");
    write_md(vault, "g.md", "# G\n[[hub|Hub Page]]\n#alias-link\n");
    write_md(vault, "h.md", "# H\n[[UnknownTarget]]\n");
    write_md(vault, "i.md", "# I\nplain text, no links, no tags\n");
}

/// Produce a deterministic fingerprint of the LinkGraph + TagIndex state
/// that captures every observable field the public API exposes.
fn snapshot_state(coord: &IndexCoordinator, all_rel_paths: &[String]) -> BaselineSnapshot {
    let lg = coord.link_graph();
    let lg_guard = lg.lock().unwrap();

    let mut backlinks: Vec<(String, usize)> = all_rel_paths
        .iter()
        .map(|p| (p.clone(), lg_guard.backlink_count(p)))
        .collect();
    backlinks.sort();

    let mut outgoing: Vec<(String, Vec<(Option<String>, String)>)> = all_rel_paths
        .iter()
        .map(|p| {
            let targets = lg_guard.outgoing_targets_for(p).unwrap_or_default();
            (p.clone(), targets)
        })
        .collect();
    outgoing.sort_by(|a, b| a.0.cmp(&b.0));

    let mut unresolved: Vec<(String, String, u32)> = lg_guard
        .get_unresolved()
        .into_iter()
        .map(|u| (u.source_path, u.target_raw, u.line_number))
        .collect();
    unresolved.sort();

    drop(lg_guard);

    let ti = coord.tag_index();
    let ti_guard = ti.lock().unwrap();

    let mut tags: Vec<(String, usize)> = ti_guard
        .list_tags()
        .into_iter()
        .map(|u| (u.tag, u.count))
        .collect();
    tags.sort();

    let mut per_file_tags: Vec<(String, Vec<String>)> = all_rel_paths
        .iter()
        .map(|p| (p.clone(), ti_guard.tags_for_file(p)))
        .collect();
    per_file_tags.sort_by(|a, b| a.0.cmp(&b.0));

    BaselineSnapshot {
        backlinks,
        outgoing,
        unresolved,
        tags,
        per_file_tags,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct BaselineSnapshot {
    /// (target_rel, backlink_count) sorted by target_rel
    backlinks: Vec<(String, usize)>,
    /// (source_rel, Vec<(resolved_target, target_raw)>) sorted by source_rel
    outgoing: Vec<(String, Vec<(Option<String>, String)>)>,
    /// (source_rel, target_raw, line_number) sorted
    unresolved: Vec<(String, String, u32)>,
    /// (tag, file_count) sorted by tag
    tags: Vec<(String, usize)>,
    /// (rel_path, Vec<tag>) sorted by rel_path
    per_file_tags: Vec<(String, Vec<String>)>,
}

#[tokio::test]
async fn link_graph_and_tag_index_unchanged_vs_baseline() {
    let _guard = read_count_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    // Builds two independent vaults with identical content, runs
    // `index_vault` on each, then asserts the two snapshots are byte-equal.
    //
    // This test is the correctness guard for the single-read refactor: it
    // doesn't run the *old* code (that would require the unmodified sources)
    // — instead it runs the *new* code twice and verifies determinism, then
    // relies on the structural assertions (`outgoing_targets_for`,
    // `backlink_count`, `get_unresolved`, `tags_for_file`, `list_tags`) to
    // catch any semantic drift from the pre-fix contract. The specific
    // values below were captured off the pre-fix code path.
    let tmp1 = TempDir::new().unwrap();
    seed_baseline_vault(tmp1.path());
    let coord1 = IndexCoordinator::new(tmp1.path()).await.unwrap();
    let handle1 = mock_handle();
    let info1 = coord1
        .index_vault(tmp1.path(), &handle1)
        .await
        .expect("baseline 1");
    let snap1 = snapshot_state(&coord1, &info1.file_list);

    let tmp2 = TempDir::new().unwrap();
    seed_baseline_vault(tmp2.path());
    let coord2 = IndexCoordinator::new(tmp2.path()).await.unwrap();
    let handle2 = mock_handle();
    let info2 = coord2
        .index_vault(tmp2.path(), &handle2)
        .await
        .expect("baseline 2");
    let snap2 = snapshot_state(&coord2, &info2.file_list);

    assert_eq!(snap1, snap2, "determinism: two identical vaults → equal state");

    // Additional concrete anchors so this test fails noisily if the
    // post-fix implementation ever mutates the observable contract.
    // hub.md has 3 incoming resolved links (a.md, c.md, folder/sub/f.md,
    // g.md uses `[[hub|alias]]` → also resolves to hub.md). 4 total.
    let hub_backlinks = snap1
        .backlinks
        .iter()
        .find(|(p, _)| p == "hub.md")
        .map(|(_, n)| *n)
        .unwrap_or(0);
    assert_eq!(hub_backlinks, 4, "hub.md: a,c,folder/sub/f,g all link here");

    // #shared appears in a.md and b.md, #solo-b only in b.md, #deep only
    // in folder/sub/f.md. `#hubtag` → hub.md, `#nested` → folder/d.md,
    // `#alias-link` → g.md.
    let tag_map: std::collections::HashMap<String, usize> =
        snap1.tags.iter().cloned().collect();
    assert_eq!(tag_map.get("shared").copied(), Some(2));
    assert_eq!(tag_map.get("solo-b").copied(), Some(1));
    assert_eq!(tag_map.get("deep").copied(), Some(1));
    assert_eq!(tag_map.get("hubtag").copied(), Some(1));
    assert_eq!(tag_map.get("nested").copied(), Some(1));
    assert_eq!(tag_map.get("alias-link").copied(), Some(1));

    // An unresolved link from hub.md → missing-note must surface in
    // get_unresolved() with the exact triplet the pre-fix code would emit.
    assert!(
        snap1.unresolved.iter().any(|(src, raw, _)| src == "hub.md"
            && raw == "missing-note"),
        "expected hub.md → missing-note in unresolved list: {:?}",
        snap1.unresolved
    );

    // An unresolved link from h.md → UnknownTarget must also surface.
    assert!(
        snap1.unresolved.iter().any(|(src, raw, _)| src == "h.md"
            && raw == "UnknownTarget"),
        "expected h.md → UnknownTarget in unresolved list: {:?}",
        snap1.unresolved
    );
}

// ── Compile-time smoke: helpers we rely on are reachable under test cfg ──
//
// The read-count helpers are `#[cfg(test)] pub(crate)`; a direct use is the
// cheapest way to catch an accidental visibility regression at compile time.
#[test]
fn read_count_helpers_are_reachable() {
    let _guard = read_count_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    reset_read_count();
    // Baseline is zero after reset.
    assert_eq!(read_count(), 0);
    // Keep `Ordering` in scope so a future refactor that drops it gets
    // picked up by the unused-import lint instead of silently compiling.
    let _ = Ordering::SeqCst;

    // Exercise the shared extraction helpers — the single-read pipeline
    // replaces pass 2's `extract_links` + `ti.update_file(…, &content)`
    // with in-pass-1 extraction via these same entry points.
    let _ = extract_links("# smoke\n[[x]]\n");
    let _ = extract_inline_tag_occurrences("# smoke\n#tag\n");
}
