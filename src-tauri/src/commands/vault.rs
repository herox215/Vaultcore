// Wave 1 vault commands: open_vault, get_recent_vaults, get_vault_stats.
//
// Security:
// - T-01 (path traversal): `open_vault` canonicalizes the user path before
//   storing it as the active vault, resolving symlinks and `..` segments.
// - T-01-01-E (fs plugin scope): after canonicalization, `open_vault` calls
//   `FsExt::allow_directory(&canonical, true)` at runtime so the Tauri fs
//   plugin's allow-list grows only to the exact directory the user picked.
//   Static scope in capabilities/default.json stays $APPDATA-only.
// - T-04 (JSON injection): recent-vaults.json is written via
//   `serde_json::to_string_pretty`; no string concatenation.
//
// Dependencies:
// - walkdir for the file-count pass (D-21 uses this same walk to emit
//   vault://index_progress events in Wave 4).
// - std::fs::canonicalize for path resolution (avoids adding a `dunce` dep).
// - Hand-rolled ISO-8601 formatter because D-19 forbids `chrono` and doesn't
//   allow-list `time`.

use crate::error::VaultError;
use crate::watcher;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;
use walkdir::{DirEntry, WalkDir};

#[derive(Serialize, Clone, Debug)]
pub struct VaultInfo {
    pub path: String,
    pub file_count: usize,
    pub file_list: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct VaultStats {
    pub path: String,
    pub file_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecentVault {
    pub path: String,
    pub last_opened: String,
}

#[derive(Serialize, Deserialize, Default)]
struct RecentVaultsFile {
    vaults: Vec<RecentVault>,
}

const MAX_RECENT: usize = 10;
const RECENT_VAULTS_FILENAME: &str = "recent-vaults.json";

// --- walkdir helpers --------------------------------------------------------

fn is_excluded(entry: &DirEntry) -> bool {
    // Skip any entry whose file name starts with `.` — that covers .git,
    // .obsidian, .trash, .DS_Store and friends. Depth 0 is the root and we
    // allow the caller to pass a dot-directory as the vault root itself.
    let name = entry.file_name().to_str().unwrap_or("");
    entry.depth() > 0 && name.starts_with('.')
}

/// Recursively count `.md` files under `root`, skipping dot-directories.
/// Used by `get_vault_stats` and `open_vault`; Wave 4 will reuse the same
/// iterator to emit `vault://index_progress` events.
pub fn count_md_files(root: &Path) -> usize {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e))
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .count()
}

