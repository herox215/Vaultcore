// Wave 1+2 file commands: read_file, write_file, create_file, rename_file,
// delete_file, move_file, create_folder, count_wiki_links.
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
use regex::Regex;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

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

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2: file-management commands
// ─────────────────────────────────────────────────────────────────────────────

/// Helper: validate that `parent` exists inside the vault by canonicalizing its
/// parent directory (since the target itself may not exist yet).
fn ensure_parent_inside_vault(state: &VaultState, target: &Path) -> Result<(PathBuf, PathBuf), VaultError> {
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::PermissionDenied { path: target.display().to_string() })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: parent.display().to_string() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: parent.display().to_string() },
        _ => VaultError::Io(e),
    })?;
    let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
        std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
    ))?;
    let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
        path: target.display().to_string(),
    })?.clone();
    if !canonical_parent.starts_with(&vault) {
        return Err(VaultError::PermissionDenied { path: canonical_parent.display().to_string() });
    }
    Ok((canonical_parent, vault))
}

/// Helper: get the current vault root.
fn get_vault_root(state: &VaultState) -> Result<PathBuf, VaultError> {
    let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
        std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
    ))?;
    guard.as_ref().cloned().ok_or_else(|| VaultError::VaultUnavailable {
        path: String::from("<no vault>"),
    })
}

/// Helper: record a path in the write-ignore list (D-12 self-filtering).
fn record_write(state: &VaultState, path: PathBuf) {
    if let Ok(mut list) = state.write_ignore.lock() {
        list.record(path);
    }
}

