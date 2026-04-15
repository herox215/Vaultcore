// Tests for snippet commands (#64). Mirrors the `_impl` test pattern used
// in bookmarks.rs and files_ops.rs.

use crate::commands::snippets::{list_snippets_impl, read_snippet_impl};
use crate::VaultState;
use std::fs;
use tempfile::tempdir;

fn state_with_vault(root: &std::path::Path) -> VaultState {
    let canonical = fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(canonical);
    s
}

#[test]
fn list_creates_dir_and_returns_empty_on_first_run() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let result = list_snippets_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    assert_eq!(result, Vec::<String>::new());
    assert!(
        dir.path().join(".vaultcore").join("snippets").is_dir(),
        ".vaultcore/snippets/ should be created on first list"
    );
}

#[test]
fn list_returns_only_css_basenames_sorted() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let snippets = dir.path().join(".vaultcore").join("snippets");
    fs::create_dir_all(&snippets).unwrap();
    fs::write(snippets.join("zeta.css"), "body {}").unwrap();
    fs::write(snippets.join("alpha.css"), "body {}").unwrap();
    fs::write(snippets.join("README.md"), "ignore me").unwrap();
    fs::write(snippets.join("no-ext"), "ignore me").unwrap();

    let result = list_snippets_impl(&state, dir.path().to_string_lossy().into_owned()).unwrap();
    assert_eq!(result, vec!["alpha.css".to_string(), "zeta.css".to_string()]);
}

#[test]
fn read_returns_file_contents() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let snippets = dir.path().join(".vaultcore").join("snippets");
    fs::create_dir_all(&snippets).unwrap();
    let css = "body { background: rebeccapurple; }";
    fs::write(snippets.join("theme.css"), css).unwrap();

    let result = read_snippet_impl(
        &state,
        dir.path().to_string_lossy().into_owned(),
        "theme.css".to_string(),
    )
    .unwrap();
    assert_eq!(result, css);
}

#[test]
fn read_rejects_path_traversal() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let snippets = dir.path().join(".vaultcore").join("snippets");
    fs::create_dir_all(&snippets).unwrap();
    // A file planted outside the snippets dir that a traversal would reach.
    fs::write(dir.path().join("secret.css"), "leaked").unwrap();

    for bad in [
        "../secret.css",
        "../../etc/passwd",
        "./a.css",
        "sub/nested.css",
        "",
        "..",
        ".",
    ] {
        let result = read_snippet_impl(
            &state,
            dir.path().to_string_lossy().into_owned(),
            bad.to_string(),
        );
        assert!(result.is_err(), "expected rejection for {bad:?}");
    }
}

#[test]
fn read_rejects_absolute_paths() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());

    #[cfg(unix)]
    let abs = "/etc/passwd".to_string();
    #[cfg(windows)]
    let abs = "C:\\Windows\\System32\\drivers\\etc\\hosts".to_string();

    let result = read_snippet_impl(
        &state,
        dir.path().to_string_lossy().into_owned(),
        abs,
    );
    assert!(result.is_err());
}

#[test]
fn read_rejects_non_css_extension() {
    let dir = tempdir().unwrap();
    let state = state_with_vault(dir.path());
    let snippets = dir.path().join(".vaultcore").join("snippets");
    fs::create_dir_all(&snippets).unwrap();
    fs::write(snippets.join("data.json"), "{}").unwrap();

    let result = read_snippet_impl(
        &state,
        dir.path().to_string_lossy().into_owned(),
        "data.json".to_string(),
    );
    assert!(result.is_err(), "non-.css filenames must be rejected");
}

#[test]
fn list_rejects_vault_path_not_matching_current_vault() {
    let vault_dir = tempdir().unwrap();
    let other_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = list_snippets_impl(&state, other_dir.path().to_string_lossy().into_owned());
    assert!(result.is_err());
}

#[test]
fn read_rejects_vault_path_not_matching_current_vault() {
    let vault_dir = tempdir().unwrap();
    let other_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = read_snippet_impl(
        &state,
        other_dir.path().to_string_lossy().into_owned(),
        "anything.css".to_string(),
    );
    assert!(result.is_err());
}
