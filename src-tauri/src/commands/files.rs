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
// - T-03 (binary corruption via auto-save loop): `read_file` is text-only:
//   decrypts when the target lives in an unlocked encrypted folder, then
//   rejects non-UTF-8 bytes with `InvalidEncoding` (D-17). Binaries never
//   enter the editor via this path. Attachments and other binary content
//   go through `read_attachment_bytes` (#357) which returns raw `Vec<u8>`
//   and also flows through the decrypt gate.
//
// Note on test-side duplication: because `tauri::State` cannot be constructed
// outside a running Tauri app, the unit tests in `tests/files.rs` duplicate
// the body of these commands in `_impl` helpers that take `&VaultState`
// directly. The two code paths MUST stay logically identical — if you
// change one, change both.

use crate::encryption::CanonicalPath;
use crate::error::VaultError;
use crate::hash::hash_bytes;
use crate::indexer::memory::FileMeta;
use crate::VaultState;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// #345: refuse a path that sits inside a currently-locked encrypted
/// folder. Every FS mutation / read entry point calls this after
/// canonicalization so one registry check gates the whole surface.
/// `ensure_inside_vault` already gates the canonical target; write
/// paths that compute `final_path = canonical_parent.join(name)` must
/// additionally call this on the final prospective path — otherwise a
/// plain file could be renamed/moved INTO a locked folder and silently
/// bypass the gate.
fn ensure_unlocked(state: &VaultState, canonical: &Path) -> Result<(), VaultError> {
    let canon = CanonicalPath::assume_canonical(canonical.to_path_buf());
    if state.locked_paths.is_locked(&canon) {
        return Err(VaultError::PathLocked {
            path: canonical.display().to_string(),
        });
    }
    Ok(())
}

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
    drop(guard);
    // #345: gate reads/writes that target a locked encrypted subtree.
    ensure_unlocked(state, &canonical_target)?;
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
    // #345: transparent decrypt when the file lives in an unlocked
    // encrypted folder. No-op for plain vault files so the hot path
    // cost for the common case is one manifest read (cached + small).
    let bytes = crate::encryption::maybe_decrypt_read(&state, &canonical, bytes)?;
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

    // #345: the parent gate caught locked-folder writes when the parent
    // itself sits inside a locked root. This second check catches the
    // edge case where the parent is plain but the target IS a locked
    // root (e.g. writing straight into /vault/locked as a leaf).
    ensure_unlocked(&state, &final_path)?;

    // D-12 self-filtering: record before the fs call so the watcher ignores
    // the resulting event.
    if let Ok(mut list) = state.write_ignore.lock() {
        list.record(final_path.clone());
    }

    let bytes = content.as_bytes();
    // #345: if the target sits in an unlocked encrypted root, seal
    // the bytes before they hit disk. Outside any encrypted folder
    // this is a zero-cost passthrough.
    let bytes_on_disk = crate::encryption::maybe_encrypt_write(&state, &final_path, bytes)?;
    std::fs::write(&final_path, &bytes_on_disk).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        // StorageFull is the std name for disk-full on Linux/Windows.
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;

    // BUG-05.1 FIX + #339: the watcher would normally dispatch
    // UpdateLinks/UpdateTags/AddFile for any modify event, but write_ignore
    // suppresses self-writes to avoid double-indexing. That leaves the
    // in-memory LinkGraph, TagIndex, and Tantivy index stale after every
    // auto-save, so users observe stale tag counts, broken backlinks,
    // dangling unresolved-link colors, and stale fulltext hits until cold
    // restart. Shared helper in commands/index_dispatch.rs keeps this in
    // sync across all self-write paths (write_file, merge_external_change,
    // rename/move, update_links_after_rename).
    crate::commands::index_dispatch::dispatch_self_write(&state, &final_path, &content).await;

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
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
    let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
        path: target.display().to_string(),
    })?.clone();
    if !canonical_parent.starts_with(&vault) {
        return Err(VaultError::PermissionDenied { path: canonical_parent.display().to_string() });
    }
    drop(guard);
    // #345: parent-inside gate. The final prospective target (parent ++
    // file_name) is additionally checked by each caller after they
    // compute it — belt-and-braces against locked-leaf edge cases.
    ensure_unlocked(state, &canonical_parent)?;
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

    // #345: locked-leaf gate (same rationale as write_file).
    ensure_unlocked(state, &final_path)?;

    record_write(state, final_path.clone());
    // #345: encrypt the (empty) payload when the target sits in an
    // unlocked encrypted root so the brand-new file is consistent
    // with its siblings on disk.
    let bytes = crate::encryption::maybe_encrypt_write(state, &final_path, b"")?;
    std::fs::write(&final_path, &bytes).map_err(VaultError::Io)?;

    // #307: write_ignore (D-12) suppresses the watcher's natural create event,
    // which would normally populate FileIndex. Insert directly so `resolve_link`
    // (and anything else that reads FileIndex) finds the new file immediately,
    // instead of falling back to the "create-at-root" path on the next click.
    if let Ok(vault_root) = get_vault_root(state) {
        sync_file_index_create(state, &final_path, &vault_root);
    }

    Ok(final_path.to_string_lossy().into_owned())
}

