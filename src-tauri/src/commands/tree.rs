// Wave 2 tree commands: list_directory.
//
// Security:
// - T-02-01 (path traversal): `list_directory` validates the requested path
//   is inside the current vault before calling std::fs::read_dir.
// - T-02-02 (information disclosure): dot-prefixed entries are filtered so
//   .git/.obsidian/.trash contents are never exposed to the frontend.
// - T-02-03 (path traversal in subsequent calls): the `path` field in each
//   DirEntry is the absolute canonicalized path of the entry, not the
//   user-supplied string, preventing any path traversal via returned data.
//
// Design:
// - D-01: one level only — no recursion. Sidebar lazy-loads subtrees.
// - D-03: folders first, then alphabetical case-insensitive within each group.
// - D-04: all dot-prefixed names hidden (files AND directories).
// - D-05: symlinks are displayed with is_symlink=true but never followed.
//
// Note on testability: `list_directory_impl` takes `&VaultState` directly
// so unit tests can call it without a running Tauri app. The
// `#[tauri::command]` wrapper is a thin shim over the impl.

use crate::error::VaultError;
use crate::VaultState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A single entry in a directory listing.
#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,       // Absolute path (canonicalized via parent + name)
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_md: bool,        // true for .md extension (case-insensitive)
    /// Seconds since UNIX_EPOCH. None if metadata call failed.
    pub modified: Option<u64>,
    /// Seconds since UNIX_EPOCH. None if metadata unavailable (Linux ext4 often returns Err here).
    pub created: Option<u64>,
}

/// T-02-01 mitigation: validate that `target` is inside the current vault.
/// Unlike files.rs `ensure_inside_vault`, we can't canonicalize a directory
/// that hasn't been created, but for `list_directory` the path must already
/// exist, so full canonicalization works.
fn check_inside_vault(state: &VaultState, target: &Path) -> Result<PathBuf, VaultError> {
    let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
        std::io::Error::other("internal state lock poisoned"),
    ))?;
    let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
        path: target.display().to_string(),
    })?;
    let canonical = std::fs::canonicalize(target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: target.display().to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: target.display().to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    if !canonical.starts_with(vault) {
        return Err(VaultError::PermissionDenied {
            path: canonical.display().to_string(),
        });
    }
    Ok(canonical)
}

/// Implementation body separated for testability.
pub fn list_directory_impl(state: &VaultState, path: String) -> Result<Vec<DirEntry>, VaultError> {
    let target = PathBuf::from(&path);
    let canonical_dir = check_inside_vault(state, &target)?;

    let read_dir = std::fs::read_dir(&canonical_dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;

    let mut entries: Vec<DirEntry> = Vec::new();

    for entry_result in read_dir {
        let entry = entry_result.map_err(VaultError::Io)?;
        let name = entry.file_name().to_string_lossy().into_owned();

        // D-04: exclude all dot-prefixed names (files and directories).
        // This covers .obsidian, .vaultcore, .trash, .git, .DS_Store, etc.
        if name.starts_with('.') {
            continue;
        }

        // Use symlink_metadata to detect symlinks (does not follow the link).
        let symlink_meta = entry.metadata().map_err(VaultError::Io)?;
        // We get metadata via DirEntry::metadata() which follows symlinks on
        // most platforms. To accurately detect symlinks, use path().symlink_metadata().
        let symlink_meta_raw = std::fs::symlink_metadata(entry.path()).map_err(VaultError::Io)?;
        let is_symlink = symlink_meta_raw.is_symlink();

        // Use the followed metadata (symlink_meta from entry.metadata()) for
        // is_dir and file type, so a symlink to a directory is treated as
        // is_dir=true (correct display behavior per D-05).
        let is_dir = symlink_meta.is_dir();
        let is_md = !is_dir && entry.path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));

        // T-02-03: use the actual path from the OS (not user-supplied string)
        // joined via canonical parent to prevent path traversal.
        let entry_path = canonical_dir.join(&name);

        // Compute timestamps from symlink_meta (already loaded above).
        // Two .ok() calls per RESEARCH Pitfall 3: metadata().created() returns Err on
        // Linux ext4 and duration_since() returns Err if time is before UNIX_EPOCH
        // (possible on a misconfigured clock). Never panics.
        let modified = symlink_meta.modified().ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let created = symlink_meta.created().ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            is_md,
            modified,
            created,
        });
    }

    // D-03: sort folders first, then alphabetical case-insensitive within each group.
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<Vec<DirEntry>, VaultError> {
    list_directory_impl(&state, path)
}
