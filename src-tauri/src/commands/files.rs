// Wave 1 file commands: read_file, write_file.
//
// Security:
// - T-02 (arbitrary read/write): both commands canonicalize the target path
//   (or its parent, for write) and assert `canonical.starts_with(vault)`
//   before touching the filesystem. A request for `/etc/passwd` from the
//   frontend is rejected with `PermissionDenied` even though plugin-fs
//   might otherwise allow it — the Rust-side guard is the authoritative
//   boundary.
// - T-03 (binary corruption via auto-save loop): `read_file` uses
//   `String::from_utf8` and rejects non-UTF-8 bytes with `InvalidEncoding`
//   (D-17). A binary file therefore NEVER enters the editor, so auto-save
//   cannot truncate/corrupt it.
//
// Note on test-side duplication: because `tauri::State` cannot be constructed
// outside a running Tauri app, the unit tests in `tests/files.rs` duplicate
// the body of these commands in `_impl` helpers that take `&VaultState`
// directly. The two code paths MUST stay logically identical — if you
// change one, change both.

use crate::error::VaultError;
use crate::hash::hash_bytes;
use crate::VaultState;
use std::path::{Path, PathBuf};

/// T-02 mitigation: canonicalize `target` and confirm it sits inside the
/// currently-open vault.
fn ensure_inside_vault(state: &VaultState, target: &Path) -> Result<PathBuf, VaultError> {
    let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
        std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
    ))?;
    let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
        path: target.display().to_string(),
    })?;
    let canonical_target = std::fs::canonicalize(target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: target.display().to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: target.display().to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    if !canonical_target.starts_with(vault) {
        return Err(VaultError::PermissionDenied {
            path: canonical_target.display().to_string(),
        });
    }
    Ok(canonical_target)
}

#[tauri::command]
pub async fn read_file(
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<String, VaultError> {
    let target = PathBuf::from(&path);
    let canonical = ensure_inside_vault(&state, &target)?;
    let bytes = std::fs::read(&canonical).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    // D-17: non-UTF-8 bytes never load into the editor.
    String::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding { path })
}

#[tauri::command]
pub async fn write_file(
    state: tauri::State<'_, VaultState>,
    path: String,
    content: String,
) -> Result<String, VaultError> {
    let target = PathBuf::from(&path);

    // For writes we canonicalize the *parent* (the target file may not exist
    // yet) and require the parent to sit inside the vault.
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
            std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
        ))?;
        let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
            path: path.clone(),
        })?;
        if !canonical_parent.starts_with(vault) {
            return Err(VaultError::PermissionDenied { path: path.clone() });
        }
    }

    let file_name = target
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
    let final_path = canonical_parent.join(file_name);

    let bytes = content.as_bytes();
    std::fs::write(&final_path, bytes).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        // StorageFull is the std name for disk-full on Linux/Windows.
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;
    // Return hash so the frontend can track the last-known disk state
    // (EDIT-10 groundwork — Phase 5 will compare against this).
    Ok(hash_bytes(bytes))
}
