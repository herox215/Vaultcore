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
    encrypt_file_in_place, verify_sentinel, walk_all_under, write_sentinel,
};
use crate::encryption::crypto::{derive_key, random_salt};
use crate::encryption::manifest::{
    read_manifest, upsert, EncryptedFolderMeta, FolderState,
};
use crate::encryption::CanonicalPath;
use crate::error::VaultError;
use crate::VaultState;

const ENCRYPT_PROGRESS_EVENT: &str = "vault://encrypt_progress";
const ENCRYPTED_FOLDERS_CHANGED_EVENT: &str = "vault://encrypted_folders_changed";
const PROGRESS_THROTTLE_MS: u128 = 50;
const PROGRESS_EMIT_THRESHOLD: usize = 16;

/// #357 — live progress stream for auto-encrypt-on-drop. Distinct from
/// `vault://encrypt_progress` (which drives the batch-encrypt modal's
/// fill bar); this event drives the bottom-center status pill and
/// carries a per-file error slot for actionable toasts.
pub const ENCRYPT_DROP_PROGRESS_EVENT: &str = "vault://encrypt_drop_progress";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncryptDropProgress {
    pub in_flight: usize,
    pub total: usize,
    pub last_completed: Option<String>,
    /// #357 — `true` when a drop landed in a currently-locked folder
    /// and was queued (not sealed). The frontend surfaces a distinct
    /// toast for this case: "File queued — it remains unencrypted on
    /// disk until you unlock the folder." Makes the threat-model gap
    /// explicit to the user.
    pub queued: bool,
    pub error: Option<EncryptDropError>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncryptDropError {
    pub path: String,
    pub message: String,
}

/// Public view of an encrypted folder — salt is stripped before serde
/// so the frontend never handles KDF material. Used by
/// `list_encrypted_folders` and the `vault://encrypted_folders_changed`
/// event payload.
///
/// #351: `locked` reflects the in-memory registry state at list time
/// (NOT persisted in the manifest). The frontend diffs this field
/// across refreshes to detect unlocked → locked transitions and close
/// any open tabs that sit inside a now-locked root.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedFolderView {
    pub path: String,
    pub created_at: String,
    pub state: FolderState,
    pub locked: bool,
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
    match guard.as_ref() {
        Some(crate::storage::VaultHandle::Posix(p)) => Ok(p.clone()),
        // #392 PR-B: encrypted folders are not supported on
        // content://-rooted vaults yet. The manifest is canonical-path-
        // keyed; the SAF layer doesn't have an equivalent. Fail-fast
        // here so every encryption command (encrypt_folder,
        // unlock_folder, lock_folder, lock_all_folders,
        // list_encrypted_folders, export_decrypted_file) surfaces a
        // single discriminated error to the frontend. Tracked: #345
        // storage-trait-aware encryption follow-up.
        #[cfg(target_os = "android")]
        Some(crate::storage::VaultHandle::ContentUri(_)) => {
            Err(VaultError::EncryptionUnsupportedOnAndroid)
        }
        None => Err(VaultError::VaultUnavailable {
            path: String::from("<no vault>"),
        }),
    }
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

    // #357: the manifest just changed — refresh the cache so the
    // watcher hot path sees the new encrypted root on the next event.
    if let Err(e) = state.manifest_cache.refresh_from_disk(&vault_root) {
        log::warn!("manifest cache refresh after encrypt_folder failed: {e:?}");
    }

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

    // #357: ordering below closes two plaintext-leak windows at once.
    //
    // 1. Keyring first, registry unlock last — same invariant as before:
    //    a reader that observes `is_locked == false` must also find a
    //    key in the keyring.
    //
    // 2. Drain the pending-encryption queue BEFORE flipping the
    //    registry. If we unlocked the registry first, an IPC `read_file`
    //    arriving between the unlock and the drain would read plaintext
    //    from a file that the user thinks is encrypted at rest. By
    //    sealing every queued file WHILE the registry still reports
    //    locked, readers are gated until every on-disk straggler has a
    //    VCE1 header. `seal_pending_file` bypasses the `is_locked`
    //    check deliberately because the key is already in the keyring.
    state.keyring.insert(folder_canon.clone(), key)?;

    // Drain while the root is still registry-locked.
    let pending = state.pending_queue.drain_root(&folder_canon)?;
    if !pending.is_empty() {
        let write_ignore = std::sync::Arc::clone(&state.write_ignore);
        let deps = crate::encryption::EncryptDeps {
            vault_root: &vault_root,
            locked_paths: &state.locked_paths,
            keyring: &state.keyring,
            pending_queue: &state.pending_queue,
            write_ignore: &write_ignore,
            manifest_cache: &state.manifest_cache,
        };
        for path in pending {
            match crate::encryption::seal_pending_file(&deps, &folder_canon, &path) {
                Ok(_) => {}
                Err(e) => {
                    log::warn!(
                        "pending encrypt-on-unlock failed for {}: {e:?} — \
                         file stays plaintext until next save",
                        path.display()
                    );
                    // Surface the per-file error so the frontend can
                    // toast it. Unlock itself still succeeds — we
                    // refuse to punish a correct password because one
                    // queued file has bad permissions.
                    let _ = app.emit(
                        ENCRYPT_DROP_PROGRESS_EVENT,
                        EncryptDropProgress {
                            in_flight: 0,
                            total: 0,
                            last_completed: None,
                            queued: false,
                            error: Some(EncryptDropError {
                                path: path.display().to_string(),
                                message: e.to_string(),
                            }),
                        },
                    );
                }
            }
        }
    }

    // Now flip the registry.
    state.locked_paths.unlock_root(&folder_canon)?;

    // Manifest cache refresh intentionally skipped — `unlock_folder`
    // does not mutate the manifest JSON on disk (unlocked state is
    // runtime-only and never persisted). Same reasoning as
    // `lock_folder` / `lock_all_folders`.

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
    let (folder_canon, _vault_root) = resolve_folder(&state, &path)?;
    // Register as locked BEFORE dropping the key so any in-flight
    // read-path race is resolved by the fail-closed gate — the reader
    // sees "locked" and returns PathLocked rather than using a stale
    // key snapshot.
    state.locked_paths.lock_root(folder_canon.clone())?;
    state.keyring.remove(&folder_canon)?;
    // Manifest cache is NOT refreshed here: `lock_folder` only mutates
    // in-memory registry + keyring state, never the manifest JSON on
    // disk. The cached list of encrypted roots is unchanged; locked vs
    // unlocked is answered by `LockedPathRegistry`, not by the cache.
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
    // Cache refresh intentionally skipped — see `lock_folder` for the
    // reasoning. `lock_all_folders` never mutates the manifest.
    let _ = app.emit(ENCRYPTED_FOLDERS_CHANGED_EVENT, ());
    Ok(())
}

