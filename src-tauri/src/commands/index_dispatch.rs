// Central dispatch for in-memory index updates from self-write paths.
//
// Lives in commands/ (not indexer::) because it knows about VaultState and
// vault-relative path normalisation — command-layer concerns the indexer
// should not depend on backwards (Socrates review of #339).
//
// The watcher's natural dispatch for write / rename / delete events on files
// we touch ourselves is suppressed by `write_ignore` (D-12). Without these
// helpers the in-memory LinkGraph, TagIndex, and Tantivy index would
// silently trail the on-disk state until cold restart. Every self-mutating
// command (write_file, merge_external_change on clean, delete_file,
// rename_file, move_file, update_links_after_rename) routes through here.
//
// Contract:
// - When the IndexCoordinator isn't attached (vault not open / boot race),
//   we silently no-op and let the next cold-start rebuild repopulate.
// - When the coordinator IS attached, each `tx.send().await` applies async
//   backpressure and blocks until the writer task accepts the command.
//   The IPC thread is the right place to block (unlike the notify callback,
//   which can't); the 8192-slot channel (#139) keeps bursts bounded.
// - Send errors (writer task gone) are ignored — same observable effect as
//   the no-coordinator case. The caller's disk write has already succeeded;
//   the index trails until the next rebuild.
// - Disk-level failures stay with the caller — we only dispatch after the
//   caller has already succeeded on disk.

use std::path::Path;

use tokio::sync::mpsc::Sender;

use crate::indexer::{parser, tantivy_index, IndexCmd};
use crate::VaultState;

/// Enqueue a Tantivy `AddFile` command for `abs_path` using `content` as
/// the source. Sole authority for the Tantivy document shape — every
/// self-write path (dispatch_self_write, update_links_after_rename
/// cascade, any future caller) must route through here so title / body /
/// hash extraction stays consistent.
///
/// Fire-and-forget: drops the send error on a closed channel (writer
/// gone). Does NOT enqueue the Commit — callers batch multiple AddFiles
/// followed by a single Commit.
pub(crate) async fn dispatch_tantivy_upsert(tx: &Sender<IndexCmd>, abs_path: &Path, content: &str) {
    let stem = abs_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let title = tantivy_index::extract_title(content, &stem);
    let body = parser::strip_markdown(content);
    let hash = crate::hash::hash_bytes(content.as_bytes());
    let _ = tx
        .send(IndexCmd::AddFile {
            path: abs_path.to_path_buf(),
            title,
            body,
            hash,
        })
        .await;
}

/// Dispatch all index updates for a file we just wrote ourselves.
///
/// Sends, in order:
/// - `UpdateLinks { rel_path, content }` → refreshes LinkGraph + aliases in FileMeta
/// - `UpdateTags { rel_path, content }`  → refreshes TagIndex
/// - `AddFile { path, title, body, hash }` → updates Tantivy fulltext
/// - `Commit`                             → flushes the writer so searches see the update
///
/// Callers: `write_file`, `merge_external_change` (clean branch),
/// `update_links_after_rename` (per rewritten source), and the "new path"
/// side of `rename_file` / `move_file`.
///
/// Fire-and-forget — no error propagation. A dropped send at this layer
/// means the next cold start or `rebuild_index` will observe the true
/// on-disk state, which is the same fallback the watcher path relies on.
pub(crate) async fn dispatch_self_write(state: &VaultState, abs_path: &Path, content: &str) {
    let vault_root = {
        let Ok(guard) = state.current_vault.lock() else {
            return;
        };
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => return,
        }
    };

    let Ok(rel) = abs_path.strip_prefix(&vault_root) else {
        return;
    };
    let rel_path = rel.to_string_lossy().replace('\\', "/");

    let tx = {
        let Ok(guard) = state.index_coordinator.lock() else {
            return;
        };
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

    dispatch_tantivy_upsert(&tx, abs_path, content).await;
    let _ = tx.send(IndexCmd::Commit).await;
}

/// Dispatch all index updates for a file we just deleted ourselves (or
/// the OLD side of a rename/move).
///
/// Sends, in order:
/// - `RemoveLinks { rel_path }` → evicts LinkGraph entries and in-edges
/// - `RemoveTags  { rel_path }` → evicts TagIndex entries
/// - `DeleteFile  { path }`     → evicts Tantivy doc by path term
/// - `Commit`                    → flushes the writer
///
/// Best-effort — see `dispatch_self_write`.
pub(crate) async fn dispatch_self_delete(state: &VaultState, abs_path: &Path) {
    let vault_root = {
        let Ok(guard) = state.current_vault.lock() else {
            return;
        };
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => return,
        }
    };

    let Ok(rel) = abs_path.strip_prefix(&vault_root) else {
        return;
    };
    let rel_path = rel.to_string_lossy().replace('\\', "/");

    let tx = {
        let Ok(guard) = state.index_coordinator.lock() else {
            return;
        };
        match guard.as_ref() {
            Some(c) => c.tx.clone(),
            None => return,
        }
    };

    let _ = tx
        .send(IndexCmd::RemoveLinks {
            rel_path: rel_path.clone(),
        })
        .await;
    let _ = tx.send(IndexCmd::RemoveTags { rel_path }).await;
    let _ = tx
        .send(IndexCmd::DeleteFile {
            path: abs_path.to_path_buf(),
        })
        .await;
    let _ = tx.send(IndexCmd::Commit).await;
}
