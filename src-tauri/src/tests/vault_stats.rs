// VAULT-02 / VAULT-04 / VAULT-05 / VAULT-06 tests — drive the pure helpers
// exposed by commands::vault directly. The `#[tauri::command]` wrappers that
// depend on `tauri::AppHandle` / `tauri::State` are exercised indirectly via
// the `get_vault_stats` command (which takes only a `String`).

use crate::commands::vault::{
    collect_file_list, count_md_files, format_iso8601_utc, push_recent_vault_to, RecentVault,
};
use std::fs;
use tempfile::tempdir;

// --- VAULT-06: count_md_files --------------------------------------------

#[test]
fn get_vault_stats_counts_md_files() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "").unwrap();
    fs::write(dir.path().join("b.md"), "").unwrap();
    fs::write(dir.path().join("c.txt"), "").unwrap(); // ignored — wrong ext
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/d.md"), "").unwrap();
    assert_eq!(count_md_files(dir.path()), 3);
}

#[test]
fn get_vault_stats_skips_dot_dirs() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.md"), "").unwrap();
    fs::create_dir(dir.path().join(".obsidian")).unwrap();
    fs::write(dir.path().join(".obsidian/workspace.md"), "").unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join(".git/config.md"), "").unwrap();
    assert_eq!(count_md_files(dir.path()), 1);
}

// --- VAULT-02: recent-vaults round trip -----------------------------------

#[test]
fn recent_vaults_round_trip() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("recent-vaults.json");
    let vaults = push_recent_vault_to(&file, "/a", "1970-01-01T00:00:00Z".into()).unwrap();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].path, "/a");
    // Read-back via a fresh push (exercises the deserialize path)
    let vaults = push_recent_vault_to(&file, "/b", "1970-01-01T00:00:01Z".into()).unwrap();
    assert_eq!(vaults.len(), 2);
    assert_eq!(vaults[0].path, "/b"); // newest first
    assert_eq!(vaults[1].path, "/a");
}

// --- VAULT-04: eviction + dedupe ------------------------------------------

#[test]
fn recent_vaults_eviction_caps_at_ten() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("recent-vaults.json");
    for i in 0..15 {
        push_recent_vault_to(
            &file,
            &format!("/p{}", i),
            format!("1970-01-01T00:00:{:02}Z", i),
        )
        .unwrap();
    }
    let vaults =
        push_recent_vault_to(&file, "/final", "2026-04-11T00:00:00Z".into()).unwrap();
    assert_eq!(vaults.len(), 10);
    assert_eq!(vaults[0].path, "/final");
    // The oldest entries (/p0../p5) should be evicted
    assert!(!vaults.iter().any(|v| v.path == "/p0"));
    assert!(!vaults.iter().any(|v| v.path == "/p5"));
}

#[test]
fn recent_vaults_dedupe_moves_to_front() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("recent-vaults.json");
    push_recent_vault_to(&file, "/a", "1970-01-01T00:00:01Z".into()).unwrap();
    push_recent_vault_to(&file, "/b", "1970-01-01T00:00:02Z".into()).unwrap();
    let vaults = push_recent_vault_to(&file, "/a", "1970-01-01T00:00:03Z".into()).unwrap();
    assert_eq!(vaults.len(), 2);
    assert_eq!(vaults[0].path, "/a"); // re-added at front
    assert_eq!(vaults[1].path, "/b");
    // last_opened timestamp was refreshed, not preserved
    assert_eq!(vaults[0].last_opened, "1970-01-01T00:00:03Z");
}

// --- VAULT-05: missing-path fallback --------------------------------------

#[test]
fn open_vault_returns_vault_unavailable_for_missing_path() {
    // get_vault_stats mirrors the open_vault unreachable branch for this test.
    let result = tokio_test_block_on(crate::commands::vault::get_vault_stats(
        "/definitely/does/not/exist/vaultcore-test".to_string(),
    ));
    match result {
        Err(crate::error::VaultError::VaultUnavailable { path }) => {
            assert!(path.contains("definitely"));
        }
        other => panic!("expected VaultUnavailable, got {:?}", other),
    }
}

// --- ISO-8601 formatter pin test ------------------------------------------

#[test]
fn format_iso8601_utc_matches_rfc3339() {
    // 2026-04-11T00:00:00Z → epoch 1775865600
    assert_eq!(format_iso8601_utc(1_775_865_600), "2026-04-11T00:00:00Z");
    // Unix epoch itself
    assert_eq!(format_iso8601_utc(0), "1970-01-01T00:00:00Z");
    // Leap-day sanity: 2000-02-29T12:34:56Z
    assert_eq!(format_iso8601_utc(951_827_696), "2000-02-29T12:34:56Z");
}

// --- RecentVault struct shape (compile-time pin) --------------------------

#[test]
fn recent_vault_has_path_and_last_opened_fields() {
    let v = RecentVault {
        path: "/x".into(),
        last_opened: "2026-04-11T00:00:00Z".into(),
    };
    assert_eq!(v.path, "/x");
    assert_eq!(v.last_opened, "2026-04-11T00:00:00Z");
}

// --- IDX-02 / D-14: collect_file_list ------------------------------------

#[test]
fn collect_file_list_sorted_and_normalized() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("b.md"), "").unwrap();
    fs::write(dir.path().join("a.md"), "").unwrap();
    fs::write(dir.path().join("sub/c.md"), "").unwrap();
    fs::write(dir.path().join("ignore.txt"), "").unwrap();
    fs::create_dir(dir.path().join(".hidden")).unwrap();
    fs::write(dir.path().join(".hidden/x.md"), "").unwrap();

    let list = collect_file_list(dir.path());
    assert_eq!(list, vec!["a.md", "b.md", "sub/c.md"]);
}

// --- helpers --------------------------------------------------------------

fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}