// ── export_decrypted_file (#360) ─────────────────────────────────────────────

/// Test-accessible body for `export_decrypted_file`. Splits the Tauri
/// `State` extraction from the logic so unit tests can hit the same
/// contract without spinning up a runtime.
///
/// Contract:
/// - `source` must sit inside the current vault AND inside an encrypted
///   folder AND that folder must currently be UNLOCKED. Else: the
///   corresponding `VaultError` without ever reading bytes.
/// - `dest`'s parent must exist and canonicalize, and the prospective
///   final path must NOT sit inside any encrypted root (exporting into
///   another encrypted root would write unframed plaintext adjacent to
///   ciphertext, silently breaking that folder's contract).
/// - `dest` MAY live outside the vault — that is the whole point.
///
/// No atomic-write helper here. `write_atomic` places its `.vce-tmp-*`
/// file next to the *destination*, which for this command is usually
/// outside the vault (e.g. `~/Desktop/`). That tempfile would leak
/// plaintext bytes outside the vault for the duration of the rename,
/// violating the "plaintext never leaves unless explicit export"
/// contract. The export is user-initiated and one-shot: a crash in the
/// middle is a retry, not a corruption scenario for any vault state.
/// Plain `fs::write` is correct here.
///
/// Size cap intentionally not re-checked: every sealed file under an
/// encrypted root was already bounded by `MAX_INLINE_ENCRYPT_BYTES` at
/// encrypt time. A ciphertext exceeding that cap + HEADER/TAG overhead
/// means the file was tampered with — `decrypt_bytes` will fail the
/// Poly1305 tag and surface `WrongPassword` / `CryptoError`, which is
/// the correct defense.
pub fn export_decrypted_file_impl(
    state: &VaultState,
    source: String,
    dest: String,
) -> Result<(), VaultError> {
    // 1. Snapshot `vault_root` ONCE under a single `current_vault`
    //    lock acquisition. Every subsequent check — scope, enclosing
    //    root, dest-in-encrypted, rel-path-for-logging — uses THIS
    //    snapshot, so a concurrent `open_vault` that swaps the vault
    //    mid-export produces a single coherent error (the source no
    //    longer appears under the snapshotted vault, and the locked
    //    path / encrypted-root checks all operate on consistent
    //    state). Splitting the snapshot across `ensure_inside_vault`
    //    + a second `current_vault.lock()` would reintroduce the
    //    TOCTOU window Aristotle flagged on iter-1.
    let vault_root = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        match guard.as_ref() {
            Some(crate::storage::VaultHandle::Posix(p)) => p.clone(),
            // #392 PR-B: see vault_root helper for rationale.
            #[cfg(target_os = "android")]
            Some(crate::storage::VaultHandle::ContentUri(_)) => {
                return Err(VaultError::EncryptionUnsupportedOnAndroid);
            }
            None => {
                return Err(VaultError::VaultUnavailable {
                    path: source.clone(),
                });
            }
        }
    };

    // 2. Canonicalize source + enforce vault scope against the single
    //    snapshot above. Inline rather than `ensure_inside_vault`
    //    because that helper re-locks `current_vault` internally —
    //    doing so here would be the race this function is designed
    //    to avoid. The `ensure_unlocked` check is inlined for the
    //    same reason; it needs the canonical source path but not the
    //    vault lock.
    let source_path = PathBuf::from(&source);
    let source_canonical = std::fs::canonicalize(&source_path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: source.clone() },
        std::io::ErrorKind::PermissionDenied => {
            VaultError::PermissionDenied { path: source.clone() }
        }
        _ => VaultError::Io(e),
    })?;
    if !source_canonical.starts_with(&vault_root) {
        return Err(VaultError::PermissionDenied {
            path: source_canonical.display().to_string(),
        });
    }
    {
        let canon =
            crate::encryption::CanonicalPath::assume_canonical(source_canonical.clone());
        if state.locked_paths.is_locked(&canon) {
            return Err(VaultError::PathLocked {
                path: source_canonical.display().to_string(),
            });
        }
    }

    // 3. Source must be inside an encrypted root. This is distinct
    //    from "inside any vault folder" — a plain vault file has
    //    nothing to decrypt, so exporting it would be a misleading
    //    copy. We surface that as `PermissionDenied` with a clear
    //    message; the frontend only exposes the menu entry for files
    //    under an unlocked encrypted root, so in normal use the error
    //    is a locked/locked race we already handle below.
    let src_enc_root = crate::encryption::find_enclosing_encrypted_root_cached(
        &state.manifest_cache,
        &vault_root,
        &source_canonical,
    )?
    .ok_or_else(|| VaultError::PermissionDenied {
        path: format!(
            "{} is not inside an encrypted folder; nothing to decrypt",
            source_canonical.display()
        ),
    })?;

    // 4. Root must be unlocked. `ensure_inside_vault` already returns
    //    `PathLocked` for locked roots; we still check the keyring
    //    explicitly because `ensure_unlocked` is fail-closed on
    //    poisoned state and this path requires a key to actually
    //    decrypt. A race between menu-open and click where the folder
    //    is locked mid-flight also surfaces here.
    if state.keyring.key_clone(&src_enc_root)?.is_none() {
        return Err(VaultError::PathLocked {
            path: source_canonical.display().to_string(),
        });
    }

    // 5. Source bytes must actually be sealed. `maybe_decrypt_read`
    //    tolerates unframed bytes (see its doc — it passes through
    //    plaintext stragglers so a half-finished encrypt batch can
    //    still be recovered), but THIS command's contract is "export
    //    a DECRYPTED copy". Silently passing through plaintext as if
    //    it had been decrypted would let a user export a
    //    partially-encrypted vault's stragglers under the
    //    "decrypted" label and never notice the encrypt batch is
    //    stuck. Reject explicitly so the error is observable.
    let ciphertext = std::fs::read(&source_canonical).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: source.clone() },
        std::io::ErrorKind::PermissionDenied => {
            VaultError::PermissionDenied { path: source.clone() }
        }
        _ => VaultError::Io(e),
    })?;
    if !ciphertext.starts_with(crate::encryption::file_format::MAGIC) {
        return Err(VaultError::CryptoError {
            msg: format!(
                "{} is inside an encrypted folder but is not sealed (missing VCE1 header) — \
                 it may be a partially-completed encrypt batch; try re-running encrypt",
                source_canonical.display()
            ),
        });
    }

    // 6. Resolve the destination. The file itself does not exist yet,
    //    so canonicalize the PARENT and rebuild the final path.
    let dest_path = PathBuf::from(&dest);
    let dest_parent = dest_path
        .parent()
        .ok_or_else(|| VaultError::PermissionDenied { path: dest.clone() })?;
    let dest_file_name = dest_path
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: dest.clone() })?
        .to_owned();
    let dest_parent_canonical = std::fs::canonicalize(dest_parent).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: dest_parent.display().to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: dest_parent.display().to_string(),
        },
        _ => VaultError::Io(e),
    })?;
    let dest_final = dest_parent_canonical.join(&dest_file_name);

    // 7. Dest MUST NOT land inside any encrypted root. An export target
    //    inside another encrypted folder would drop unframed plaintext
    //    next to sealed files, silently breaking that folder's contract.
    //    We check the canonical parent — because `..` traversals in the
    //    caller-supplied `dest_path` are collapsed by `canonicalize`,
    //    the parent reflects the real on-disk location a child would
    //    end up at.
    if crate::encryption::find_enclosing_encrypted_root_cached(
        &state.manifest_cache,
        &vault_root,
        &dest_parent_canonical,
    )?
    .is_some()
    {
        return Err(VaultError::PermissionDenied {
            path: format!(
                "destination {} is inside an encrypted folder; pick a plain folder instead",
                dest_final.display()
            ),
        });
    }

    // 8. Decrypt. `maybe_decrypt_read` returns plaintext for the bytes
    //    we already verified start with VCE1 magic (Step 5).
    let plaintext =
        crate::encryption::maybe_decrypt_read(state, &source_canonical, ciphertext)?;

    // 9. Write plaintext to dest. Non-atomic by design — `write_atomic`
    //    would place a `.vce-tmp-*` file next to the destination (often
    //    outside the vault), leaking plaintext outside the vault
    //    boundary for the duration of the rename. Export is user-
    //    initiated and retry-safe, so plain `fs::write` is correct.
    std::fs::write(&dest_final, &plaintext).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            VaultError::PermissionDenied { path: dest_final.display().to_string() }
        }
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;

    // 10. Audit log: the export is the highest-risk encryption op the
    //     user can perform. Log the source rel-path; omit the full dest
    //     (the user's filesystem layout is not ours to mirror into logs).
    let rel = source_canonical
        .strip_prefix(&vault_root)
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "<unresolved>".into());
    log::info!(
        "export_decrypted_file: {} -> {} ({} bytes plaintext)",
        rel,
        dest_parent_canonical.display(),
        plaintext.len(),
    );

    Ok(())
}