/// Collect all `.md` file relative paths from the vault root, alphabetically sorted.
/// Forward-slash separators on all platforms for cross-platform consistency.
/// Skips dot-prefixed directories at any depth (D-14 / RESEARCH §4.1).
pub fn collect_file_list(root: &Path) -> Vec<String> {
    let mut paths: Vec<String> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e))
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .filter_map(|e| {
            e.path()
                .strip_prefix(root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    paths.sort();
    paths
}

// --- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub async fn get_vault_stats(path: String) -> Result<VaultStats, VaultError> {
    let p = PathBuf::from(&path);
    if !p.exists() || !p.is_dir() {
        return Err(VaultError::VaultUnavailable { path });
    }
    let file_count = count_md_files(&p);
    Ok(VaultStats { path, file_count })
}

#[tauri::command]
pub async fn open_vault(
    app: AppHandle,
    state: tauri::State<'_, crate::VaultState>,
    path: String,
) -> Result<VaultInfo, VaultError> {
    let p = PathBuf::from(&path);
    // T-01 mitigation: canonicalize to resolve `..` and symlinks.
    let canonical = std::fs::canonicalize(&p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::VaultUnavailable { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    if !canonical.is_dir() {
        return Err(VaultError::VaultUnavailable { path });
    }

    // T-01-01-E mitigation: grant Tauri fs plugin scope ONLY to the
    // canonical vault path, recursively. Without this, the frontend's
    // future @tauri-apps/plugin-fs calls would be refused.
    app.fs_scope().allow_directory(&canonical, true).map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;

    // Persist as the active vault (files commands read from here).
    {
        let mut guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
        *guard = Some(canonical.clone());
    }

    // Push to recent-vaults.json
    let canonical_str = canonical.to_string_lossy().into_owned();
    push_recent_vault(&app, &canonical_str)?;

    // --- Tantivy indexing via IndexCoordinator ---
    // Always recreate the coordinator so switching vaults doesn't reuse the
    // previous vault's Tantivy index directory, in-memory FileIndex,
    // LinkGraph or TagIndex (#38).
    //
    // Order matters: drop the old watcher BEFORE the old coordinator. The
    // watcher holds a clone of the coordinator's write-queue sender; if the
    // coordinator is dropped first, the watcher's clone keeps the channel
    // alive and the writer task only exits when it processes the Shutdown
    // command queued by IndexCoordinator::drop. Dropping the watcher first
    // means the Shutdown is the last surviving message on a soon-to-close
    // channel, so the old Tantivy writer releases its directory lock
    // promptly — important for re-opening the same vault.
    {
        let mut handle = state.watcher_handle.lock().map_err(|_| VaultError::LockPoisoned)?;
        *handle = None; // drops old debouncer, stops previous watch
    }

    // Drop the previous coordinator before the lock guard goes out of scope so
    // its `Drop`-time Shutdown is sent before we try to acquire a new writer
    // on the same vault directory. The `acquire_writer_with_retry` inside the
    // new `IndexCoordinator::new` will retry through the brief window where
    // the old writer is still draining, but releasing earlier shortens it.
    {
        let mut guard = state.index_coordinator.lock().map_err(|_| VaultError::LockPoisoned)?;
        *guard = None;
    }
    // #345: reload the encrypted-folders manifest into the shared
    // registry BEFORE the indexer's cold-start walk so encrypted
    // subtrees are pruned from the very first pass. All encrypted
    // roots start locked — no persistence of unlocked state across
    // restart.
    if let Err(e) = crate::commands::encryption::reload_manifest_and_lock_all(&state, &canonical) {
        log::warn!("encrypted-folders manifest reload failed: {e:?}");
    }

    // #277: hand the coordinator the state-owned FileIndex so user-initiated
    // rename/move updates land in the same map the coordinator reads from.
    let mut coordinator = crate::indexer::IndexCoordinator::new_with_file_index(
        &canonical,
        std::sync::Arc::clone(&state.file_index),
    )
    .await
    .map_err(|e| {
        log::error!("Failed to create IndexCoordinator: {e:?}");
        e
    })?;
    // #345: wire the shared registry so index_vault's cold-start walker
    // prunes locked subtrees.
    coordinator.set_locked_paths(std::sync::Arc::clone(&state.locked_paths));

    let vault_info = coordinator.index_vault(&canonical, &app).await.map_err(|e| {
        log::error!("index_vault failed: {e:?}");
        e
    })?;

    // Put the coordinator back into state.
    {
        let mut guard = state.index_coordinator.lock().map_err(|_| VaultError::LockPoisoned)?;
        *guard = Some(coordinator);
    }

    // --- Embed-on-save coordinator (#196) ---
    // Spawn after the index coordinator so a vault open without bundled
    // embedding assets still succeeds. Drop the previous coordinator
    // before spawning the new one so the old worker shuts down cleanly
    // (mirrors the IndexCoordinator drop-then-replace pattern above).
    //
    // #244: only arm the embed stack when the semantic-search toggle is
    // on. Otherwise the full ~200-400 MB of model weights + ORT session
    // gets loaded for users who never want semantic search.
    #[cfg(feature = "embeddings")]
    {
        // Always tear down first so the previous vault's coordinator +
        // query_handles + reindex worker release their handles before we
        // decide whether to re-arm. Safe to call even on a fresh process.
        crate::embeddings::teardown_for_disable(&state);
        if read_semantic_enabled(&app) {
            spawn_embeddings_for_vault(&app, &state, &canonical, vault_info.file_count)?;
        }
    }

    // --- Spawn file watcher (Plan 04) ---

    // Clone the index_tx sender for the watcher so it can dispatch
    // IndexCmd::UpdateLinks / RemoveLinks on file events (LINK-08).
    let index_tx = {
        let guard = state.index_coordinator.lock().map_err(|_| VaultError::LockPoisoned)?;
        guard.as_ref().map(|c| c.tx.clone())
    };

    // #201 PR-A: snapshot the embed coordinator's Sender so the watcher
    // can dispatch EmbedOp::Delete for externally-initiated file
    // removes / renames. None when embeddings are disabled or the
    // coordinator didn't spawn (no bundled model / ORT init failed).
    #[cfg(feature = "embeddings")]
    let embed_tx = {
        let guard = state
            .embed_coordinator
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.as_ref().map(|c| c.tx.clone())
    };

    let debouncer = watcher::spawn_watcher(
        app.clone(),
        canonical.clone(),
        state.write_ignore.clone(),
        state.vault_reachable.clone(),
        index_tx,
        #[cfg(feature = "embeddings")]
        embed_tx,
        state.locked_paths.clone(),
    );
    *state.watcher_handle.lock().map_err(|_| VaultError::LockPoisoned)? = Some(debouncer);

    *state.vault_reachable.lock().map_err(|_| VaultError::LockPoisoned)? = true;

    Ok(vault_info)
}

#[tauri::command]
pub async fn get_recent_vaults(app: AppHandle) -> Result<Vec<RecentVault>, VaultError> {
    let file = recent_vaults_path(&app)?;
    read_recent_vaults_at(&file)
}

/// Delete the on-disk Tantivy index and version stamp for `vault_path` so
/// that the next `open_vault` call rebuilds them from scratch.
///
/// Called by the frontend after an `IndexCorrupt` error — the UI shows a
/// confirmation dialog, then calls this command, then retries `open_vault`.
/// The coordinator for this vault is never kept across the error (the failed
/// `IndexCoordinator::new` never stored anything in `state.index_coordinator`),
/// so this is safe to call without touching the coordinator mutex.
#[tauri::command]
pub async fn repair_vault_index(vault_path: String) -> Result<(), VaultError> {
    let root = PathBuf::from(&vault_path);
    let root = root.canonicalize().map_err(VaultError::Io)?;
    let vaultcore = root.join(".vaultcore");
    let index_dir = vaultcore.join("index").join("tantivy");
    let version_file = vaultcore.join("index_version.json");
    if index_dir.exists() {
        std::fs::remove_dir_all(&index_dir).map_err(VaultError::Io)?;
    }
    if version_file.exists() {
        let _ = std::fs::remove_file(&version_file);
    }
    Ok(())
}

// --- recent-vaults.json persistence -----------------------------------------

fn recent_vaults_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    let dir = app.path().app_data_dir().map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;
    std::fs::create_dir_all(&dir).map_err(VaultError::Io)?;
    Ok(dir.join(RECENT_VAULTS_FILENAME))
}

fn read_recent_vaults_at(file: &Path) -> Result<Vec<RecentVault>, VaultError> {
    if !file.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(file).map_err(VaultError::Io)?;
    // Tolerate a malformed file rather than crash on first run after an
    // aborted write: fall back to an empty list. The next successful push
    // will overwrite it with clean JSON.
    let data: RecentVaultsFile = serde_json::from_str(&raw).unwrap_or_default();
    Ok(data.vaults)
}

fn write_recent_vaults_at(file: &Path, vaults: &[RecentVault]) -> Result<(), VaultError> {
    let data = RecentVaultsFile {
        vaults: vaults.to_vec(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;
    std::fs::write(file, json).map_err(VaultError::Io)
}

/// Push `path` to the front of the recent-vaults list at `file`.
/// - De-dupes by path (removes any existing entry before prepending)
/// - Caps the list at MAX_RECENT, evicting oldest
/// - Returns the new list
///
/// Exposed to tests (not pub(crate)) because tests/vault_stats.rs drives it
/// directly with a tempdir.
pub fn push_recent_vault_to(
    file: &Path,
    path: &str,
    now_iso: String,
) -> Result<Vec<RecentVault>, VaultError> {
    let mut vaults = read_recent_vaults_at(file)?;
    vaults.retain(|v| v.path != path);
    vaults.insert(
        0,
        RecentVault {
            path: path.to_string(),
            last_opened: now_iso,
        },
    );
    if vaults.len() > MAX_RECENT {
        vaults.truncate(MAX_RECENT);
    }
    write_recent_vaults_at(file, &vaults)?;
    Ok(vaults)
}

fn push_recent_vault(app: &AppHandle, path: &str) -> Result<Vec<RecentVault>, VaultError> {
    let file = recent_vaults_path(app)?;
    let now = chrono_like_iso();
    push_recent_vault_to(&file, path, now)
}

// --- ISO-8601 formatter (hand-rolled, std-only) -----------------------------

/// RFC 3339 / ISO-8601 UTC timestamp without pulling in `chrono` (D-19 forbids
/// it) and without adding a `time` crate dep (not in the D-19 Phase 1 allow-list).
/// Format: `YYYY-MM-DDTHH:MM:SSZ`. Valid for years 1970..9999.
fn chrono_like_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_iso8601_utc(secs)
}

/// Epoch-seconds → `YYYY-MM-DDTHH:MM:SSZ`. Pure std, no deps.
/// Based on Howard Hinnant's `civil_from_days`
/// (http://howardhinnant.github.io/date_algorithms.html).
pub(crate) fn format_iso8601_utc(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let tod = epoch_secs.rem_euclid(86_400);
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;

    // Shift epoch day 0 (1970-01-01) to era-based origin (0000-03-01).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if mo <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, mo, d, h, m, s
    )
}

// ─── merge_external_change command ───────────────────────────────────────────

/// Result returned by the merge_external_change command.
///
/// Tagged enum: `outcome` discriminates, and each variant carries exactly
/// the payload that makes sense for it. Clean always has a `new_hash` (the
/// backend wrote the merged bytes to disk); Conflict never does (the
/// backend left disk untouched). Serialized shape:
///
/// - `{ "outcome": "clean",    "merged_content": "...", "new_hash": "..." }`
/// - `{ "outcome": "conflict", "merged_content": "..." }`
///
/// The frontend consumer in `externalChangeHandler.ts` narrows on
/// `outcome` before reading variant-specific fields.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum MergeCommandResult {
    /// Three-way merge produced a non-conflicting result. The backend has
    /// written `merged_content` to disk; `new_hash` is SHA-256 of those
    /// bytes (matches `hash_bytes` / the value `write_file` returns, so
    /// callers can align `lastSavedHash` without hashing client-side).
    Clean {
        merged_content: String,
        new_hash: String,
    },
    /// Merge could not be resolved without overlap. Backend did NOT write.
    /// `merged_content` here is the local (editor) content — the caller
    /// keeps it and lets the next autosave write through deliberately.
    Conflict { merged_content: String },
}

/// Perform a three-way merge for an external file change.
///
/// Called by EditorPane when the file watcher reports an external modification.
/// - `path`: absolute path to the modified file
/// - `editor_content`: current contents of the editor buffer (left / local)
/// - `last_saved_content`: base snapshot — the content that was last written to disk
///   by this session (used as the diff anchor)
///
/// Security: path is validated to be inside the open vault before reading disk
/// content (T-02-18 mitigation).
///
/// Issue #339: on a clean merge the backend now *writes the merged bytes to
/// disk itself* and dispatches the same IndexCmd updates `write_file` does.
/// The frontend no longer writes on clean-merge; it consumes `new_hash` and
/// aligns its `lastSavedHash` tracker. The watcher-driven event for our own
/// write is suppressed by `write_ignore` (D-12); dispatching inline here is
/// what keeps the in-memory LinkGraph / TagIndex / Tantivy index in sync.
#[tauri::command]
pub async fn merge_external_change(
    state: tauri::State<'_, crate::VaultState>,
    path: String,
    editor_content: String,
    last_saved_content: String,
) -> Result<MergeCommandResult, crate::error::VaultError> {
    merge_external_change_impl(&state, path, editor_content, last_saved_content).await
}

/// Testable body of `merge_external_change`. See the note in
/// `commands/files.rs:16-20` on the `tauri::State`-can't-be-constructed
/// convention.
pub(crate) async fn merge_external_change_impl(
    state: &crate::VaultState,
    path: String,
    editor_content: String,
    last_saved_content: String,
) -> Result<MergeCommandResult, crate::error::VaultError> {
    use crate::merge::{three_way_merge, MergeOutcome};

    // T-02-18 mitigation: validate path is inside vault
    let vault_path = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| crate::error::VaultError::LockPoisoned)?;
        guard.clone().ok_or_else(|| crate::error::VaultError::VaultUnavailable {
            path: path.clone(),
        })?
    };

    let target = PathBuf::from(&path);
    let canonical = std::fs::canonicalize(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => crate::error::VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => crate::error::VaultError::PermissionDenied { path: path.clone() },
        _ => crate::error::VaultError::Io(e),
    })?;

    if !canonical.starts_with(&vault_path) {
        return Err(crate::error::VaultError::PermissionDenied { path });
    }

    // Read current disk content (the "right" / external version)
    let disk_content = std::fs::read_to_string(&canonical).map_err(crate::error::VaultError::Io)?;

    // Perform three-way merge: base=last_saved, left=editor, right=disk
    let merge_result = three_way_merge(&last_saved_content, &editor_content, &disk_content);

    match merge_result {
        MergeOutcome::Clean(merged) => {
            let is_md = canonical
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"));

            // D-12 / BUG-05.1: record write_ignore BEFORE the disk write so
            // the watcher's resulting modify event gets suppressed. Without
            // this the watcher path + the inline dispatch below would both
            // fire UpdateLinks for the same content — harmless but noisy.
            if let Ok(mut list) = state.write_ignore.lock() {
                list.record(canonical.clone());
            }

            let bytes = merged.as_bytes();
            std::fs::write(&canonical, bytes).map_err(|e| match e.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    crate::error::VaultError::PermissionDenied { path: path.clone() }
                }
                std::io::ErrorKind::StorageFull => crate::error::VaultError::DiskFull,
                _ => crate::error::VaultError::Io(e),
            })?;

            // Index dispatch — write_ignore suppresses the watcher, so we
            // dispatch LinkGraph + TagIndex + Tantivy updates ourselves.
            if is_md {
                crate::commands::index_dispatch::dispatch_self_write(
                    state,
                    &canonical,
                    &merged,
                )
                .await;
            }

            // #196 parity: re-embed the merged content (non-blocking).
            #[cfg(feature = "embeddings")]
            if is_md {
                crate::commands::files::dispatch_embed_update(
                    state,
                    canonical.clone(),
                    &merged,
                );
            }

            let new_hash = crate::hash::hash_bytes(bytes);

            Ok(MergeCommandResult::Clean {
                merged_content: merged,
                new_hash,
            })
        }
        MergeOutcome::Conflict(local) => {
            // No disk write, no dispatch. The watcher already dispatched
            // UpdateLinks/UpdateTags for the external content when the
            // event fired; the local buffer doesn't live on disk until the
            // user resolves the conflict with a later save (which goes
            // through `write_file` and dispatches its own updates). If the
            // watcher dropped its dispatch via channel overflow (#139),
            // the graph is transiently stale here — that's #139's territory,
            // not this fix's.
            Ok(MergeCommandResult::Conflict {
                merged_content: local,
            })
        }
    }
}