/// Insert `canonical` into FileIndex with a minimal FileMeta. Used by
/// `create_file_impl` to compensate for the write_ignore-suppressed watcher
/// event. Hash stays empty until the file is saved with content; the title
/// defaults to the filename stem so wiki-link resolution works right away.
fn sync_file_index_create(state: &VaultState, canonical: &Path, vault_root: &Path) {
    let Ok(mut fi) = state.file_index.write() else { return };
    let rel = match canonical.strip_prefix(vault_root) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => return,
    };
    let title = canonical
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    fi.insert(
        canonical.to_path_buf(),
        FileMeta {
            relative_path: rel,
            hash: String::new(),
            title,
            aliases: Vec::new(),
        },
    );
}

#[tauri::command]
pub async fn create_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    parent: String,
    name: String,
) -> Result<String, VaultError> {
    use tauri::Emitter;
    let final_path = create_file_impl(&state, parent, name)?;
    // #307: the watcher suppresses this create via write_ignore (D-12), so
    // emit a synthetic file_changed event — same pattern as delete_file (#102).
    // Without this, frontend listeners (vaultStore.fileList, template live
    // preview) never see self-initiated file creates until app restart.
    let _ = app.emit(
        crate::watcher::FILE_CHANGED_EVENT,
        crate::watcher::FileChangePayload {
            path: final_path.clone(),
            kind: "create".to_string(),
            new_path: None,
        },
    );
    Ok(final_path)
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
///
/// Performs the disk rename, the FileIndex sync, AND the index dispatch
/// (RemoveLinks/RemoveTags + Tantivy delete for the OLD rel_path;
/// UpdateLinks/UpdateTags + Tantivy AddFile for the NEW rel_path using
/// the file's post-rename content). Keeping dispatch in `_impl` means
/// every caller — production wrapper, unit tests, future callers — runs
/// the same contract. The tauri wrapper only adds the synthetic
/// `file_changed` event on top.
pub async fn rename_file_impl(state: &VaultState, old_path: String, new_name: String) -> Result<RenameResult, VaultError> {
    let old = PathBuf::from(&old_path);
    let canonical_old = ensure_inside_vault(state, &old)?;

    let new_path = canonical_old
        .parent()
        .ok_or_else(|| VaultError::PermissionDenied { path: old_path.clone() })?
        .join(&new_name);

    // Validate new path stays inside vault
    let (canonical_new_parent, _vault) = ensure_parent_inside_vault(state, &new_path)?;
    let canonical_new = canonical_new_parent.join(&new_name);
    // #345: block renames that target (or land inside) a locked root,
    // even when the source is plain.
    ensure_unlocked(state, &canonical_new)?;

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

    // #345: scan only unlocked .md files. A locked file contains VCE1
    // ciphertext — reading its bytes through regex would produce junk
    // matches and leak structure. The walker is given a skip predicate
    // consulting the shared registry.
    let skip_registry = Arc::clone(&state.locked_paths);
    let mut link_count: u32 = 0;
    for md_path in crate::indexer::walk_md_files_skipping(&vault_root, move |p| {
        let canon = CanonicalPath::assume_canonical(p.to_path_buf());
        skip_registry.is_locked(&canon)
    }) {
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

    // #277: update the in-memory FileIndex. The watcher's natural rename
    // event is suppressed by `write_ignore` above, so without this the
    // FileIndex would keep the stale OLD rel_path and never learn about
    // the NEW one — breaking `resolve_link` for the renamed file and
    // routing clicks on `[[new-name]]` into the frontend's create-at-root
    // fallback. Only mutate after `fs::rename` succeeds; on disk failure
    // we intentionally leave the index untouched.
    sync_file_index_rename(state, &canonical_old, &canonical_new, &vault_root);

    // #339: watcher-natural DeleteFile(old) + AddFile(new) on rename is
    // suppressed by write_ignore. Dispatch both sides ourselves so the
    // in-memory LinkGraph / TagIndex / Tantivy index stay in sync with
    // disk without waiting for cold restart.
    crate::commands::index_dispatch::dispatch_self_delete(state, &canonical_old).await;
    dispatch_new_side_after_rename(state, &canonical_new, "rename_file").await;

    Ok(RenameResult {
        new_path: canonical_new.to_string_lossy().into_owned(),
        link_count,
    })
}

/// Move the FileIndex entry at `canonical_old` to `canonical_new`, preserving
/// hash/title/aliases and updating `relative_path` to match the new location.
/// Used by both `rename_file_impl` and `move_file_impl` (#277).
///
/// Case-only rename (`canonical_old == canonical_new` on case-insensitive
/// filesystems): update the stored `relative_path` in place and leave the
/// entry otherwise intact, so hash/title/aliases survive.
///
/// No-op when the old entry is absent — tests that seed an empty index or
/// renames that race an external rescan must not blow up.
fn sync_file_index_rename(
    state: &VaultState,
    canonical_old: &Path,
    canonical_new: &Path,
    vault_root: &Path,
) {
    let Ok(mut fi) = state.file_index.write() else { return };

    let new_rel = match canonical_new.strip_prefix(vault_root) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => return,
    };

    // Preserve prior metadata where possible; synthesize a minimal entry if
    // the index wasn't previously populated for this path (cold-start race).
    let prior = fi.remove(&canonical_old.to_path_buf());
    let meta = match prior {
        Some(mut m) => {
            m.relative_path = new_rel;
            m
        }
        None => {
            let title = canonical_new
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            FileMeta {
                relative_path: new_rel,
                hash: String::new(),
                title,
                aliases: Vec::new(),
            }
        }
    };
    fi.insert(canonical_new.to_path_buf(), meta);
}

#[tauri::command]
pub async fn rename_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    old_path: String,
    new_name: String,
) -> Result<RenameResult, VaultError> {
    use tauri::Emitter;
    let old_canonical_for_event = std::fs::canonicalize(&old_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| old_path.clone());

    // rename_file_impl handles the disk rename, FileIndex sync, AND the
    // index dispatch — see its doc for the contract split.
    let result = rename_file_impl(&state, old_path, new_name).await?;

    // #307: write_ignore (D-12) suppresses the watcher's natural rename
    // event, so emit a synthetic one — same pattern as delete_file (#102).
    let _ = app.emit(
        crate::watcher::FILE_CHANGED_EVENT,
        crate::watcher::FileChangePayload {
            path: old_canonical_for_event,
            kind: "rename".to_string(),
            new_path: Some(result.new_path.clone()),
        },
    );

    Ok(result)
}

