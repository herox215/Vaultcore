// Tests for the per-vault bundled docs page bootstrap (#285).

use crate::indexer::ensure_docs_page;
use tempfile::TempDir;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[test]
fn ensure_docs_page_creates_file_when_missing() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    ensure_docs_page(vault).expect("bootstrap should succeed");

    let docs = vault.join(".vaultcore").join("DOCS.md");
    assert!(docs.exists(), "DOCS.md should be created");

    let body = std::fs::read_to_string(&docs).unwrap();
    assert!(
        body.starts_with("---\n"),
        "body should begin with YAML frontmatter"
    );
    let expected_tag = format!("vaultcore_docs_version: \"{}\"", CURRENT_VERSION);
    assert!(
        body.contains(&expected_tag),
        "frontmatter should carry the running app version",
    );
    assert!(
        body.contains("# Vaultcore — User Documentation"),
        "template body should be present",
    );
}

#[test]
fn ensure_docs_page_is_idempotent_on_same_version() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    ensure_docs_page(vault).unwrap();
    let docs = vault.join(".vaultcore").join("DOCS.md");
    let first = std::fs::read_to_string(&docs).unwrap();

    // Sabotage the body — the version tag stays the same, so a second
    // call must leave the file alone.
    let tampered = first.replace("# Vaultcore — User Documentation", "# Tampered");
    std::fs::write(&docs, &tampered).unwrap();

    ensure_docs_page(vault).unwrap();

    assert_eq!(
        std::fs::read_to_string(&docs).unwrap(),
        tampered,
        "same version → file must not be overwritten",
    );
}

#[test]
fn ensure_docs_page_regenerates_on_version_change() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    let docs = vault.join(".vaultcore").join("DOCS.md");
    std::fs::create_dir_all(docs.parent().unwrap()).unwrap();

    // Pretend a previous app version wrote this file.
    let stale = "---\nvaultcore_docs_version: \"0.0.0-stale\"\n---\n\nold content\n";
    std::fs::write(&docs, stale).unwrap();

    ensure_docs_page(vault).unwrap();

    let body = std::fs::read_to_string(&docs).unwrap();
    let expected_tag = format!("vaultcore_docs_version: \"{}\"", CURRENT_VERSION);
    assert!(
        body.contains(&expected_tag),
        "stale version → file should be overwritten with the current version",
    );
    assert!(!body.contains("old content"), "stale body should be gone");
}

#[test]
fn ensure_docs_page_self_heals_after_delete() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();

    ensure_docs_page(vault).unwrap();
    let docs = vault.join(".vaultcore").join("DOCS.md");
    std::fs::remove_file(&docs).unwrap();
    assert!(!docs.exists());

    ensure_docs_page(vault).unwrap();
    assert!(docs.exists(), "DOCS.md should be recreated after deletion");
}

#[test]
fn ensure_docs_page_missing_frontmatter_tag_is_treated_as_stale() {
    let tmp = TempDir::new().unwrap();
    let vault = tmp.path();
    let docs = vault.join(".vaultcore").join("DOCS.md");
    std::fs::create_dir_all(docs.parent().unwrap()).unwrap();
    std::fs::write(&docs, "plain user edits, no frontmatter").unwrap();

    ensure_docs_page(vault).unwrap();

    let body = std::fs::read_to_string(&docs).unwrap();
    let expected_tag = format!("vaultcore_docs_version: \"{}\"", CURRENT_VERSION);
    assert!(body.contains(&expected_tag));
}
