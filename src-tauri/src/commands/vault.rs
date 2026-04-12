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
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::FsExt;
use walkdir::{DirEntry, WalkDir};

#[derive(Serialize, Clone, Debug)]
pub struct VaultInfo {
    pub path: String,
    pub file_count: usize,
    pub file_list: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
struct IndexProgressPayload {
    current: usize,
    total: usize,
    current_file: String,
}

const PROGRESS_THROTTLE: Duration = Duration::from_millis(50);
const PROGRESS_EVENT: &str = "vault://index_progress";

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
                    .map_or(false, |ext| ext.eq_ignore_ascii_case("md"))
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
                    .map_or(false, |ext| ext.eq_ignore_ascii_case("md"))
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
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;

    // Persist as the active vault (files commands read from here).
    {
        let mut guard = state.current_vault.lock().map_err(|_| VaultError::Io(
            std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
        ))?;
        *guard = Some(canonical.clone());
    }

    // Push to recent-vaults.json
    let canonical_str = canonical.to_string_lossy().into_owned();
    push_recent_vault(&app, &canonical_str)?;

    // --- IDX-02 single-pass walk with progress events ---
    // Collect the sorted file list once and derive total from it, avoiding a
    // second walkdir pass (WR-03: prevents count/list mismatch from concurrent
    // file changes between two walks).
    let file_list = collect_file_list(&canonical);
    let total = file_list.len();

    // Emit throttled progress events while iterating the sorted list.
    let mut last_emit = Instant::now() - PROGRESS_THROTTLE;
    for (i, relative) in file_list.iter().enumerate() {
        let current = i + 1;
        let should_emit = current == total || last_emit.elapsed() >= PROGRESS_THROTTLE;
        if should_emit {
            let _ = app.emit(
                PROGRESS_EVENT,
                IndexProgressPayload {
                    current,
                    total,
                    current_file: relative.clone(),
                },
            );
            last_emit = Instant::now();
        }
    }

    // --- Spawn file watcher (Plan 04) ---
    // Drop any previous watcher before starting a new one (vault re-open).
    {
        let mut handle = state.watcher_handle.lock().map_err(|_| VaultError::Io(
            std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
        ))?;
        *handle = None; // drops old debouncer, stops previous watch
    }

    let debouncer = watcher::spawn_watcher(
        app.clone(),
        canonical.clone(),
        state.write_ignore.clone(),
        state.vault_reachable.clone(),
    );
    *state.watcher_handle.lock().map_err(|_| VaultError::Io(
        std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
    ))? = Some(debouncer);

    *state.vault_reachable.lock().map_err(|_| VaultError::Io(
        std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
    ))? = true;

    Ok(VaultInfo {
        path: canonical_str,
        file_count: total,
        file_list,
    })
}

#[tauri::command]
pub async fn get_recent_vaults(app: AppHandle) -> Result<Vec<RecentVault>, VaultError> {
    let file = recent_vaults_path(&app)?;
    read_recent_vaults_at(&file)
}

// --- recent-vaults.json persistence -----------------------------------------

fn recent_vaults_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    let dir = app.path().app_data_dir().map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
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
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
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
#[derive(Serialize, Clone, Debug)]
pub struct MergeCommandResult {
    /// "clean" or "conflict"
    pub outcome: String,
    /// The merged content (for "clean") or the original local content (for "conflict")
    pub merged_content: String,
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
#[tauri::command]
pub async fn merge_external_change(
    state: tauri::State<'_, crate::VaultState>,
    path: String,
    editor_content: String,
    last_saved_content: String,
) -> Result<MergeCommandResult, crate::error::VaultError> {
    use crate::merge::{three_way_merge, MergeOutcome};

    // T-02-18 mitigation: validate path is inside vault
    let vault_path = {
        let guard = state.current_vault.lock().map_err(|_| {
            crate::error::VaultError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "internal state lock poisoned",
            ))
        })?;
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
        MergeOutcome::Clean(merged) => Ok(MergeCommandResult {
            outcome: "clean".to_string(),
            merged_content: merged,
        }),
        MergeOutcome::Conflict(local) => Ok(MergeCommandResult {
            outcome: "conflict".to_string(),
            merged_content: local,
        }),
    }
}