/// Dispatch UpdateLinks/UpdateTags/AddFile for the new side of a rename
/// or move. Called after the disk rename + old-side dispatch succeeds.
///
/// `canonical_new` must already be canonicalized — callers
/// (`rename_file_impl`, `move_file_impl`) hold that path in hand. Doing
/// the canonicalize here again would be wasted syscalls and silently
/// absorb an error the caller already handled.
///
/// On read failure we log::warn instead of bubbling: the disk operation
/// already succeeded, so failing the command would be worse than leaving
/// the index transiently stale until the next rebuild. The warning makes
/// the degradation observable without being noisy.
async fn dispatch_new_side_after_rename(state: &VaultState, canonical_new: &Path, op: &str) {
    match std::fs::read_to_string(canonical_new) {
        Err(e) => log::warn!(
            "{op} new-side read failed for {}: {e} — index will trail until rebuild",
            canonical_new.display(),
        ),
        Ok(content) => {
            crate::commands::index_dispatch::dispatch_self_write(state, canonical_new, &content)
                .await;
        }
    }
}

// ─── delete_file ─────────────────────────────────────────────────────────────

/// Testable implementation body for delete_file. Returns the canonical path
/// of the deleted source so the tauri wrapper can emit the synthetic
/// `file_changed` event with the same canonical form the watcher would
/// have used.
///
/// The index dispatch (RemoveLinks / RemoveTags / Tantivy DeleteFile +
/// Commit) is part of the `_impl` contract, not the wrapper. Keeping it
/// here means every caller — production wrapper AND unit tests — runs the
/// same delete contract and a future change to the dispatch can't be
/// forgotten in the wrapper alone.
pub async fn delete_file_impl(state: &VaultState, path: String) -> Result<PathBuf, VaultError> {
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

    // #339: write_ignore suppresses the watcher's natural remove event;
    // dispatch the index cleanup directly so LinkGraph, TagIndex, and
    // Tantivy all evict entries for the deleted source.
    crate::commands::index_dispatch::dispatch_self_delete(state, &canonical).await;

    Ok(canonical)
}