#[tauri::command]
pub async fn export_decrypted_file(
    state: tauri::State<'_, VaultState>,
    source: String,
    dest: String,
) -> Result<(), VaultError> {
    export_decrypted_file_impl(&state, source, dest)
}

// ── list_encrypted_folders ───────────────────────────────────────────────────

#[tauri::command]
pub async fn list_encrypted_folders(
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<EncryptedFolderView>, VaultError> {
    let root = vault_root(&state)?;
    let metas = read_manifest(&root)?;
    Ok(metas
        .iter()
        .map(|m| {
            // #351: derive `locked` from the in-memory registry. A
            // manifest entry whose folder cannot be canonicalized
            // (renamed outside the app, orphaned entry, transient FS
            // failure on a networked / unmounted share) reports as
            // locked — the conservative default matches
            // `reload_manifest_and_lock_all`, which also skips-as-locked
            // rather than opening a plaintext read window. Log so the
            // failure is observable when it happens; the fallback keeps
            // the UI behavior safe but masks the root cause otherwise.
            // Blocking `canonicalize` is acceptable here because the
            // manifest holds < 10 entries in practice and the other
            // encryption entry points (`lock_folder`,
            // `reload_manifest_and_lock_all`) already canonicalize in
            // this same pattern.
            let abs = root.join(&m.path);
            let locked = match std::fs::canonicalize(&abs) {
                Ok(canon) => state
                    .locked_paths
                    .is_locked(&CanonicalPath::assume_canonical(canon)),
                Err(e) => {
                    log::warn!(
                        "list_encrypted_folders: canonicalize {} failed: {e} — reporting locked",
                        abs.display()
                    );
                    true
                }
            };
            EncryptedFolderView {
                path: m.path.clone(),
                created_at: m.created_at.clone(),
                state: m.state,
                locked,
            }
        })
        .collect())
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
    // #357: also clear the pending-encryption queue and refresh the
    // manifest cache. Vault switch: queued paths for vault A must never
    // be drained into vault B's keyring.
    state.pending_queue.clear()?;
    state.manifest_cache.clear()?;
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
    // #357: warm the manifest cache from the (now-current) on-disk
    // state. Every watcher hot-path lookup reads from this cache.
    if let Err(e) = state.manifest_cache.refresh_from_disk(vault_root) {
        log::warn!("manifest cache refresh failed after open_vault: {e:?}");
    }
    Ok(())
}

// Expose types + constants for open_vault & tests without widening
// the crypto surface in encryption::.
pub use crate::encryption::manifest::FolderState as ManifestFolderState;
