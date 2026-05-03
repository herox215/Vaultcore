//! Per-vault Merkle hash tree (epic #73 sub-issue #420).
//!
//! Layout:
//!   - Leaf node: `(rel_path, file_hash)`. `file_hash = SHA-256(content)`.
//!   - Folder node: `SHA-256(concat(sorted name||child_hash entries))`.
//!     "Sorted" = lexicographic by `name` so traversal order is
//!     deterministic across peers.
//!   - Vault root: hash of the top-level folder ("").
//!
//! Incremental update strategy:
//!   On every local write, recompute only the changed file's folder
//!   chain up to the root (O(depth), ≈5–10 hashes for typical vaults).
//!   The full vault recomputes only on first index / repair.
//!
//! Persistence: rows in `sync_merkle_nodes`. One row per node, keyed by
//! `(vault_id, node_path)` where the empty string `""` denotes the root
//! folder.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::VaultError;

use super::state::SyncState;
use super::ContentHash;

/// Node kind tag stored alongside the hash so descent can short-circuit
/// at file boundaries without a separate metadata lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    File,
    Folder,
}

impl NodeKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Folder => "folder",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "file" => Some(Self::File),
            "folder" => Some(Self::Folder),
            _ => None,
        }
    }
}

/// Snapshot of one node, returned by `MerkleTree::node` and used by
/// the descent protocol on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MerkleNode {
    pub path: String,
    pub kind: NodeKind,
    pub hash: ContentHash,
}

/// Vault-scoped Merkle helper bound to a `SyncState`. Stateless — every
/// call hits SQLite. Keep one `MerkleTree` per vault; the per-call
/// overhead is one prepared-statement lookup and is well below the
/// 5ms-per-write target.
pub struct MerkleTree<'a> {
    state: &'a SyncState,
    vault_id: String,
}

impl<'a> MerkleTree<'a> {
    pub fn new(state: &'a SyncState, vault_id: impl Into<String>) -> Self {
        Self {
            state,
            vault_id: vault_id.into(),
        }
    }

    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    /// Read the current root hash. `None` if the vault has no nodes yet
    /// (peer compares None vs `Some` and treats either side's None as
    /// "send everything").
    pub fn root(&self) -> Result<Option<ContentHash>, VaultError> {
        match self.node("")? {
            Some(n) => Ok(Some(n.hash)),
            None => Ok(None),
        }
    }

    /// Look up a node by path (`""` = root, `"notes"` = top-level folder,
    /// `"notes/a.md"` = file).
    pub fn node(&self, path: &str) -> Result<Option<MerkleNode>, VaultError> {
        let conn = self.state.lock_conn()?;
        let row: Option<(String, Vec<u8>)> = conn
            .query_row(
                "SELECT kind, hash FROM sync_merkle_nodes
                 WHERE vault_id = ?1 AND node_path = ?2",
                params![&self.vault_id, path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sqlite_err)?;
        let Some((kind_s, hash_bytes)) = row else {
            return Ok(None);
        };
        let kind = NodeKind::parse(&kind_s).ok_or_else(|| VaultError::SyncState {
            msg: format!("invalid merkle kind {kind_s} for {path}"),
        })?;
        if hash_bytes.len() != 32 {
            return Err(VaultError::SyncState {
                msg: format!("merkle hash wrong length: {}", hash_bytes.len()),
            });
        }
        let mut h: ContentHash = [0; 32];
        h.copy_from_slice(&hash_bytes);
        Ok(Some(MerkleNode {
            path: path.to_string(),
            kind,
            hash: h,
        }))
    }

    /// Children of a folder node, returned sorted by name (matches the
    /// hash-input order so the descent protocol sees deterministic
    /// output across peers).
    pub fn children(&self, folder: &str) -> Result<Vec<MerkleNode>, VaultError> {
        let conn = self.state.lock_conn()?;
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        // Direct children only — i.e. `node_path` starts with `prefix`
        // and contains exactly one more `/` than `prefix`.
        let mut stmt = conn
            .prepare(
                "SELECT node_path, kind, hash FROM sync_merkle_nodes
                 WHERE vault_id = ?1 AND parent_path = ?2 AND node_path != ?2
                 ORDER BY node_path",
            )
            .map_err(sqlite_err)?;
        let mut rows = stmt
            .query(params![&self.vault_id, folder])
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sqlite_err)? {
            let path: String = row.get(0).map_err(sqlite_err)?;
            let kind_s: String = row.get(1).map_err(sqlite_err)?;
            let hash_bytes: Vec<u8> = row.get(2).map_err(sqlite_err)?;
            // Defensive: skip non-direct children. Shouldn't happen with
            // the parent_path filter, but guards against future schema
            // bugs that might accidentally over-include.
            if !path.starts_with(&prefix) {
                continue;
            }
            let kind = NodeKind::parse(&kind_s).ok_or_else(|| VaultError::SyncState {
                msg: format!("invalid merkle kind {kind_s}"),
            })?;
            if hash_bytes.len() != 32 {
                return Err(VaultError::SyncState {
                    msg: "merkle hash wrong length".into(),
                });
            }
            let mut h: ContentHash = [0; 32];
            h.copy_from_slice(&hash_bytes);
            let _ = prefix; // reference to suppress warning when prefix unused above
            out.push(MerkleNode {
                path,
                kind,
                hash: h,
            });
        }
        Ok(out)
    }

