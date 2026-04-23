// IPC commands for #345 — password-protected encrypted folders.
//
// Five commands exposed to the frontend:
// - encrypt_folder(path, password)  → derive key, write manifest +
//   sentinel, seal every file under root, register as locked.
// - unlock_folder(path, password)   → verify via sentinel, stash key
//   in keyring, remove from locked registry, re-enable reads.
// - lock_folder(path)               → drop key, re-register as locked.
// - lock_all_folders()              → drop all keys, mark every
//   encrypted root locked.
// - list_encrypted_folders()        → strip-salt view of manifest.
//
// Progress: `encrypt_folder` emits `vault://encrypt_progress` events
// at 50 ms throttle so the frontend modal can render a fill bar for
// multi-hundred-file batches.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::encryption::batch::{
    decrypt_file_to_plaintext, encrypt_file_in_place, verify_sentinel, walk_all_under,
    write_sentinel,
};
use crate::encryption::crypto::{derive_key, random_salt, KEY_LEN};
use crate::encryption::manifest::{
    read_manifest, upsert, write_manifest, EncryptedFolderMeta, FolderState,
};
use crate::encryption::{CanonicalPath, SENTINEL_FILENAME};
use crate::error::VaultError;
use crate::VaultState;

const ENCRYPT_PROGRESS_EVENT: &str = "vault://encrypt_progress";
const ENCRYPTED_FOLDERS_CHANGED_EVENT: &str = "vault://encrypted_folders_changed";
const PROGRESS_THROTTLE_MS: u128 = 50;
const PROGRESS_EMIT_THRESHOLD: usize = 16;

/// Public view of an encrypted folder — salt is stripped before serde
/// so the frontend never handles KDF material. Used by
/// `list_encrypted_folders` and the `vault://encrypted_folders_changed`
/// event payload.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedFolderView {
    pub path: String,
    pub created_at: String,
    pub state: FolderState,
}

