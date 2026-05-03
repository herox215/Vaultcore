//! Conflict resolution for concurrent writes (epic #73 sub-issue #420).
//!
//! Two paths:
//!   - **3-way merge** when the GCA (greatest common ancestor) is in
//!     `sync_history`. Calls `crate::merge::three_way_merge` directly —
//!     the editor's `merge_external_change` Tauri command is left
//!     untouched (different semantics: editor-side disk-conflict vs.
//!     network-arrival).
//!   - **Conflict copy** when the GCA isn't in history (long divergence
//!     beyond the last-2-versions LRU window). Writes a copy with the
//!     Obsidian-compatible filename
//!     `note (conflict from <peer-name> YYYY-MM-DD HH:MM).md` and keeps
//!     the local file untouched.

use std::path::{Path, PathBuf};

use crate::error::VaultError;
use crate::merge::{three_way_merge, MergeOutcome};

use super::state::{FileRecord, SyncState};
use super::{ContentHash, VersionVector};

/// What the resolver decided. The caller (engine) acts on the result —
/// writing the merged content, registering write-ignore, etc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveOutcome {
    /// Clean 3-way merge produced a single canonical content. Caller
    /// writes it to the working file and persists the merged VV.
    Merged {
        merged_content: String,
        merged_vv: VersionVector,
    },
    /// 3-way merge found overlapping edits → keep local + write a
    /// conflict copy of the remote.
    OverlapKeptLocal {
        copy_path: PathBuf,
        copy_content: Vec<u8>,
    },
    /// History didn't contain the GCA → fall back to conflict copy.
    /// Same disk action as `OverlapKeptLocal` but distinct so the UI
    /// can render different copy ("we couldn't auto-merge" vs.
    /// "your changes overlapped").
    NoBaseInHistory {
        copy_path: PathBuf,
        copy_content: Vec<u8>,
    },
}

/// Resolve a concurrent write. Caller has already determined the VVs
/// are concurrent (via `SyncState::apply_remote_write` returning
/// `ApplyOutcome::Conflict`). `local` is the on-disk content; `remote`
/// the inbound bytes. `peer_name` is the human-readable name used in
/// the conflict-copy filename.
#[allow(clippy::too_many_arguments)]
pub fn resolve(
    state: &SyncState,
    vault_id: &str,
    rel_path: &Path,
    local_record: &FileRecord,
    local_content: &[u8],
    remote_content: &[u8],
    remote_vv: &VersionVector,
    peer_name: &str,
) -> Result<ResolveOutcome, VaultError> {
    // GCA = per-peer min of the two VVs. Look up its content hash via
    // the history retained for this `(vault_id, path)`.
    let gca = local_record.version_vector.gca(remote_vv);
    let path_str = rel_path.to_string_lossy().to_string();
    let base_bytes = match find_base_in_history(state, vault_id, &path_str, &gca)? {
        Some(b) => b,
        None => {
            return Ok(ResolveOutcome::NoBaseInHistory {
                copy_path: conflict_copy_path(rel_path, peer_name, state),
                copy_content: remote_content.to_vec(),
            });
        }
    };

    // 3-way merge over UTF-8. Bail to conflict-copy if any side isn't
    // valid UTF-8 (binary attachment) — the editor merge function only
    // makes sense on text.
    let local_str = match std::str::from_utf8(local_content) {
        Ok(s) => s,
        Err(_) => {
            return Ok(ResolveOutcome::NoBaseInHistory {
                copy_path: conflict_copy_path(rel_path, peer_name, state),
                copy_content: remote_content.to_vec(),
            });
        }
    };
    let remote_str = match std::str::from_utf8(remote_content) {
        Ok(s) => s,
        Err(_) => {
            return Ok(ResolveOutcome::NoBaseInHistory {
                copy_path: conflict_copy_path(rel_path, peer_name, state),
                copy_content: remote_content.to_vec(),
            });
        }
    };
    let base_str = match std::str::from_utf8(&base_bytes) {
        Ok(s) => s,
        Err(_) => {
            return Ok(ResolveOutcome::NoBaseInHistory {
                copy_path: conflict_copy_path(rel_path, peer_name, state),
                copy_content: remote_content.to_vec(),
            });
        }
    };

    match three_way_merge(base_str, local_str, remote_str) {
        MergeOutcome::Clean(merged) => {
            // Merged VV is the per-peer max of the two parents — we
            // observe both prior writes after this resolution.
            let merged_vv = vv_max(&local_record.version_vector, remote_vv);
            Ok(ResolveOutcome::Merged {
                merged_content: merged,
                merged_vv,
            })
        }
        MergeOutcome::Conflict(_kept_local) => Ok(ResolveOutcome::OverlapKeptLocal {
            copy_path: conflict_copy_path(rel_path, peer_name, state),
            copy_content: remote_content.to_vec(),
        }),
    }
}