    /// Apply an upsert (write or rename-into) for `rel_path` with the
    /// given content hash. Walks the folder chain upward, recomputing
    /// each ancestor's hash from its children.
    pub fn upsert_file(&self, rel_path: &str, content_hash: ContentHash) -> Result<(), VaultError> {
        let conn = self.state.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(sqlite_err)?;
        let parent = parent_of(rel_path);
        upsert_node(&tx, &self.vault_id, rel_path, &parent, NodeKind::File, &content_hash)?;
        rebuild_chain(&tx, &self.vault_id, &parent)?;
        tx.commit().map_err(sqlite_err)?;
        Ok(())
    }

    /// Remove a file node and rebuild the folder chain.
    pub fn remove_file(&self, rel_path: &str) -> Result<(), VaultError> {
        let conn = self.state.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(sqlite_err)?;
        tx.execute(
            "DELETE FROM sync_merkle_nodes WHERE vault_id = ?1 AND node_path = ?2",
            params![&self.vault_id, rel_path],
        )
        .map_err(sqlite_err)?;
        let parent = parent_of(rel_path);
        rebuild_chain(&tx, &self.vault_id, &parent)?;
        tx.commit().map_err(sqlite_err)?;
        Ok(())
    }

    /// Bulk recompute from a `(rel_path, content_hash)` iterator.
    /// Used on first index or repair. Wipes existing nodes for this
    /// vault first, then walks the input to insert files + rebuild
    /// folders bottom-up.
    pub fn rebuild_full<I>(&self, files: I) -> Result<(), VaultError>
    where
        I: IntoIterator<Item = (String, ContentHash)>,
    {
        let conn = self.state.lock_conn()?;
        let tx = conn.unchecked_transaction().map_err(sqlite_err)?;
        tx.execute(
            "DELETE FROM sync_merkle_nodes WHERE vault_id = ?1",
            params![&self.vault_id],
        )
        .map_err(sqlite_err)?;
        // Collect leaves grouped by parent dir so we can build folders bottom-up.
        let mut by_parent: BTreeMap<String, Vec<(String, ContentHash)>> = BTreeMap::new();
        for (path, h) in files {
            let parent = parent_of(&path);
            by_parent.entry(parent).or_default().push((path, h));
        }
        // Insert leaves.
        for (parent, leaves) in &by_parent {
            for (path, h) in leaves {
                upsert_node(&tx, &self.vault_id, path, parent, NodeKind::File, h)?;
            }
        }
        // Walk every directory implied by the inputs (including ancestors)
        // and rebuild folder hashes deepest-first.
        let mut all_dirs: BTreeMap<String, ()> = BTreeMap::new();
        all_dirs.insert(String::new(), ());
        for parent in by_parent.keys() {
            let mut cur = parent.clone();
            loop {
                all_dirs.insert(cur.clone(), ());
                if cur.is_empty() {
                    break;
                }
                cur = parent_of(&cur);
            }
        }
        // Sort by component depth descending. The depth count includes
        // the segment count, NOT just slashes — `""` has depth 0,
        // `"d1"` depth 1, `"d2/d2"` depth 2. Without this, root ("")
        // and a top-level dir like "d1" would tie at "0 slashes" and
        // sort unstably; root could be computed before its children.
        let mut deepest_first: Vec<String> = all_dirs.into_keys().collect();
        deepest_first.sort_by_key(|d| {
            let depth = if d.is_empty() {
                0
            } else {
                d.split('/').count()
            };
            std::cmp::Reverse(depth)
        });
        for dir in deepest_first {
            recompute_folder(&tx, &self.vault_id, &dir)?;
        }
        tx.commit().map_err(sqlite_err)?;
        Ok(())
    }
}