#[tauri::command]
pub async fn delete_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<(), VaultError> {
    use tauri::Emitter;
    // delete_file_impl returns the canonical source path AFTER a successful
    // delete + index dispatch, so the synthetic event uses the same form
    // the watcher would have seen.
    let canonical = delete_file_impl(&state, path).await?;
    let canonical_str = canonical.to_string_lossy().into_owned();

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
///
/// Performs the disk rename, FileIndex sync, AND the index dispatch — same
/// contract split as `rename_file_impl` (see its doc). Returns the
/// canonical destination path.
pub async fn move_file_impl(state: &VaultState, from: String, to_folder: String) -> Result<String, VaultError> {
    let from_path = PathBuf::from(&from);
    let canonical_from = ensure_inside_vault(state, &from_path)?;

    let to_folder_path = PathBuf::from(&to_folder);
    let canonical_to_folder = ensure_inside_vault(state, &to_folder_path)?;

    let file_name = canonical_from
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: from.clone() })?;

    let dest = canonical_to_folder.join(file_name);
    // #345: block moves that land inside a locked root. Both source
    // and destination must be unlocked; the source was already gated
    // by `ensure_inside_vault` above.
    ensure_unlocked(state, &dest)?;

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

    // #277: same staleness fix as rename_file_impl. Watcher's rename event is
    // suppressed by write_ignore, so update the in-memory FileIndex directly.
    let vault_root = get_vault_root(state)?;
    sync_file_index_rename(state, &canonical_from, &dest, &vault_root);

    // #339: same dispatch parity as rename_file_impl.
    crate::commands::index_dispatch::dispatch_self_delete(state, &canonical_from).await;
    dispatch_new_side_after_rename(state, &dest, "move_file").await;

    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn move_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultState>,
    from: String,
    to_folder: String,
) -> Result<String, VaultError> {
    use tauri::Emitter;
    let old_canonical_for_event = std::fs::canonicalize(&from)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| from.clone());

    // move_file_impl handles the disk rename, FileIndex sync, AND the
    // index dispatch — see its doc for the contract split.
    let result = move_file_impl(&state, from, to_folder).await?;

    // #307: write_ignore (D-12) suppresses the watcher's natural rename
    // event. A move is reported as a rename with a new parent path.
    let _ = app.emit(
        crate::watcher::FILE_CHANGED_EVENT,
        crate::watcher::FileChangePayload {
            path: old_canonical_for_event,
            kind: "rename".to_string(),
            new_path: Some(result.clone()),
        },
    );

    Ok(result)
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
    // #345: hash the plaintext, not the ciphertext, so the frontend
    // conflict-detection hashes (which are always computed over
    // plaintext) match.
    let plaintext = crate::encryption::maybe_decrypt_read(state, &canonical, bytes)?;
    Ok(hash_bytes(&plaintext))
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
    // #357: attachments into an UNLOCKED encrypted folder are sealed
    // on the way to disk (same contract as `write_file`). Dropping into
    // a locked folder still errors via `maybe_encrypt_write`'s
    // `key_clone` → `PathLocked` fast path — in-app paste during lock
    // is a user error, distinct from the external-drop case handled by
    // the watcher's pending-queue.
    //
    // Size cap is enforced here too so a compromised frontend cannot
    // bypass the drop-path cap by calling `save_attachment` with a
    // multi-GB payload.
    crate::encryption::ensure_size_cap(&canonical_folder, bytes.len() as u64)?;

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

    // #357: seal the attachment bytes when the target sits inside an
    // unlocked encrypted root. Outside any encrypted folder this is a
    // zero-cost pass-through; inside a locked root this returns
    // `PathLocked` because the keyring has no entry — which is the
    // correct behaviour for an in-app paste into a locked folder.
    let bytes_on_disk = crate::encryption::maybe_encrypt_write(&state, &final_path, &bytes)?;

    std::fs::write(&final_path, &bytes_on_disk).map_err(|e| match e.kind() {
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

// ─── read_attachment_bytes ───────────────────────────────────────────────────

/// #357 — read raw bytes for an attachment, decrypting transparently
/// when the target lives in an unlocked encrypted folder.
///
/// Distinct from `read_file` because `read_file` is text-only (D-17):
/// it enforces `String::from_utf8` so a binary never enters the editor's
/// auto-save loop. Attachments (images, PDFs, video, audio) need raw
/// bytes, so the frontend uses this command for the four image/embed
/// render paths. Returns a `Vec<u8>` that the frontend wraps in a
/// `blob:` URL via `URL.createObjectURL`.
///
/// Security:
/// - T-02: `ensure_inside_vault` canonicalizes + enforces vault scope.
/// - #345: `maybe_decrypt_read` returns `PathLocked` for locked roots.
pub fn read_attachment_bytes_impl(state: &VaultState, path: String) -> Result<Vec<u8>, VaultError> {
    let target = PathBuf::from(&path);
    let canonical = ensure_inside_vault(state, &target)?;
    let bytes = std::fs::read(&canonical).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    // Transparent decrypt — pass-through for plain vaults.
    crate::encryption::maybe_decrypt_read(state, &canonical, bytes)
}

#[tauri::command]
pub async fn read_attachment_bytes(
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<Vec<u8>, VaultError> {
    read_attachment_bytes_impl(&state, path)
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

    // #345: count only unlocked .md files — see rename_file_impl for
    // rationale. Walker consults the shared registry.
    let skip_registry = Arc::clone(&state.locked_paths);
    let mut total: u32 = 0;
    for md_path in crate::indexer::walk_md_files_skipping(&vault_root, move |p| {
        let canon = CanonicalPath::assume_canonical(p.to_path_buf());
        skip_registry.is_locked(&canon)
    }) {
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
