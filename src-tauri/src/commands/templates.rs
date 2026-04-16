// Note templates IPC (#67). Users place `.md` files into
// `<vault>/.vaultcore/templates/`. The "Insert template" command opens a
// fuzzy picker listing those files; selecting one reads the content,
// substitutes variables ({{date}}, {{time}}, {{title}}), and inserts it
// at the current cursor position.
//
// Two read-only commands back the frontend:
//   - `list_templates`   -> basenames of `*.md` files, sorted
//   - `read_template`    -> markdown text for a single file
//
// Security: same T-02 scope guard as snippets.rs — vault_path must match
// the currently-open vault, filenames are validated against traversal.

use crate::error::VaultError;
use crate::VaultState;
use std::path::{Path, PathBuf};

const VAULTCORE_DIR: &str = ".vaultcore";
const TEMPLATES_DIR: &str = "templates";

/// Resolve `<vault>/.vaultcore/templates/` after confirming `vault_path`
/// matches the currently-open vault. Creates the directory if missing so
/// first-run returns an empty list instead of FileNotFound.
fn templates_dir_for(state: &VaultState, vault_path: &str) -> Result<PathBuf, VaultError> {
    let canonical = std::fs::canonicalize(vault_path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: vault_path.to_string() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: vault_path.to_string() },
        _ => VaultError::Io(e),
    })?;
    let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
        std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
    ))?;
    let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
        path: vault_path.to_string(),
    })?;
    if canonical != *vault {
        return Err(VaultError::PermissionDenied { path: canonical.display().to_string() });
    }
    let dir = canonical.join(VAULTCORE_DIR).join(TEMPLATES_DIR);
    std::fs::create_dir_all(&dir).map_err(VaultError::Io)?;
    Ok(dir)
}

/// Reject filenames that would escape the templates directory.
/// Accept only a plain file basename ending in `.md` (case-insensitive),
/// with no path separators, no traversal components, and no empty stem.
fn validate_template_filename(filename: &str) -> Result<(), VaultError> {
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
    if Path::new(filename).is_absolute() {
        return Err(VaultError::PermissionDenied { path: filename.to_string() });
    }
    let lower = filename.to_lowercase();
    if !lower.ends_with(".md") {
        return Err(VaultError::PermissionDenied { path: filename.to_string() });
    }
    Ok(())
}

pub fn list_templates_impl(state: &VaultState, vault_path: String) -> Result<Vec<String>, VaultError> {
    let dir = templates_dir_for(state, &vault_path)?;
    let mut names: Vec<String> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
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
        if name_str.to_lowercase().ends_with(".md") {
            names.push(name_str);
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn list_templates(
    state: tauri::State<'_, VaultState>,
    vault_path: String,
) -> Result<Vec<String>, VaultError> {
    list_templates_impl(&state, vault_path)
}

pub fn read_template_impl(
    state: &VaultState,
    vault_path: String,
    filename: String,
) -> Result<String, VaultError> {
    validate_template_filename(&filename)?;
    let dir = templates_dir_for(state, &vault_path)?;
    let target = dir.join(&filename);

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
pub async fn read_template(
    state: tauri::State<'_, VaultState>,
    vault_path: String,
    filename: String,
) -> Result<String, VaultError> {
    read_template_impl(&state, vault_path, filename)
}