// ─── Reconciliation descent ───────────────────────────────────────────

/// One step of the descent protocol. Caller starts at `""` (root); on
/// hash-mismatch the protocol descends into each differing folder until
/// it bottoms out at file leaves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffStep {
    /// Subtree hashes match — no further descent needed.
    Equal,
    /// Two folders differ. Caller compares their child lists and
    /// recurses into mismatched entries.
    FolderDiffer {
        folder: String,
        local: Vec<MerkleNode>,
        remote_children: Vec<MerkleNode>,
    },
    /// Two file hashes differ — emit the path for the change-event pull.
    FilePathDiffers(String),
    /// File present locally but not remotely (or vice versa).
    OnlyLocal(String),
    OnlyRemote(String),
}

/// Compute the differing file paths between `local` (this side's tree)
/// and a `peer_node_lookup` callback that returns the peer's node at a
/// given path. Used by the test suite and by the eventual remote-driven
/// descent loop in the sync engine.
pub fn diff_paths(
    local: &MerkleTree<'_>,
    peer_node: &mut dyn FnMut(&str) -> Option<MerkleNode>,
) -> Result<Vec<String>, VaultError> {
    let mut out = Vec::new();
    descend(local, "", peer_node, &mut out)?;
    Ok(out)
}

fn descend(
    local: &MerkleTree<'_>,
    folder: &str,
    peer_node: &mut dyn FnMut(&str) -> Option<MerkleNode>,
    out: &mut Vec<String>,
) -> Result<(), VaultError> {
    let local_self = local.node(folder)?;
    let peer_self = peer_node(folder);
    match (local_self.as_ref(), peer_self.as_ref()) {
        (Some(l), Some(r)) if l.hash == r.hash => return Ok(()),
        (None, None) => return Ok(()),
        _ => {}
    }
    let local_children = local.children(folder)?;
    let local_index: BTreeMap<&str, &MerkleNode> =
        local_children.iter().map(|n| (n.path.as_str(), n)).collect();
    // Collect peer children at this folder by probing each known local
    // path + relying on the caller to supply peer-only paths via the
    // `OnlyRemote` branch (handled by the engine — out of scope here).
    let mut seen: BTreeMap<&str, bool> = BTreeMap::new();
    for (path, ln) in &local_index {
        let peer_n = peer_node(path);
        seen.insert(path, true);
        match (ln.kind, peer_n.as_ref()) {
            (NodeKind::File, Some(rn)) if rn.kind == NodeKind::File => {
                if ln.hash != rn.hash {
                    out.push(path.to_string());
                }
            }
            (NodeKind::File, None) => {
                out.push(path.to_string()); // peer is missing this file.
            }
            (NodeKind::Folder, Some(rn)) if rn.kind == NodeKind::Folder => {
                if ln.hash != rn.hash {
                    descend(local, path, peer_node, out)?;
                }
            }
            (NodeKind::Folder, None) => {
                // Whole subtree needs to be sent to peer. Walk locally
                // and emit every leaf path.
                emit_subtree_files(local, path, out)?;
            }
            // Type mismatch: emit as file diff so the engine resolves
            // (e.g. someone replaced a folder with a file of the same
            // name — vanishingly rare on Markdown vaults but defensive).
            _ => out.push(path.to_string()),
        }
    }
    Ok(())
}

