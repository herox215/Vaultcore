// Bookmarks IPC (#12). Persists the user-ordered list of vault-relative
// bookmarked paths to `<vault>/.vaultcore/bookmarks.json`.
//
// Security: both commands canonicalize `vault_path` and require it to match
// the currently-open vault root (same T-02 guard pattern used by files.rs).
// We never read/write outside `<vault_root>/.vaultcore/`.
//
// Write path: serialize -> temp file -> atomic rename, so a crash mid-write
// cannot corrupt the existing file.

use crate::error::VaultError;
use crate::VaultState;
use std::path::{Path, PathBuf};

const BOOKMARKS_DIR: &str = ".vaultcore";
const BOOKMARKS_FILE: &str = "bookmarks.json";

/// Resolve `<vault>/.vaultcore/bookmarks.json` after confirming `vault_path`
/// matches the currently-open vault.
fn bookmarks_path_for(state: &VaultState, vault_path: &str) -> Result<PathBuf, VaultError> {
    let canonical = std::fs::canonicalize(vault_path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: vault_path.to_string() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: vault_path.to_string() },
        _ => VaultError::Io(e),
    })?;
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
    let vault = guard
        .as_ref()
        .ok_or_else(|| VaultError::VaultUnavailable {
            path: vault_path.to_string(),
        })?
        .expect_posix();
    if canonical != *vault {
        return Err(VaultError::PermissionDenied { path: canonical.display().to_string() });
    }
    Ok(canonical.join(BOOKMARKS_DIR).join(BOOKMARKS_FILE))
}

pub fn load_bookmarks_impl(state: &VaultState, vault_path: String) -> Result<Vec<String>, VaultError> {
    let path = bookmarks_path_for(state, &vault_path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path).map_err(VaultError::Io)?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<String> = serde_json::from_slice(&bytes).map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
    })?;
    Ok(parsed)
}

#[tauri::command]
pub async fn load_bookmarks(
    state: tauri::State<'_, VaultState>,
    vault_path: String,
) -> Result<Vec<String>, VaultError> {
    load_bookmarks_impl(&state, vault_path)
}

pub fn save_bookmarks_impl(
    state: &VaultState,
    vault_path: String,
    bookmarks: Vec<String>,
) -> Result<(), VaultError> {
    let path = bookmarks_path_for(state, &vault_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(VaultError::Io)?;
    }
    let json = serde_json::to_vec_pretty(&bookmarks).map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;
    atomic_write(&path, &json)
}

#[tauri::command]
pub async fn save_bookmarks(
    state: tauri::State<'_, VaultState>,
    vault_path: String,
    bookmarks: Vec<String>,
) -> Result<(), VaultError> {
    save_bookmarks_impl(&state, vault_path, bookmarks)
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    let parent = target.parent().ok_or_else(|| VaultError::PermissionDenied {
        path: target.display().to_string(),
    })?;
    let tmp_name = match target.file_name() {
        Some(n) => format!(".{}.tmp", n.to_string_lossy()),
        None => ".bookmarks.tmp".to_string(),
    };
    let tmp = parent.join(tmp_name);
    std::fs::write(&tmp, bytes).map_err(VaultError::Io)?;
    std::fs::rename(&tmp, target).map_err(VaultError::Io)?;
    Ok(())
}
