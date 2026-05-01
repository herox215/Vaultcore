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
    // #392 PR-B: parse the input as a VaultHandle. On Android the
    // `content://` heuristic short-circuits canonicalize; everything
    // else flows through the existing POSIX path. The Android branch
    // bails out of the desktop-only setup (fs_scope, watcher, manifest
    // reload, embeddings purge, indexer cold-start) and returns a
    // bare-bones VaultInfo so the user can read/edit/save markdown
    // without the full desktop feature surface.
    let handle = crate::storage::VaultHandle::parse(&path)?;

    #[cfg(target_os = "android")]
    if let crate::storage::VaultHandle::ContentUri(ref uri) = handle {
        return open_vault_android(app, state, uri.clone(), path).await;
    }

    // Desktop path: extract the canonical PathBuf and proceed with the
    // existing flow unchanged.
    let canonical = handle.expect_posix().to_path_buf();
    if !canonical.is_dir() {
        return Err(VaultError::VaultUnavailable { path });
    }

    // T-01-01-E mitigation: grant Tauri fs plugin scope ONLY to the
    // canonical vault path, recursively. Without this, the frontend's
    // future @tauri-apps/plugin-fs calls would be refused. Desktop-only
    // because @tauri-apps/plugin-fs's JS surface isn't used on Android
    // (every file op routes through `commands/files.rs` → VaultStorage).
    app.fs_scope().allow_directory(&canonical, true).map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;

    // #392 PR-A: atomically persist the active vault + storage handle.
    // `set_open_vault` takes both locks in a fixed order so a
    // concurrent reader never sees `current_vault` and `storage`
    // pointing at different vaults — relevant to PR-B which reads both
    // during file commands.
    state.set_open_vault(
        crate::storage::VaultHandle::Posix(canonical.clone()),
        std::sync::Arc::new(crate::storage::PosixStorage::new(canonical.clone())),
    )?;

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

    // #353: purge the legacy `.vaultcore/embeddings/` directory left
    // behind by the removed semantic-search feature. Best-effort — a
    // missing directory is the common case on fresh installs.
    purge_legacy_embeddings_dir(&canonical);

    // --- Spawn file watcher (Plan 04) ---

    // Clone the index_tx sender for the watcher so it can dispatch
    // IndexCmd::UpdateLinks / RemoveLinks on file events (LINK-08).
    let index_tx = {
        let guard = state.index_coordinator.lock().map_err(|_| VaultError::LockPoisoned)?;
        guard.as_ref().map(|c| c.tx.clone())
    };

    let debouncer = watcher::spawn_watcher(
        app.clone(),
        canonical.clone(),
        state.write_ignore.clone(),
        state.vault_reachable.clone(),
        index_tx,
        watcher::WatcherContext {
            locked_paths: state.locked_paths.clone(),
            keyring: state.keyring.clone(),
            pending_queue: state.pending_queue.clone(),
            manifest_cache: state.manifest_cache.clone(),
        },
    );
    *state.watcher_handle.lock().map_err(|_| VaultError::LockPoisoned)? = Some(debouncer);

    *state.vault_reachable.lock().map_err(|_| VaultError::LockPoisoned)? = true;

    Ok(vault_info)
}

// #392 PR-B: Android-specific open_vault flow. Verifies the persisted
// SAF permission is still in place, takes a fresh idempotent grant,
// constructs an AndroidStorage backed by the SAF tree URI, and bypasses
// the desktop-only setup (fs_scope, Tantivy cold-start indexer, watcher
// spawn, encrypted-folders manifest reload, embeddings purge).
//
// Cold-start indexing is deferred to the lazy-on-open follow-up
// (#392 follow-up). The returned VaultInfo carries file_count = 0 +
// empty file_list so the frontend's "vault loaded" UI states render
// without a tree population. Per-file index updates via dispatch_self_*
// keep the index populated as the user opens files.
#[cfg(target_os = "android")]
async fn open_vault_android(
    app: AppHandle,
    state: tauri::State<'_, crate::VaultState>,
    uri: String,
    original_path: String,
) -> Result<VaultInfo, VaultError> {
    use crate::storage::AndroidStorage;
    use crate::storage::VaultHandle;

    // Permission acquisition strategy. Two scenarios feed this path:
    //
    // 1. First-time open from a fresh Document Picker result: the URI
    //    has a TRANSIENT grant that hasn't been promoted to persisted
    //    yet. `getPersistedUriPermissions` does NOT list it. `take`
    //    succeeds, promoting it.
    // 2. Re-open from recent-vaults.json: URI already persisted on a
    //    previous run. `take` is idempotent (Android docs recommend
    //    re-taking to extend lifetime).
    // 3. Revoked grant (Settings or reinstall): URI not in persisted
    //    list AND `take` throws SecurityException because the
    //    transient grant from the original pick is gone too.
    //
    // We attempt `take` first. If it succeeds, the URI is persisted
    // and usable. If it throws, fall back to `has` to distinguish the
    // revoked case from a rare transient SAF error. The previous
    // ordering (has → take) failed scenario 1: `has` returned false
    // on the very first open because the grant wasn't persisted yet.
    if let Err(take_err) = AndroidStorage::take_persistable_uri_permission(&app, &uri) {
        if !AndroidStorage::has_persisted_permission(&app, &uri).unwrap_or(false) {
            return Err(VaultError::VaultPermissionRevoked { uri });
        }
        return Err(take_err);
    }

    let app_local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| VaultError::Io(std::io::Error::other(e.to_string())))?;
    let storage = AndroidStorage::new(&app, uri.clone(), &app_local_data)?;
    let storage_arc: std::sync::Arc<dyn crate::storage::VaultStorage> =
        std::sync::Arc::new(storage);

    state.set_open_vault(
        VaultHandle::ContentUri(uri.clone()),
        std::sync::Arc::clone(&storage_arc),
    )?;

    // recent-vaults.json stores the URI verbatim — VaultHandle::parse
    // round-trips it via the content:// heuristic on next open.
    push_recent_vault(&app, &uri)?;

    // Bootstrap the per-vault home canvas + bundled docs page. The
    // desktop indexer cold-start handles this for POSIX vaults; on
    // Android the indexer is skipped (mmap-incompatible), so we run the
    // storage-trait variants directly. Failures are non-fatal — a logged
    // warning matches the desktop semantics, and the user can still open
    // their notes without these auxiliary files.
    if let Err(e) = crate::indexer::ensure_home_canvas_via_storage(
        storage_arc.as_ref(),
        &display_name_from_content_uri(&uri),
    ) {
        log::warn!("ensure_home_canvas_via_storage failed: {e:?}");
    }
    if let Err(e) = crate::indexer::ensure_docs_page_via_storage(storage_arc.as_ref()) {
        log::warn!("ensure_docs_page_via_storage failed: {e:?}");
    }

    *state.vault_reachable.lock().map_err(|_| VaultError::LockPoisoned)? = true;

    // PR-B v1: stub VaultInfo. Cold-start indexing is deferred — the
    // frontend gets an empty file_list and the user sees their vault
    // tree populate as they navigate / open files (per-file index
    // updates via dispatch_self_write). Documented as a known
    // limitation in MOBILE_BUILD.md.
    let _ = original_path; // unused on this path; kept for symmetry
    Ok(VaultInfo {
        path: uri,
        file_count: 0,
        file_list: Vec::new(),
    })
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