impl From<&EncryptedFolderMeta> for EncryptedFolderView {
    fn from(m: &EncryptedFolderMeta) -> Self {
        Self {
            path: m.path.clone(),
            created_at: m.created_at.clone(),
            state: m.state,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncryptProgress {
    pub current: usize,
    pub total: usize,
    pub file: String,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn vault_root(state: &VaultState) -> Result<PathBuf, VaultError> {
    let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
    guard.as_ref().cloned().ok_or_else(|| VaultError::VaultUnavailable {
        path: String::from("<no vault>"),
    })
}

/// Canonical absolute path of the folder the user referenced, with
/// vault-containment + not-a-file checks. Returns the canonical path
/// AND the vault root so callers can compute a vault-relative key.
fn resolve_folder(
    state: &VaultState,
    path_arg: &str,
) -> Result<(PathBuf, PathBuf), VaultError> {
    let root = vault_root(state)?;
    let abs = PathBuf::from(path_arg);
    let canon = std::fs::canonicalize(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: path_arg.to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: path_arg.to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    if !canon.starts_with(&root) {
        return Err(VaultError::PermissionDenied {
            path: canon.display().to_string(),
        });
    }
    if !canon.is_dir() {
        return Err(VaultError::PermissionDenied {
            path: canon.display().to_string(),
        });
    }
    Ok((canon, root))
}

fn now_iso_utc() -> String {
    // Minimal dependency-free ISO-8601 stamp via SystemTime.
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    // Compute Y-M-D HH:MM:SS UTC without chrono.
    let (y, mo, da, h, mi, s) = secs_to_ymdhms(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, da, h, mi, s)
}

fn secs_to_ymdhms(secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    // Days since 1970-01-01 (epoch).
    let days = (secs / 86_400) as i64;
    let seconds_of_day = (secs % 86_400) as u32;
    let h = seconds_of_day / 3600;
    let mi = (seconds_of_day % 3600) / 60;
    let s = seconds_of_day % 60;
    // Howard Hinnant's civil_from_days algorithm.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let final_y = if m <= 2 { y + 1 } else { y };
    (final_y as u32, m as u32, d as u32, h, mi, s)
}

fn emit_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    total: usize,
    current: usize,
    file: &str,
    last: &mut Instant,
) {
    if total < PROGRESS_EMIT_THRESHOLD {
        return;
    }
    if last.elapsed().as_millis() < PROGRESS_THROTTLE_MS && current != total {
        return;
    }
    let _ = app.emit(
        ENCRYPT_PROGRESS_EVENT,
        EncryptProgress {
            current,
            total,
            file: file.to_string(),
        },
    );
    *last = Instant::now();
}

// ── encrypt_folder ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn encrypt_folder(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    path: String,
    password: String,
) -> Result<(), VaultError> {
    let (folder_canon, vault_root) = resolve_folder(&state, &path)?;
    let rel = folder_canon
        .strip_prefix(&vault_root)
        .map_err(|_| VaultError::PermissionDenied {
            path: folder_canon.display().to_string(),
        })?
        .to_string_lossy()
        .replace('\\', "/");

    // Refuse nested encrypt — a folder that already sits inside another
    // encrypted root is implicitly covered by that root's key.
    let canon = CanonicalPath::assume_canonical(folder_canon.clone());
    if state.locked_paths.is_locked(&canon) {
        return Err(VaultError::PathLocked {
            path: folder_canon.display().to_string(),
        });
    }
    let existing_metas = read_manifest(&vault_root)?;
    if existing_metas.iter().any(|m| m.path == rel) {
        // Already encrypted. Idempotent: surface a clean error so the
        // frontend can prompt for unlock instead.
        return Err(VaultError::PathLocked {
            path: folder_canon.display().to_string(),
        });
    }

    // Derive the key once — this is the ~300-600ms Argon2 step.
    let salt = random_salt();
    let key = derive_key(password.as_bytes(), &salt)?;

    // Persist the manifest with state=encrypting BEFORE any file is
    // sealed. If the process dies mid-batch, the manifest flags the
    // folder as "encrypting" and a future resume flow (PR 345.3) can
    // pick up from there.
    let meta_encrypting = EncryptedFolderMeta {
        path: rel.clone(),
        created_at: now_iso_utc(),
        salt: EncryptedFolderMeta::encode_salt(&salt),
        state: FolderState::Encrypting,
    };
    upsert(&vault_root, meta_encrypting.clone())?;

    // #345 race fix: lock the root BEFORE touching any file so a
    // concurrent `write_file` through the IPC layer cannot overwrite
    // ciphertext with plaintext during the batch. The batch itself
    // bypasses the `ensure_unlocked` gate because it calls
    // `encrypt_file_in_place` (which uses `fs::read` + `write_atomic`
    // directly, NOT `commands/files.rs::write_file`). External IPC
    // writes are blocked by the gate; the batch proceeds on disk.
    state.locked_paths.lock_root(folder_canon.clone())?;

    // Write the sentinel so unlock has something to probe.
    write_sentinel(&folder_canon, &key)?;

    // Seal every regular file. Attachments are included — see the
    // walk_all_under rationale.
    let files: Vec<PathBuf> = walk_all_under(&folder_canon).collect();
    let total = files.len();
    let mut last_emit = Instant::now() - std::time::Duration::from_millis(PROGRESS_THROTTLE_MS as u64);
    for (i, file) in files.iter().enumerate() {
        let current = i + 1;
        encrypt_file_in_place(&key, file).map_err(|e| {
            log::error!(
                "encrypt_folder: sealing file {} failed: {:?}",
                file.display(),
                e
            );
            e
        })?;
        // D-12 self-filter: watcher should ignore the synthetic write.
        if let Ok(mut guard) = state.write_ignore.lock() {
            guard.record(file.clone());
        }
        emit_progress(
            &app,
            total,
            current,
            &file.display().to_string(),
            &mut last_emit,
        );
    }

    // Flip manifest to encrypted.
    let meta_final = EncryptedFolderMeta {
        state: FolderState::Encrypted,
        ..meta_encrypting
    };
    upsert(&vault_root, meta_final)?;

    // Evict any in-memory key for this root (there should be none).
    let _ = state.keyring.remove(&folder_canon);

    let _ = app.emit(ENCRYPTED_FOLDERS_CHANGED_EVENT, ());
    Ok(())
}

// ── unlock_folder ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn unlock_folder(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    path: String,
    password: String,
) -> Result<(), VaultError> {
    let (folder_canon, vault_root) = resolve_folder(&state, &path)?;
    let rel = folder_canon
        .strip_prefix(&vault_root)
        .map_err(|_| VaultError::PermissionDenied {
            path: folder_canon.display().to_string(),
        })?
        .to_string_lossy()
        .replace('\\', "/");

    let metas = read_manifest(&vault_root)?;
    let meta = metas.iter().find(|m| m.path == rel).ok_or_else(|| {
        VaultError::CryptoError {
            msg: format!("folder {} is not registered as encrypted", rel),
        }
    })?;

    let salt = meta.salt_bytes()?;
    let key = derive_key(password.as_bytes(), &salt)?;
    // Sentinel verification. A wrong password surfaces as
    // `VaultError::WrongPassword` here (remapped inside verify_sentinel).
    verify_sentinel(&folder_canon, &key)?;

    // Stash the key FIRST, then release the registry lock. Order
    // matters: a reader that races between the two operations must
    // never see "unlocked=true, no key in keyring" — that window would
    // produce spurious decrypt failures on the happy path. With this
    // ordering every reader that observes `is_locked=false` is
    // guaranteed to find a key in the keyring too.
    state.keyring.insert(folder_canon.clone(), key)?;
    state.locked_paths.unlock_root(&folder_canon)?;

    let _ = app.emit(ENCRYPTED_FOLDERS_CHANGED_EVENT, ());
    Ok(())
}

// ── lock_folder ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lock_folder(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<(), VaultError> {
    let (folder_canon, _) = resolve_folder(&state, &path)?;
    // Register as locked BEFORE dropping the key so any in-flight
    // read-path race is resolved by the fail-closed gate — the reader
    // sees "locked" and returns PathLocked rather than using a stale
    // key snapshot.
    state.locked_paths.lock_root(folder_canon.clone())?;
    state.keyring.remove(&folder_canon)?;
    let _ = app.emit(ENCRYPTED_FOLDERS_CHANGED_EVENT, ());
    Ok(())
}

// ── lock_all_folders ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lock_all_folders(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
) -> Result<(), VaultError> {
    let root = vault_root(&state)?;
    let metas = read_manifest(&root)?;
    for m in &metas {
        let abs = root.join(&m.path);
        if let Ok(canon) = std::fs::canonicalize(&abs) {
            state.locked_paths.lock_root(canon.clone())?;
            state.keyring.remove(&canon)?;
        }
    }
    // Defensive wipe in case the keyring still carried entries not
    // backed by the manifest (shouldn't happen, but costs nothing).
    state.keyring.clear()?;
    let _ = app.emit(ENCRYPTED_FOLDERS_CHANGED_EVENT, ());
    Ok(())
}

