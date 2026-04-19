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
use crate::indexer::{walk_md_files, IndexCmd};
use crate::VaultState;
use regex::Regex;
use std::path::{Path, PathBuf};

/// T-02 mitigation: canonicalize `target` and confirm it sits inside the
/// currently-open vault.
fn ensure_inside_vault(state: &VaultState, target: &Path) -> Result<PathBuf, VaultError> {
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
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
        let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
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

    // D-12 self-filtering: record before the fs call so the watcher ignores
    // the resulting event.
    if let Ok(mut list) = state.write_ignore.lock() {
        list.record(final_path.clone());
    }

    let bytes = content.as_bytes();
    std::fs::write(&final_path, bytes).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        // StorageFull is the std name for disk-full on Linux/Windows.
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;

    // BUG-05.1 FIX: the watcher would normally dispatch UpdateLinks/UpdateTags
    // for any modify event, but write_ignore suppresses self-writes to avoid
    // double-indexing. That leaves the in-memory LinkGraph and TagIndex stale
    // after every auto-save, so user observes stale tag counts, broken
    // backlinks, and dangling unresolved-link colors until cold restart.
    //
    // Dispatch the updates directly here so the in-memory indexes stay in sync.
    dispatch_index_updates(&state, &final_path, &content).await;

    // Embed-on-save (#196): non-blocking enqueue to the EmbedCoordinator.
    // Sync, returns immediately; a `QueueFull` outcome is benign because
    // the latest content already lives in the coordinator's pending map.
    #[cfg(feature = "embeddings")]
    dispatch_embed_update(&state, final_path.clone(), &content);

    // Return hash so the frontend can track the last-known disk state
    // (EDIT-10 groundwork — Phase 5 will compare against this).
    Ok(hash_bytes(bytes))
}

#[cfg(feature = "embeddings")]
fn dispatch_embed_update(state: &VaultState, abs_path: PathBuf, content: &str) {
    let coord_handles = {
        let Ok(guard) = state.embed_coordinator.lock() else { return };
        guard.as_ref().map(|c| (c.tx.clone(), std::sync::Arc::clone(&c.pending)))
    };
    let Some((tx, pending)) = coord_handles else { return };
    let probe = crate::embeddings::EmbedCoordinator { tx, pending };
    if let Err(e) = probe.enqueue(abs_path, content.to_string()) {
        log::warn!("embed enqueue: {e}");
    }
}

/// Dispatch IndexCmd::UpdateLinks and IndexCmd::UpdateTags for a path we just
/// wrote from the backend. Called from write_file because write_ignore
/// suppresses the natural watcher-driven dispatch.
///
/// Best-effort: if the IndexCoordinator is not yet initialized (vault not
/// open, or during boot) or the channel is full, we silently drop — the
/// next cold-start rebuild will re-populate correctly.
async fn dispatch_index_updates(state: &VaultState, abs_path: &Path, content: &str) {
    // Get vault root so we can compute a vault-relative path.
    let vault_root = {
        let Ok(guard) = state.current_vault.lock() else { return };
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => return,
        }
    };

    let Ok(rel) = abs_path.strip_prefix(&vault_root) else { return };
    let rel_path = rel.to_string_lossy().replace('\\', "/");

    // Clone the sender Arc — do NOT hold the coordinator lock across .await.
    let tx = {
        let Ok(guard) = state.index_coordinator.lock() else { return };
        match guard.as_ref() {
            Some(c) => c.tx.clone(),
            None => return,
        }
    };

    let _ = tx
        .send(IndexCmd::UpdateLinks {
            rel_path: rel_path.clone(),
            content: content.to_string(),
        })
        .await;
    let _ = tx
        .send(IndexCmd::UpdateTags {
            rel_path,
            content: content.to_string(),
        })
        .await;
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
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
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
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
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
#[serde(rename_all = "camelCase")]
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
        VaultError::Io(std::io::Error::other(e.to_string()))
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
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<(), VaultError> {
    use tauri::Emitter;
    // Canonicalize before delete so the emitted path matches the form the
    // watcher would have used (and matches how tabs/sidebar store paths).
    let canonical_str = std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.clone());
    delete_file_impl(&state, path)?;
    // Bug #102: the watcher suppresses this delete via write_ignore (D-12),
    // so emit a synthetic file_changed event so tabs bound to the deleted
    // path close.
    let _ = app.emit(
        crate::watcher::FILE_CHANGED_EVENT,
        crate::watcher::FileChangePayload {
            path: canonical_str,
            kind: "delete".to_string(),
            new_path: None,
        },
    );
    Ok(())
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

