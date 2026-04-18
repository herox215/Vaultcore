// Wave 1 files.rs unit tests — D-17 UTF-8 guard, T-02 vault-scope guard,
// SHA-256 write return value, FileNotFound path.
//
// These tests drive `_impl` helpers that mirror the body of the
// `#[tauri::command]` functions in `commands/files.rs`. The duplication is
// intentional: `tauri::State` cannot be constructed outside a running Tauri
// app, so there's no way to call the real command body from a `cargo test`
// binary. The two code paths MUST stay logically identical.

use crate::error::VaultError;
use crate::VaultState;
use std::fs;
use tempfile::tempdir;

fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn state_with_vault(root: &std::path::Path) -> VaultState {
    // Use the real canonical form so starts_with() works the same way the
    // production command path would.
    let canonical = fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(canonical);
    s
}

// --- read_file ------------------------------------------------------------

#[test]
fn read_file_returns_utf8_content() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("hello.md");
    fs::write(&path, "# Hello").unwrap();
    let state = state_with_vault(dir.path());
    let result =
        tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into_owned()));
    assert_eq!(result.unwrap(), "# Hello");
}

#[test]
fn read_file_rejects_non_utf8_as_invalid_encoding() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bin.md");
    // 0xff 0xfe is not valid UTF-8 (it's a UTF-16 BOM).
    fs::write(&path, [0xff, 0xfe, 0x00, 0x01]).unwrap();
    let state = state_with_vault(dir.path());
    let result =
        tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into_owned()));
    match result {
        Err(VaultError::InvalidEncoding { path: p }) => assert!(p.contains("bin.md")),
        other => panic!("expected InvalidEncoding, got {:?}", other),
    }
}

#[test]
fn read_file_rejects_path_outside_vault() {
    let vault_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();
    let outside_path = outside_dir.path().join("secret.md");
    fs::write(&outside_path, "secret").unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = tokio_test_block_on(read_file_impl(
        &state,
        outside_path.to_string_lossy().into_owned(),
    ));
    match result {
        Err(VaultError::PermissionDenied { .. }) => {}
        other => panic!("expected PermissionDenied, got {:?}", other),
    }
}

#[test]
fn read_file_returns_file_not_found_for_missing_path() {
    let vault_dir = tempdir().unwrap();
    let missing = vault_dir.path().join("does-not-exist.md");
    let state = state_with_vault(vault_dir.path());
    let result = tokio_test_block_on(read_file_impl(
        &state,
        missing.to_string_lossy().into_owned(),
    ));
    match result {
        Err(VaultError::FileNotFound { .. }) => {}
        other => panic!("expected FileNotFound, got {:?}", other),
    }
}

// --- write_file -----------------------------------------------------------

#[test]
fn write_file_writes_bytes_and_returns_hash() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = state_with_vault(dir.path());
    let hash = tokio_test_block_on(write_file_impl(
        &state,
        path.to_string_lossy().into_owned(),
        "hello".into(),
    ))
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    // Known SHA-256 of "hello"
    assert_eq!(
        hash,
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

#[test]
fn write_file_rejects_path_outside_vault() {
    let vault_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = tokio_test_block_on(write_file_impl(
        &state,
        outside_dir
            .path()
            .join("evil.md")
            .to_string_lossy()
            .into_owned(),
        "pwn".into(),
    ));
    match result {
        Err(VaultError::PermissionDenied { .. }) => {}
        other => panic!("expected PermissionDenied, got {:?}", other),
    }
}

#[test]
fn write_file_round_trip_with_read_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("round.md");
    let state = state_with_vault(dir.path());
    tokio_test_block_on(write_file_impl(
        &state,
        path.to_string_lossy().into_owned(),
        "roundtrip".into(),
    ))
    .unwrap();
    let contents =
        tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into_owned()))
            .unwrap();
    assert_eq!(contents, "roundtrip");
}

// --- _impl helpers: mirror the tauri::command bodies ---------------------
//
// Keep these byte-for-byte logically identical to commands/files.rs.

async fn read_file_impl(state: &VaultState, path: String) -> Result<String, VaultError> {
    use std::path::PathBuf;
    let target = PathBuf::from(&path);
    let canonical_target = std::fs::canonicalize(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    {
        let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
            std::io::Error::other("internal state lock poisoned"),
        ))?;
        let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
            path: path.clone(),
        })?;
        if !canonical_target.starts_with(vault) {
            return Err(VaultError::PermissionDenied { path });
        }
    }
    let bytes = std::fs::read(&canonical_target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    String::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding { path })
}

async fn write_file_impl(
    state: &VaultState,
    path: String,
    content: String,
) -> Result<String, VaultError> {
    use std::path::PathBuf;
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    {
        let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
            std::io::Error::other("internal state lock poisoned"),
        ))?;
        let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
            path: path.clone(),
        })?;
        if !canonical_parent.starts_with(vault) {
            return Err(VaultError::PermissionDenied { path });
        }
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
    let final_path = canonical_parent.join(file_name);
    let bytes = content.as_bytes();
    std::fs::write(&final_path, bytes).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path },
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;
    Ok(crate::hash::hash_bytes(bytes))
}