// ── list_encrypted_folders ───────────────────────────────────────────────────

#[tauri::command]
pub async fn list_encrypted_folders(
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<EncryptedFolderView>, VaultError> {
    let root = vault_root(&state)?;
    let metas = read_manifest(&root)?;
    Ok(metas.iter().map(EncryptedFolderView::from).collect())
}

// ── integration hook used by open_vault ──────────────────────────────────────

/// Populate `state.locked_paths` from the vault's manifest. Called by
/// `open_vault` after canonicalization, before the indexer walks the
/// vault — guarantees encrypted subtrees are skipped on cold start.
///
/// Always locks every encrypted root (no persistence of unlocked state
/// across restart).
pub fn reload_manifest_and_lock_all(state: &VaultState, vault_root: &Path) -> Result<(), VaultError> {
    // Clear both registries — vault switch: the previous vault's state
    // must not bleed through.
    state.locked_paths.clear()?;
    state.keyring.clear()?;
    let metas = read_manifest(vault_root)?;
    for m in &metas {
        let abs = vault_root.join(&m.path);
        // Best effort: if canonicalize fails (folder renamed outside
        // the app since last shutdown), the path stays unlocked and
        // the manifest entry is orphaned. Log so operators can see.
        match std::fs::canonicalize(&abs) {
            Ok(canon) => state.locked_paths.lock_root(canon)?,
            Err(e) => log::warn!(
                "encrypted folder {} missing at open_vault: {e} — manifest entry orphaned",
                abs.display()
            ),
        }
    }
    Ok(())
}

// Expose types + constants for open_vault & tests without widening
// the crypto surface in encryption::.
pub use crate::encryption::manifest::{FolderState as ManifestFolderState};

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn _force_use_of_sentinel() -> &'static str {
    SENTINEL_FILENAME
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn _force_use_of_decrypt_helper() -> fn(&[u8; KEY_LEN], &Path) -> Result<Vec<u8>, VaultError> {
    decrypt_file_to_plaintext
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn _force_use_of_write_manifest(
) -> fn(&Path, &[EncryptedFolderMeta]) -> Result<(), VaultError> {
    write_manifest
}
