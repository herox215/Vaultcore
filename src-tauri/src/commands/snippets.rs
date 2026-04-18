// Custom CSS snippets IPC (#64). Users drop `.css` files into
// `<vault>/.vaultcore/snippets/` and toggle them from Settings. Two read-only
// commands back the frontend:
//   - `list_snippets`   -> basenames of `*.css` files, sorted
//   - `read_snippet`    -> CSS text for a single file
//
// Security: both commands use the same T-02 scope guard as bookmarks.rs —
// the `vault_path` argument is canonicalized and must match the currently-
// open vault root. `read_snippet` additionally rejects any filename that
// could escape the snippets directory (`..`, path separators, absolute
// paths, or a resolved path outside the snippets dir).

use crate::error::VaultError;
use crate::VaultState;
use std::path::{Path, PathBuf};

const VAULTCORE_DIR: &str = ".vaultcore";
const SNIPPETS_DIR: &str = "snippets";

/// Resolve `<vault>/.vaultcore/snippets/` after confirming `vault_path`
/// matches the currently-open vault. Creates the directory if missing so
/// first-run returns an empty list instead of FileNotFound.
fn snippets_dir_for(state: &VaultState, vault_path: &str) -> Result<PathBuf, VaultError> {
    let canonical = std::fs::canonicalize(vault_path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: vault_path.to_string() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: vault_path.to_string() },
        _ => VaultError::Io(e),
    })?;
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
    let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
        path: vault_path.to_string(),
    })?;
    if canonical != *vault {
        return Err(VaultError::PermissionDenied { path: canonical.display().to_string() });
    }
    let dir = canonical.join(VAULTCORE_DIR).join(SNIPPETS_DIR);
    std::fs::create_dir_all(&dir).map_err(VaultError::Io)?;
    Ok(dir)
}

/// Reject filenames that would escape the snippets directory.
/// We accept only a plain file basename ending in `.css` (case-insensitive),
/// with no path separators, no traversal components, and no empty stem.
fn validate_snippet_filename(filename: &str) -> Result<(), VaultError> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
        || filename == "."
        || filename == ".."
        || filename.contains("..")
    {
        return Err(VaultError::PermissionDenied { path: filename.to_string() });
    }
    // Absolute-path heuristic (Windows drive letter / UNC, or POSIX absolute
    // that already failed the `/` check above but keep belt-and-suspenders).
    if Path::new(filename).is_absolute() {
        return Err(VaultError::PermissionDenied { path: filename.to_string() });
    }
    let lower = filename.to_lowercase();
    if !lower.ends_with(".css") {
        return Err(VaultError::PermissionDenied { path: filename.to_string() });
    }
    Ok(())
}

pub fn list_snippets_impl(state: &VaultState, vault_path: String) -> Result<Vec<String>, VaultError> {
    let dir = snippets_dir_for(state, &vault_path)?;
    let mut names: Vec<String> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        // Directory was just created above, so this shouldn't fire, but
        // tolerate NotFound for races and return an empty list.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(e) => return Err(VaultError::Io(e)),
    };
    for entry in entries {
        let entry = entry.map_err(VaultError::Io)?;
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        if name_str.to_lowercase().ends_with(".css") {
            names.push(name_str);
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn list_snippets(
    state: tauri::State<'_, VaultState>,
    vault_path: String,
) -> Result<Vec<String>, VaultError> {
    list_snippets_impl(&state, vault_path)
}

pub fn read_snippet_impl(
    state: &VaultState,
    vault_path: String,
    filename: String,
) -> Result<String, VaultError> {
    validate_snippet_filename(&filename)?;
    let dir = snippets_dir_for(state, &vault_path)?;
    let target = dir.join(&filename);

    // Canonicalize the final path and re-confirm it lives inside the
    // snippets dir. Defends against symlinks or unicode-normalization
    // tricks that slip past the string-level check above.
    let canonical_target = std::fs::canonicalize(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: filename.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: filename.clone() },
        _ => VaultError::Io(e),
    })?;
    let canonical_dir = std::fs::canonicalize(&dir).map_err(VaultError::Io)?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err(VaultError::PermissionDenied { path: filename });
    }

    let bytes = std::fs::read(&canonical_target).map_err(VaultError::Io)?;
    String::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding { path: filename })
}

#[tauri::command]
pub async fn read_snippet(
    state: tauri::State<'_, VaultState>,
    vault_path: String,
    filename: String,
) -> Result<String, VaultError> {
    read_snippet_impl(&state, vault_path, filename)
}