// --- Android URI helpers ----------------------------------------------------

/// Extract a human-friendly display name from a SAF tree URI.
/// `content://com.android.externalstorage.documents/tree/primary%3ATest`
/// → `"Test"`. Mirrors the frontend's `deriveVaultName` so the seeded
/// home.canvas welcome heading matches the sidebar label.
#[cfg(target_os = "android")]
fn display_name_from_content_uri(uri: &str) -> String {
    let last = uri.rsplit('/').next().unwrap_or(uri);
    let decoded = percent_decode(last);
    match decoded.find(':') {
        Some(idx) => {
            let tail = &decoded[idx + 1..];
            if tail.is_empty() { decoded.clone() } else { tail.to_string() }
        }
        None => decoded,
    }
}

/// Minimal RFC 3986 percent-decoder for SAF tree-URI segments. Only
/// %XX hex pairs are decoded — invalid sequences pass through. Output
/// is treated as UTF-8; non-UTF-8 byte sequences fall back to the raw
/// input. SAF segments are short (single path component), so a small
/// allocator is fine.
#[cfg(target_os = "android")]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
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

    // #392 PR-B: merge_external_change is fired by the watcher when an
    // external edit is detected. On Android there's no watcher, so this
    // command should never reach here in normal flow — but if the
    // frontend retries from a stale event after switching vaults, we
    // surface a clear error instead of panicking at expect_posix.
    #[cfg(target_os = "android")]
    if matches!(
        *state.current_vault.lock().map_err(|_| crate::error::VaultError::LockPoisoned)?,
        Some(crate::storage::VaultHandle::ContentUri(_))
    ) {
        let _ = (editor_content, last_saved_content);
        return Err(crate::error::VaultError::VaultUnavailable { path });
    }

    // T-02-18 mitigation: validate path is inside vault
    let vault_path: PathBuf = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| crate::error::VaultError::LockPoisoned)?;
        guard
            .as_ref()
            .map(|h| h.expect_posix().to_path_buf())
            .ok_or_else(|| crate::error::VaultError::VaultUnavailable {
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
    // #345: refuse merges that target a locked folder. Plaintext must
    // not flow through the three-way merge while the vault says the
    // file is ciphertext.
    let canon = crate::encryption::CanonicalPath::assume_canonical(canonical.clone());
    if state.locked_paths.is_locked(&canon) {
        return Err(crate::error::VaultError::PathLocked {
            path: canonical.display().to_string(),
        });
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

// ─── #353 one-shot legacy cleanup ────────────────────────────────────────────
//
// The semantic-search feature was removed in #353. Two on-disk artefacts
// may linger on upgraded installs:
//   1. `<vault>/.vaultcore/embeddings/` — HNSW dumps + reindex checkpoint.
//   2. `<app_data_dir>/semantic-enabled.json` — persisted toggle file.
// Both are purged best-effort on their respective host operations
// (vault open, app boot). Missing path is the common case; any other I/O
// error is logged but never fails the host call.

/// Purge `<vault>/.vaultcore/embeddings/` if present. Called from
/// `open_vault` on every open so upgraded installs self-heal without user
/// action.
pub(crate) fn purge_legacy_embeddings_dir(vault_root: &Path) {
    let embed_dir = vault_root.join(".vaultcore").join("embeddings");
    match std::fs::remove_dir_all(&embed_dir) {
        Ok(()) => log::info!(
            "#353 cleanup: removed legacy embeddings dir at {}",
            embed_dir.display()
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "#353 cleanup: failed to remove {}: {e}",
            embed_dir.display()
        ),
    }
}

/// Purge `<app_data_dir>/semantic-enabled.json` if present. Called once
/// from the Tauri `setup` closure on app boot.
pub(crate) fn purge_legacy_semantic_toggle_file(app_data_dir: &Path) {
    let toggle = app_data_dir.join("semantic-enabled.json");
    match std::fs::remove_file(&toggle) {
        Ok(()) => log::info!(
            "#353 cleanup: removed legacy toggle file at {}",
            toggle.display()
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "#353 cleanup: failed to remove {}: {e}",
            toggle.display()
        ),
    }
}
