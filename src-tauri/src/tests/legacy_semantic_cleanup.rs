// #353 — one-shot cleanup of the pre-removal semantic-search artefacts.
//
// Two paths to purge on upgrade:
//   1. `<vault>/.vaultcore/embeddings/` — HNSW dumps, mapping, checkpoint.
//      Cleared inside `open_vault` every time a vault is opened.
//   2. `<app_data_dir>/semantic-enabled.json` — persisted toggle file.
//      Cleared inside the Tauri `setup` closure on app boot.
//
// Both cleanups are best-effort + idempotent: NotFound is the common case
// and must not be an error; other I/O errors are logged but do not fail
// the host operation (open_vault / app boot).

use std::fs;
use tempfile::TempDir;

use crate::commands::vault::{purge_legacy_embeddings_dir, purge_legacy_semantic_toggle_file};

// ─── purge_legacy_embeddings_dir ─────────────────────────────────────────────

#[test]
fn purge_embeddings_dir_removes_populated_directory() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    let embed_dir = vault.join(".vaultcore").join("embeddings");
    fs::create_dir_all(&embed_dir).unwrap();
    fs::write(embed_dir.join("hnsw.dump"), b"stale").unwrap();
    fs::write(embed_dir.join("mapping.bin"), b"stale").unwrap();

    purge_legacy_embeddings_dir(vault);

    assert!(
        !embed_dir.exists(),
        "embeddings dir should be gone after purge"
    );
    // Only the leaf `.vaultcore/embeddings/` is targeted — any sibling state
    // under `.vaultcore/` must survive (Tantivy index, locked-folder manifest,
    // etc. live next to it and are unrelated).
    assert!(
        vault.join(".vaultcore").exists(),
        ".vaultcore/ parent dir must not be removed"
    );
}

#[test]
fn purge_embeddings_dir_tolerates_missing_directory() {
    let tmp = TempDir::new().unwrap();
    // No `.vaultcore/embeddings/` exists — fresh vault or post-purge state.
    purge_legacy_embeddings_dir(tmp.path());
    // No panic, no error. Idempotent.
}

#[test]
fn purge_embeddings_dir_tolerates_missing_vaultcore_parent() {
    let tmp = TempDir::new().unwrap();
    // Vault root is empty — no .vaultcore, no anything.
    purge_legacy_embeddings_dir(tmp.path());
}

// ─── purge_legacy_semantic_toggle_file ───────────────────────────────────────

#[test]
fn purge_toggle_file_removes_existing_file() {
    let tmp = TempDir::new().unwrap();
    let toggle = tmp.path().join("semantic-enabled.json");
    fs::write(&toggle, br#"{"enabled":true}"#).unwrap();

    purge_legacy_semantic_toggle_file(tmp.path());

    assert!(!toggle.exists(), "toggle file should be gone after purge");
}

#[test]
fn purge_toggle_file_tolerates_missing_file() {
    let tmp = TempDir::new().unwrap();
    // No `semantic-enabled.json` — fresh install.
    purge_legacy_semantic_toggle_file(tmp.path());
}

#[test]
fn purge_toggle_file_tolerates_missing_directory() {
    // Passing a non-existent directory path must not panic. Simulates a
    // platform where app_data_dir hasn't been created yet.
    let tmp = TempDir::new().unwrap();
    let never_existed = tmp.path().join("nested").join("path");
    purge_legacy_semantic_toggle_file(&never_existed);
}