// ─── #201 PR-B: reindex IPC ──────────────────────────────────────────────────

/// Start a resumable initial-embed pass over the currently-open vault.
///
/// Cancels any prior running reindex before spawning. Progress is
/// streamed to the frontend via `embed://reindex_progress` Tauri events
/// (payload: `ReindexProgress`). The call returns as soon as the worker
/// has been parked on its thread; the frontend drives the lifecycle
/// entirely through events + `cancel_reindex`.
///
/// No-op (returns `Ok`) when the embeddings feature is on but the
/// coordinator didn't spawn (no bundled model / ORT init failed).
#[cfg(feature = "embeddings")]
#[tauri::command]
pub async fn reindex_vault(
    app: AppHandle,
    state: tauri::State<'_, crate::VaultState>,
) -> Result<(), VaultError> {
    use tauri::Emitter;

    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.clone().ok_or_else(|| VaultError::VaultUnavailable {
            path: String::new(),
        })?
    };

    // Cancel any prior reindex so the new one owns the checkpoint.
    {
        let mut guard = state
            .reindex_handle
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        if let Some(h) = guard.take() {
            h.cancel();
        }
    }

    let coord_parts = {
        let guard = state
            .embed_coordinator
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard
            .as_ref()
            .map(|c| (c.tx.clone(), std::sync::Arc::clone(&c.pending)))
    };
    let Some((tx, pending)) = coord_parts else {
        log::warn!("reindex_vault: embedding coordinator unavailable; no-op");
        return Ok(());
    };

    let checkpoint_dir = vault_root.join(".vaultcore").join("embeddings");
    let app_for_progress = app.clone();
    let pending_for_bp = std::sync::Arc::clone(&pending);

    let handle = crate::embeddings::start_reindex_with_backpressure(
        vault_root,
        checkpoint_dir,
        move |batch| {
            let probe = crate::embeddings::EmbedCoordinator {
                tx: tx.clone(),
                pending: std::sync::Arc::clone(&pending),
            };
            // PR-D: a full batch arrives as a single bulk insert so the
            // embedder drains many files per wake-up instead of one.
            // Closed → checkpoint not advanced; next reindex retries.
            match probe.enqueue_bulk(batch) {
                Ok(_) => true,
                Err(e) => {
                    log::warn!("reindex enqueue_bulk: {e}");
                    false
                }
            }
        },
        move |progress| {
            if let Err(e) = app_for_progress.emit("embed://reindex_progress", progress) {
                log::debug!("reindex_progress emit dropped: {e}");
            }
        },
        move || {
            pending_for_bp
                .lock()
                .map(|g| g.len())
                .unwrap_or(0)
        },
    );

    let mut guard = state
        .reindex_handle
        .lock()
        .map_err(|_| VaultError::LockPoisoned)?;
    *guard = Some(handle);
    Ok(())
}