/// Look up the base content for the GCA. The GCA's exact content hash
/// isn't directly stored in `sync_files` (which only holds the latest);
/// we walk history rows for `(vault_id, path)` and pick the one whose
/// VV equals the GCA. If none matches, return None.
fn find_base_in_history(
    state: &SyncState,
    vault_id: &str,
    path: &str,
    gca: &VersionVector,
) -> Result<Option<Vec<u8>>, VaultError> {
    let conn = state.lock_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT content_hash, version_vector FROM sync_history
             WHERE vault_id = ?1 AND path = ?2",
        )
        .map_err(|e| VaultError::SyncState {
            msg: format!("sqlite: {e}"),
        })?;
    let mut rows = stmt
        .query(rusqlite::params![vault_id, path])
        .map_err(|e| VaultError::SyncState {
            msg: format!("sqlite: {e}"),
        })?;
    while let Some(row) = rows.next().map_err(|e| VaultError::SyncState {
        msg: format!("sqlite: {e}"),
    })? {
        let hash_bytes: Vec<u8> = row.get(0).map_err(|e| VaultError::SyncState {
            msg: format!("sqlite: {e}"),
        })?;
        let vv_bytes: Vec<u8> = row.get(1).map_err(|e| VaultError::SyncState {
            msg: format!("sqlite: {e}"),
        })?;
        let vv = VersionVector::from_bytes(&vv_bytes)?;
        if &vv == gca {
            if hash_bytes.len() != 32 {
                continue;
            }
            let mut h: ContentHash = [0; 32];
            h.copy_from_slice(&hash_bytes);
            drop(rows);
            drop(stmt);
            drop(conn);
            return state.get_history(vault_id, path, &h);
        }
    }
    Ok(None)
}

fn vv_max(a: &VersionVector, b: &VersionVector) -> VersionVector {
    let mut out = a.0.clone();
    for (peer, &c) in &b.0 {
        let entry = out.entry(peer.clone()).or_insert(0);
        if c > *entry {
            *entry = c;
        }
    }
    VersionVector(out)
}

/// Obsidian-compatible conflict-copy path:
///   `<stem> (conflict from <peer-name> YYYY-MM-DD HH:MM)<.ext>`
///
/// `state.clock()` supplies the timestamp so tests can pin the format
/// without relying on real wall time. UTC is used to keep the filename
/// stable across timezones.
pub fn conflict_copy_path(rel: &Path, peer_name: &str, state: &SyncState) -> PathBuf {
    let now_secs = state.clock().now_secs();
    let stamp = format_timestamp_utc(now_secs);
    let parent = rel.parent().map(|p| p.to_path_buf());
    let stem = rel.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = rel.extension().map(|e| e.to_string_lossy().to_string());
    let new_name = match ext {
        Some(e) => format!("{stem} (conflict from {peer_name} {stamp}).{e}"),
        None => format!("{stem} (conflict from {peer_name} {stamp})"),
    };
    match parent {
        Some(p) if !p.as_os_str().is_empty() => p.join(new_name),
        _ => PathBuf::from(new_name),
    }
}

/// Format `secs_since_epoch` as `YYYY-MM-DD HH:MM` UTC. Manual
/// implementation so we avoid pulling `chrono` or `time` for one call
/// site; algorithm is the standard civil-date breakdown.
fn format_timestamp_utc(secs: i64) -> String {
    let days_from_epoch = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let (y, m, d) = civil_from_days(days_from_epoch);
    format!("{y:04}-{m:02}-{d:02} {hour:02}:{minute:02}")
}

/// Convert days-since-1970-01-01 to (year, month, day) UTC. Algorithm
/// from Howard Hinnant's "civil_from_days" reference implementation
/// (public domain). The shift by 719_468 anchors day 0 to 0000-03-01,
/// which collapses the leap-year math into a clean 400-year era cycle.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32; // [0, 146_096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}