// ─── get_file_hash ───────────────────────────────────────────────────────────

/// EDIT-10 support: read a file's current bytes and return the SHA-256 hex.
///
/// Used by the frontend auto-save loop: before each write, we compare the
/// on-disk hash to editorStore.lastSavedHash. Mismatch → route through the
/// Phase 2 three-way merge engine instead of clobbering external edits.
///
/// Security:
/// - T-05-06-01 (path traversal): canonicalize then enforce starts_with(vault);
///   identical guard to read_file.
/// - T-05-06-02 (TOCTOU with write_file): the hash is compared in the frontend
///   immediately before write; the gap between read and write is under 50ms
///   in practice. A concurrent external write landing inside that window is
///   indistinguishable from one that arrives during write_file itself; the
///   watcher's merge path remains the fallback for that rarer case.
pub fn get_file_hash_impl(state: &VaultState, path: String) -> Result<String, VaultError> {
    let target = std::path::PathBuf::from(&path);
    let canonical = ensure_inside_vault(state, &target)?;
    let bytes = std::fs::read(&canonical).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: canonical.display().to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: canonical.display().to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    Ok(hash_bytes(&bytes))
}

#[tauri::command]
pub async fn get_file_hash(
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<String, VaultError> {
    get_file_hash_impl(&state, path)
}

// ─── save_attachment ─────────────────────────────────────────────────────────

/// Save raw bytes as an attachment inside the vault's attachment folder.
/// Returns the vault-relative path using forward slashes.
///
/// Security: the target folder is canonicalized and verified to sit inside the
/// vault (T-02 guard), mirroring write_file. The folder is auto-created on
/// first use. Collision avoidance appends ` 1`, ` 2`, … (capped at 1000).
#[tauri::command]
pub async fn save_attachment(
    state: tauri::State<'_, VaultState>,
    folder: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, VaultError> {
    let vault_root = get_vault_root(&state)?;

    // Build and create the target folder.
    let target_folder = vault_root.join(&folder);
    std::fs::create_dir_all(&target_folder).map_err(VaultError::Io)?;

    // Canonicalize the folder now that it exists and verify it is inside the vault.
    let canonical_folder = std::fs::canonicalize(&target_folder).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: target_folder.display().to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: target_folder.display().to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    if !canonical_folder.starts_with(&vault_root) {
        return Err(VaultError::PermissionDenied {
            path: canonical_folder.display().to_string(),
        });
    }

    // Determine final filename with collision avoidance (cap at 1000).
    let (stem, ext) = if let Some(dot) = filename.rfind('.') {
        (&filename[..dot], &filename[dot..])
    } else {
        (filename.as_str(), "")
    };
    let mut final_path = canonical_folder.join(&filename);
    if final_path.exists() {
        let mut found = false;
        for n in 1u32..=1000 {
            let candidate_name = format!("{} {}{}", stem, n, ext);
            let candidate = canonical_folder.join(&candidate_name);
            if !candidate.exists() {
                final_path = candidate;
                found = true;
                break;
            }
        }
        if !found {
            return Err(VaultError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "too many collisions for attachment filename",
            )));
        }
    }

    // D-12 self-filtering: record before the fs call.
    if let Ok(mut list) = state.write_ignore.lock() {
        list.record(final_path.clone());
    }

    std::fs::write(&final_path, &bytes).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: final_path.display().to_string(),
        },
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;

    // Return vault-relative path with forward slashes.
    let rel = final_path.strip_prefix(&vault_root).map_err(|_| {
        VaultError::PermissionDenied {
            path: final_path.display().to_string(),
        }
    })?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
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
        VaultError::Io(std::io::Error::other(e.to_string()))
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