/// Cooperatively cancel any running reindex. Safe to call when no
/// reindex is in flight (no-op). The worker flushes its checkpoint
/// before exiting, so the next `reindex_vault` resumes from there.
#[cfg(feature = "embeddings")]
#[tauri::command]
pub async fn cancel_reindex(
    state: tauri::State<'_, crate::VaultState>,
) -> Result<(), VaultError> {
    let mut guard = state
        .reindex_handle
        .lock()
        .map_err(|_| VaultError::LockPoisoned)?;
    if let Some(h) = guard.take() {
        h.cancel();
    }
    Ok(())
}

// ─── #244: semantic-search toggle ────────────────────────────────────────────

const SEMANTIC_ENABLED_FILENAME: &str = "semantic-enabled.json";

#[derive(Serialize, Deserialize, Default)]
struct SemanticEnabledFile {
    enabled: bool,
}

fn semantic_enabled_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir.join(SEMANTIC_ENABLED_FILENAME))
}

/// Read the persisted semantic-search toggle. Defaults to `false` on any
/// I/O or parse failure so a tampered file can't force the expensive
/// embed-init path on behalf of the user.
#[cfg_attr(not(feature = "embeddings"), allow(dead_code))]
pub(crate) fn read_semantic_enabled(app: &AppHandle) -> bool {
    let Some(file) = semantic_enabled_path(app) else { return false };
    let Ok(raw) = std::fs::read_to_string(&file) else { return false };
    serde_json::from_str::<SemanticEnabledFile>(&raw)
        .map(|f| f.enabled)
        .unwrap_or(false)
}