fn emit_subtree_files(
    local: &MerkleTree<'_>,
    folder: &str,
    out: &mut Vec<String>,
) -> Result<(), VaultError> {
    for child in local.children(folder)? {
        match child.kind {
            NodeKind::File => out.push(child.path),
            NodeKind::Folder => emit_subtree_files(local, &child.path, out)?,
        }
    }
    Ok(())
}

// ─── Internals ────────────────────────────────────────────────────────

fn sqlite_err(e: rusqlite::Error) -> VaultError {
    VaultError::SyncState {
        msg: format!("sqlite: {e}"),
    }
}

fn parent_of(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let p = Path::new(path);
    let mut comps: Vec<&str> = p
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_str().unwrap_or("")),
            _ => None,
        })
        .collect();
    if comps.len() <= 1 {
        return String::new();
    }
    comps.pop();
    comps.join("/")
}

fn upsert_node(
    tx: &rusqlite::Transaction<'_>,
    vault_id: &str,
    path: &str,
    parent: &str,
    kind: NodeKind,
    hash: &ContentHash,
) -> Result<(), VaultError> {
    tx.execute(
        "INSERT INTO sync_merkle_nodes (vault_id, node_path, parent_path, kind, hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(vault_id, node_path) DO UPDATE SET
             parent_path = excluded.parent_path,
             kind = excluded.kind,
             hash = excluded.hash",
        params![vault_id, path, parent, kind.as_str(), &hash[..]],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

/// Recompute folder hash by hashing every direct child's `name||hash`
/// (`name` = last component of `node_path`).
fn recompute_folder(
    tx: &rusqlite::Transaction<'_>,
    vault_id: &str,
    folder: &str,
) -> Result<(), VaultError> {
    let mut stmt = tx
        .prepare(
            "SELECT node_path, hash FROM sync_merkle_nodes
             WHERE vault_id = ?1 AND parent_path = ?2 AND node_path != ?2
             ORDER BY node_path",
        )
        .map_err(sqlite_err)?;
    let mut rows = stmt
        .query(params![vault_id, folder])
        .map_err(sqlite_err)?;
    let mut hasher = Sha256::new();
    let mut child_count = 0usize;
    while let Some(row) = rows.next().map_err(sqlite_err)? {
        let path: String = row.get(0).map_err(sqlite_err)?;
        let hash_bytes: Vec<u8> = row.get(1).map_err(sqlite_err)?;
        let name = last_component(&path);
        hasher.update(name.as_bytes());
        hasher.update([0u8]); // separator — keeps `name`+hash field-distinguishable.
        hasher.update(&hash_bytes);
        child_count += 1;
    }
    drop(rows);
    drop(stmt);
    if child_count == 0 {
        // Empty folder. Still keep a node so descent has something to
        // compare against; hash is SHA-256 of the literal empty string
        // (deterministic, peer-comparable).
        let h: ContentHash = Sha256::digest(b"").into();
        upsert_node(tx, vault_id, folder, &parent_of(folder), NodeKind::Folder, &h)?;
        return Ok(());
    }
    let h: ContentHash = hasher.finalize().into();
    let parent = parent_of(folder);
    upsert_node(tx, vault_id, folder, &parent, NodeKind::Folder, &h)?;
    Ok(())
}

fn rebuild_chain(
    tx: &rusqlite::Transaction<'_>,
    vault_id: &str,
    start_dir: &str,
) -> Result<(), VaultError> {
    let mut cur = start_dir.to_string();
    loop {
        recompute_folder(tx, vault_id, &cur)?;
        if cur.is_empty() {
            break;
        }
        cur = parent_of(&cur);
    }
    Ok(())
}

fn last_component(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Convenience: hash a file's content into the canonical leaf hash.
pub fn hash_file_content(content: &[u8]) -> ContentHash {
    let h = Sha256::digest(content);
    let mut out: ContentHash = [0; 32];
    out.copy_from_slice(&h);
    out
}

/// Suppress unused-import warning for `PathBuf` — included for callers
/// that round-trip `Path`/`PathBuf` through this module's helpers.
#[allow(dead_code)]
fn _path_kind_check(_p: PathBuf) {}