/// Helper: auto-suffix a base name (stem + ext) until a non-colliding name is found.
/// E.g. "Untitled.md" → "Untitled 1.md" → "Untitled 2.md"
fn find_available_name(dir: &Path, base_name: &str) -> PathBuf {
    let candidate = dir.join(base_name);
    if !candidate.exists() {
        return candidate;
    }
    // Split into stem and extension
    let (stem, ext) = if let Some(dot) = base_name.rfind('.') {
        (&base_name[..dot], &base_name[dot..])
    } else {
        (base_name, "")
    };
    let mut n = 1u32;
    loop {
        let name = format!("{} {}{}", stem, n, ext);
        let candidate = dir.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Helper: auto-suffix for folder names (no extension).
fn find_available_dir_name(dir: &Path, base_name: &str) -> PathBuf {
    let candidate = dir.join(base_name);
    if !candidate.exists() {
        return candidate;
    }
    let mut n = 1u32;
    loop {
        let name = format!("{} {}", base_name, n);
        let candidate = dir.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Helper: walk all .md files in vault, excluding dot-prefixed directories.
fn walk_md_files(vault: &Path) -> impl Iterator<Item = PathBuf> {
    WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_str().unwrap_or("");
            e.depth() == 0 || !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map_or(false, |ext| ext.eq_ignore_ascii_case("md"))
        })
        .map(|e| e.path().to_path_buf())
}

// ─── create_file ─────────────────────────────────────────────────────────────

/// Testable implementation body for create_file.
pub fn create_file_impl(state: &VaultState, parent: String, name: String) -> Result<String, VaultError> {
    let parent_path = PathBuf::from(&parent);
    let (canonical_parent, _vault) = ensure_parent_inside_vault(state, &parent_path.join("_sentinel"))?;

    let base_name = if name.is_empty() { "Untitled.md" } else { &name };
    let final_path = find_available_name(&canonical_parent, base_name);

    record_write(state, final_path.clone());
    std::fs::write(&final_path, "").map_err(VaultError::Io)?;

    Ok(final_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn create_file(
    state: tauri::State<'_, VaultState>,
    parent: String,
    name: String,
) -> Result<String, VaultError> {
    create_file_impl(&state, parent, name)
}

// ─── create_folder ───────────────────────────────────────────────────────────

/// Testable implementation body for create_folder.
pub fn create_folder_impl(state: &VaultState, parent: String, name: String) -> Result<String, VaultError> {
    let parent_path = PathBuf::from(&parent);
    let (canonical_parent, _vault) = ensure_parent_inside_vault(state, &parent_path.join("_sentinel"))?;

    let base_name = if name.is_empty() { "New Folder" } else { &name };
    let final_path = find_available_dir_name(&canonical_parent, base_name);

    record_write(state, final_path.clone());
    std::fs::create_dir(&final_path).map_err(VaultError::Io)?;

    Ok(final_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn create_folder(
    state: tauri::State<'_, VaultState>,
    parent: String,
    name: String,
) -> Result<String, VaultError> {
    create_folder_impl(&state, parent, name)
}

// ─── rename_file ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct RenameResult {
    pub new_path: String,
    pub link_count: u32,
}

/// Testable implementation body for rename_file.
pub fn rename_file_impl(state: &VaultState, old_path: String, new_name: String) -> Result<RenameResult, VaultError> {
    let old = PathBuf::from(&old_path);
    let canonical_old = ensure_inside_vault(state, &old)?;

    let new_path = canonical_old
        .parent()
        .ok_or_else(|| VaultError::PermissionDenied { path: old_path.clone() })?
        .join(&new_name);

    // Validate new path stays inside vault
    let (canonical_new_parent, _vault) = ensure_parent_inside_vault(state, &new_path)?;
    let canonical_new = canonical_new_parent.join(&new_name);

    // Count wiki-links before rename (D-16)
    let old_stem = canonical_old
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let vault_root = get_vault_root(state)?;
    let pattern = format!(r"\[\[{}\]\]", regex::escape(&old_stem));
    let re = Regex::new(&pattern).map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;

    let mut link_count: u32 = 0;
    for md_path in walk_md_files(&vault_root) {
        // Skip the file being renamed itself
        if md_path == canonical_old {
            continue;
        }
        if let Ok(contents) = std::fs::read_to_string(&md_path) {
            link_count += re.find_iter(&contents).count() as u32;
        }
    }

    // Record both paths in write-ignore before mutation (D-12)
    record_write(state, canonical_old.clone());
    record_write(state, canonical_new.clone());

    std::fs::rename(&canonical_old, &canonical_new).map_err(VaultError::Io)?;

    Ok(RenameResult {
        new_path: canonical_new.to_string_lossy().into_owned(),
        link_count,
    })
}

#[tauri::command]
pub async fn rename_file(
    state: tauri::State<'_, VaultState>,
    old_path: String,
    new_name: String,
) -> Result<RenameResult, VaultError> {
    rename_file_impl(&state, old_path, new_name)
}

// ─── delete_file ─────────────────────────────────────────────────────────────

/// Testable implementation body for delete_file.
pub fn delete_file_impl(state: &VaultState, path: String) -> Result<(), VaultError> {
    let target = PathBuf::from(&path);
    let canonical = ensure_inside_vault(state, &target)?;

    let vault_root = get_vault_root(state)?;
    let trash_dir = vault_root.join(".trash");
    std::fs::create_dir_all(&trash_dir).map_err(VaultError::Io)?;

    let file_name = canonical
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?
        .to_string_lossy()
        .into_owned();

    let dest = find_available_name(&trash_dir, &file_name);

    // Record both source and destination (D-12 / Pitfall 6)
    record_write(state, canonical.clone());
    record_write(state, dest.clone());

    std::fs::rename(&canonical, &dest).map_err(VaultError::Io)?;

    Ok(())
}

#[tauri::command]
pub async fn delete_file(
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<(), VaultError> {
    delete_file_impl(&state, path)
}

// ─── move_file ───────────────────────────────────────────────────────────────

/// Testable implementation body for move_file.
pub fn move_file_impl(state: &VaultState, from: String, to_folder: String) -> Result<String, VaultError> {
    let from_path = PathBuf::from(&from);
    let canonical_from = ensure_inside_vault(state, &from_path)?;

    let to_folder_path = PathBuf::from(&to_folder);
    let canonical_to_folder = ensure_inside_vault(state, &to_folder_path)?;

    let file_name = canonical_from
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: from.clone() })?;

    let dest = canonical_to_folder.join(file_name);

    if dest.exists() {
        return Err(VaultError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("File already exists: {}", dest.display()),
        )));
    }

    // Record both paths in write-ignore (D-12)
    record_write(state, canonical_from.clone());
    record_write(state, dest.clone());

    std::fs::rename(&canonical_from, &dest).map_err(VaultError::Io)?;

    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn move_file(
    state: tauri::State<'_, VaultState>,
    from: String,
    to_folder: String,
) -> Result<String, VaultError> {
    move_file_impl(&state, from, to_folder)
}

// ─── count_wiki_links ────────────────────────────────────────────────────────

/// Testable implementation body for count_wiki_links.
pub fn count_wiki_links_impl(state: &VaultState, filename: String) -> Result<u32, VaultError> {
    let vault_root = get_vault_root(state)?;

    // Strip .md extension to get the stem used in [[links]]
    let stem = if filename.to_lowercase().ends_with(".md") {
        &filename[..filename.len() - 3]
    } else {
        &filename
    };

    let pattern = format!(r"\[\[{}\]\]", regex::escape(stem));
    let re = Regex::new(&pattern).map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;

    let mut total: u32 = 0;
    for md_path in walk_md_files(&vault_root) {
        if let Ok(contents) = std::fs::read_to_string(&md_path) {
            total += re.find_iter(&contents).count() as u32;
        }
    }

    Ok(total)
}

#[tauri::command]
pub async fn count_wiki_links(
    state: tauri::State<'_, VaultState>,
    filename: String,
) -> Result<u32, VaultError> {
    count_wiki_links_impl(&state, filename)
}