fn write_semantic_enabled(app: &AppHandle, enabled: bool) -> Result<(), VaultError> {
    let Some(file) = semantic_enabled_path(app) else {
        return Err(VaultError::Io(std::io::Error::other(
            "app_data_dir unavailable",
        )));
    };
    let json = serde_json::to_string_pretty(&SemanticEnabledFile { enabled })
        .map_err(|e| VaultError::Io(std::io::Error::other(e.to_string())))?;
    std::fs::write(&file, json).map_err(VaultError::Io)
}

/// Build the embed coordinator + query handles for `vault_root` and park
/// them in `state`. Assumes the caller already tore down any previous
/// coordinator via `teardown_for_disable`.
///
/// Non-fatal: on `EmbeddingService::load` failure (no dylib, no model,
/// ORT init failed) the state slots stay `None` and the caller treats
/// embed-on-save as disabled for this vault. The return is still `Ok`.
#[cfg(feature = "embeddings")]
fn spawn_embeddings_for_vault(
    app: &AppHandle,
    state: &crate::VaultState,
    vault_root: &Path,
    file_count: usize,
) -> Result<(), VaultError> {
    let resource_dir = app.path().resource_dir().ok();
    let svc = crate::embeddings::EmbeddingService::load(resource_dir.as_deref());
    let chk = crate::embeddings::Chunker::load(resource_dir.as_deref());
    match (svc, chk) {
        (Ok(svc), Ok(chk)) => {
            use std::sync::Arc;
            // #201 PR-A: HNSW-backed sink under <vault>/.vaultcore/embeddings/.
            // capacity_hint of 4×file_count assumes the average note
            // produces ~4 chunks (#195 splits at 254 content tokens
            // ≈ 800 words). It only sizes initial allocations — real
            // growth past it is supported.
            let embed_dir = vault_root.join(".vaultcore").join("embeddings");
            let cap = file_count.saturating_mul(4).max(64);
            // #202: keep a concrete `Arc<HnswSink>` alongside the
            // `Arc<dyn VectorSink>` handed to the coordinator so the
            // `semantic_search` IPC handler can call `snapshot()`
            // without widening the trait. Both Arcs share one alloc.
            let sink_concrete = Arc::new(crate::embeddings::HnswSink::open(embed_dir.clone(), cap));
            // #286: reconcile the reindex checkpoint against the vectors
            // actually present in the just-loaded index. Drops phantom
            // skip claims so the next reindex re-embeds files whose
            // vectors were lost to a truncated save or a crash — the
            // self-healing path that makes the pipeline eventually
            // consistent regardless of teardown races.
            let live = sink_concrete.live_paths();
            match crate::embeddings::reconcile_checkpoint_with_live_paths(
                &embed_dir,
                vault_root,
                &live,
            ) {
                Ok(0) => {}
                Ok(n) => log::info!(
                    "embeddings: reconciled checkpoint on open — dropped {n} phantom entries"
                ),
                Err(e) => log::warn!(
                    "embeddings: checkpoint reconciliation failed: {e}"
                ),
            }
            let sink: Arc<dyn crate::embeddings::VectorSink> =
                Arc::clone(&sink_concrete) as Arc<dyn crate::embeddings::VectorSink>;
            let svc_for_query = Arc::clone(&svc);
            let coord = crate::embeddings::EmbedCoordinator::spawn(svc, chk, sink);
            {
                let mut guard = state
                    .embed_coordinator
                    .lock()
                    .map_err(|_| VaultError::LockPoisoned)?;
                *guard = Some(coord);
            }
            let handles = Arc::new(crate::embeddings::QueryHandles {
                service: svc_for_query,
                sink: sink_concrete,
            });
            let mut guard = state
                .query_handles
                .lock()
                .map_err(|_| VaultError::LockPoisoned)?;
            *guard = Some(handles);
        }
        (Err(e), _) | (_, Err(e)) => {
            log::warn!("embed-on-save disabled: {e}");
        }
    }
    Ok(())
}

