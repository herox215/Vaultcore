// Tests for the per-vault home canvas bootstrap (#279).

use crate::indexer::ensure_home_canvas;
use tempfile::TempDir;

#[test]
fn ensure_home_canvas_creates_file_when_missing() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    ensure_home_canvas(vault).expect("bootstrap should succeed");

    let home = vault.join(".vaultcore").join("home.canvas");
    assert!(home.exists(), "home.canvas should be created");

    let body = std::fs::read_to_string(&home).unwrap();
    // Must be valid JSON with the Obsidian canvas shape.
    let doc: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    assert!(doc.get("nodes").and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty()));
    assert!(doc.get("edges").and_then(|v| v.as_array()).is_some());

    // Vault name should appear in the welcome text.
    let vault_name = vault.file_name().unwrap().to_str().unwrap();
    assert!(
        body.contains(vault_name),
        "welcome node should reference the vault name",
    );
}

#[test]
fn ensure_home_canvas_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    ensure_home_canvas(vault).unwrap();
    let home = vault.join(".vaultcore").join("home.canvas");
    std::fs::write(&home, "user edits").unwrap();

    ensure_home_canvas(vault).unwrap();

    // Existing content must NOT be overwritten.
    assert_eq!(std::fs::read_to_string(&home).unwrap(), "user edits");
}

#[test]
fn ensure_home_canvas_self_heals_after_delete() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    ensure_home_canvas(vault).unwrap();
    let home = vault.join(".vaultcore").join("home.canvas");
    std::fs::remove_file(&home).unwrap();
    assert!(!home.exists());

    ensure_home_canvas(vault).unwrap();
    assert!(home.exists(), "home.canvas should be recreated after deletion");
}