/// Persist the semantic-search toggle and (re)arm or tear down the
/// embedding stack for the currently-open vault to match.
///
/// Toggle flow:
/// - `false`: cancel any running reindex, drop `embed_coordinator` and
///   `query_handles`. The `EmbeddingService` Arc is released so the ONNX
///   session (model weights + arenas, ~200-400 MB) is freed. The global
///   ORT env remains mapped for the rest of the process lifetime — that's
///   an `ort::init_from` design constraint; see #244.
/// - `true`: if a vault is currently open and the coordinator isn't
///   already armed, load the service and spawn the coordinator. No-op if
///   the model isn't bundled.
#[cfg(feature = "embeddings")]
#[tauri::command]
pub async fn set_semantic_enabled(
    app: AppHandle,
    state: tauri::State<'_, crate::VaultState>,
    enabled: bool,
) -> Result<(), VaultError> {
    write_semantic_enabled(&app, enabled)?;
    if !enabled {
        crate::embeddings::teardown_for_disable(&state);
        return Ok(());
    }
    // enabled == true: arm the stack iff a vault is open and no
    // coordinator is already there (idempotent — toggling on-on is safe).
    let already_armed = {
        let guard = state
            .embed_coordinator
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.is_some()
    };
    if already_armed {
        return Ok(());
    }
    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.clone()
    };
    if let Some(root) = vault_root {
        let file_count = count_md_files(&root);
        spawn_embeddings_for_vault(&app, &state, &root, file_count)?;
    }
    Ok(())
}

/// `embeddings` feature disabled → persist the flag but do nothing
/// else, so the IPC surface and on-disk layout stay stable across builds.
#[cfg(not(feature = "embeddings"))]
#[tauri::command]
pub async fn set_semantic_enabled(
    app: AppHandle,
    _state: tauri::State<'_, crate::VaultState>,
    enabled: bool,
) -> Result<(), VaultError> {
    write_semantic_enabled(&app, enabled)
}

// ─── #286: wipe + rebuild all embeddings ─────────────────────────────────────

/// Blow away `<vault>/.vaultcore/embeddings/` (checkpoint + mapping +
/// hnsw dumps), re-arm the embedding stack, and kick off a full reindex
/// of every `.md` file. User-facing escape hatch for the drift bug in
/// #286 and the canonical recovery path whenever the index is suspected
/// to be out of sync with the vault.
///
/// Flow:
/// 1. Tear down the current embedding stack (cancel+join reindex, flush
///    sink, drop coordinator + query handles). Safe even when semantic
///    search is toggled off: we're about to delete files on disk.
/// 2. Remove the entire `.vaultcore/embeddings/` directory, ignoring
///    "not found" so a missing dir is a no-op.
/// 3. If semantic search is still enabled, re-spawn the embedding stack
///    (which rebuilds an empty on-disk state via `HnswSink::open`) and
///    invoke `reindex_vault` to embed every file from scratch.
///
/// No-op with a warning log when no vault is open. When the embeddings
/// feature is compiled out, the command just clears the directory so the
/// IPC surface stays stable.
#[cfg(feature = "embeddings")]
#[tauri::command]
pub async fn refresh_all_embeddings(
    app: AppHandle,
    state: tauri::State<'_, crate::VaultState>,
) -> Result<(), VaultError> {
    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.clone()
    };
    let Some(root) = vault_root else {
        log::warn!("refresh_all_embeddings: no vault open; ignoring");
        return Ok(());
    };

    // 1. Tear down (cancel+join reindex, flush + drop sink).
    crate::embeddings::teardown_for_disable(&state);

    // 2. Wipe the on-disk embeddings dir. Tolerate "not found" so a
    //    first-time refresh on a fresh vault still works.
    let embed_dir = root.join(".vaultcore").join("embeddings");
    match std::fs::remove_dir_all(&embed_dir) {
        Ok(()) => log::info!(
            "refresh_all_embeddings: wiped {}",
            embed_dir.display()
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!(
                "refresh_all_embeddings: wiping {} failed: {e}",
                embed_dir.display()
            );
            return Err(VaultError::Io(e));
        }
    }

    // 3. Re-arm and reindex iff semantic search is still enabled — the
    //    user may click Refresh while the toggle is off (unusual but
    //    harmless; the disk wipe stands).
    if read_semantic_enabled(&app) {
        let file_count = count_md_files(&root);
        spawn_embeddings_for_vault(&app, &state, &root, file_count)?;
        reindex_vault(app, state).await?;
    }
    Ok(())
}

#[cfg(not(feature = "embeddings"))]
#[tauri::command]
pub async fn refresh_all_embeddings(
    _app: AppHandle,
    state: tauri::State<'_, crate::VaultState>,
) -> Result<(), VaultError> {
    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.clone()
    };
    if let Some(root) = vault_root {
        let embed_dir = root.join(".vaultcore").join("embeddings");
        match std::fs::remove_dir_all(&embed_dir) {
            Ok(()) | Err(_) => {}
        }
    }
    Ok(())
}
