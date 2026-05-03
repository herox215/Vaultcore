//! Sync engine — applies and broadcasts `ChangeEvent`s.
//!
//! Two responsibilities:
//!   - **Outbound:** `on_local_write` records the write in `SyncState`,
//!     bumps the VV, and produces a `ChangeEvent` ready to broadcast.
//!     Callers (the watcher hook in `lib.rs`) feed in raw write events;
//!     this module decides whether to emit, what VV to attach, and which
//!     peers receive it (filtered by capability grant).
//!   - **Inbound:** `apply_remote_event` validates the peer's
//!     capability, runs the dominance check, and routes the event to one
//!     of {discard, fast-forward, mark-for-merge}. **Critical
//!     invariant:** every fast-forward registers in `WriteIgnoreList`
//!     *before* the disk write so the watcher doesn't double-fire on its
//!     own change.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::error::VaultError;
use crate::WriteIgnoreList;

use super::capability::Scope;
use super::protocol::{ChangeEvent, ChangeKind};
use super::state::SyncState;
use super::{ApplyOutcome, ContentHash};

/// What the engine wants the caller to do after `apply_remote_event`.
/// The engine is metadata-only — it never touches the working tree;
/// the caller (watcher / vault open path) performs the disk side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundDecision {
    /// Drop the event — local already dominates.
    Discard,
    /// Overwrite the local file with `content`. The caller MUST first
    /// register `path` in `WriteIgnoreList`.
    FastForward {
        path: PathBuf,
        content: Vec<u8>,
        content_hash: ContentHash,
    },
    /// First-time arrival of a path we'd never seen — same disk action
    /// as FastForward but UI may want to surface it differently
    /// ("Bob shared note.md").
    Created {
        path: PathBuf,
        content: Vec<u8>,
        content_hash: ContentHash,
    },
    /// Concurrent writes — caller invokes the merge path (#420).
    NeedsMerge {
        path: PathBuf,
        remote_content: Vec<u8>,
        remote_hash: ContentHash,
    },
    /// Rename event — caller updates the on-disk path and link graph.
    Rename {
        from: PathBuf,
        to: PathBuf,
    },
    /// Delete event — caller deletes on disk + records a tombstone.
    Delete {
        path: PathBuf,
    },
    /// Capability check failed; caller should log + drop. The connection
    /// itself stays open since this is a single-event authz failure.
    Rejected {
        reason: RejectReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectReason {
    NoGrant,
    InvalidSignature,
    ScopeInsufficient,
    UnknownPeer,
}

/// Engine handle. Holds the metadata store, the shared write-ignore
/// list, and the (optional) sync-batch gate that suppresses per-file
/// indexer dispatch during catch-up reconciliation.
pub struct SyncEngine {
    state: Arc<SyncState>,
    write_ignore: Arc<Mutex<WriteIgnoreList>>,
    batch_gate: Arc<SyncBatchGate>,
    /// Filesystem root the working tree lives under; remote paths are
    /// resolved against this when registering with `WriteIgnoreList`.
    /// `None` while no vault is open.
    vault_root: Mutex<Option<PathBuf>>,
}

impl SyncEngine {
    pub fn new(state: Arc<SyncState>, write_ignore: Arc<Mutex<WriteIgnoreList>>) -> Self {
        Self {
            state,
            write_ignore,
            batch_gate: Arc::new(SyncBatchGate::new()),
            vault_root: Mutex::new(None),
        }
    }

    pub fn set_vault_root(&self, root: PathBuf) -> Result<(), VaultError> {
        *self
            .vault_root
            .lock()
            .map_err(|_| VaultError::LockPoisoned)? = Some(root);
        Ok(())
    }

    pub fn batch_gate(&self) -> &SyncBatchGate {
        &self.batch_gate
    }

    pub fn state(&self) -> &SyncState {
        &self.state
    }

    /// Outbound: build a `ChangeEvent` for a local write. Records the
    /// new VV in `SyncState` and returns the event ready to broadcast.
    pub fn on_local_write(
        &self,
        vault_id: &str,
        path: PathBuf,
        content: Vec<u8>,
        content_hash: ContentHash,
    ) -> Result<ChangeEvent, VaultError> {
        let path_str = path.to_string_lossy().to_string();
        let vv = self
            .state
            .record_local_write(vault_id, &path_str, content_hash, &content)?;
        Ok(ChangeEvent {
            vault_id: vault_id.to_string(),
            path,
            kind: ChangeKind::Upserted { content },
            source_peer: self.state.self_peer().to_string(),
            version_vector: vv,
            content_hash,
        })
    }

    /// Inbound: validate the peer's capability + apply the dominance
    /// rule. Returns the action the caller should take on the working
    /// tree. **Does not** itself touch disk; that's the caller's job
    /// (so the watcher's `WriteIgnoreList` registration sits in the
    /// right call site).
    pub fn apply_remote_event(
        &self,
        event: &ChangeEvent,
        peer_device_id: &str,
    ) -> Result<InboundDecision, VaultError> {
        // Capability check — security boundary per epic #73's
        // "every cross-device sync operation validates a per-vault
        // capability before serving data".
        match self.check_capability(&event.vault_id, peer_device_id, &event.kind)? {
            CapCheck::Ok => {}
            CapCheck::Reject(r) => return Ok(InboundDecision::Rejected { reason: r }),
        }

        let path_str = event.path.to_string_lossy().to_string();

        match &event.kind {
            ChangeKind::Upserted { content } => {
                let outcome = self.state.apply_remote_write(
                    &event.vault_id,
                    &path_str,
                    event.content_hash,
                    event.version_vector.clone(),
                    content,
                )?;
                let abs = self.absolute_path(&event.path)?;
                Ok(match outcome {
                    ApplyOutcome::Discard => InboundDecision::Discard,
                    ApplyOutcome::FastForward => {
                        self.register_write_ignore(&abs)?;
                        InboundDecision::FastForward {
                            path: abs,
                            content: content.clone(),
                            content_hash: event.content_hash,
                        }
                    }
                    ApplyOutcome::Created => {
                        self.register_write_ignore(&abs)?;
                        InboundDecision::Created {
                            path: abs,
                            content: content.clone(),
                            content_hash: event.content_hash,
                        }
                    }
                    ApplyOutcome::Conflict => InboundDecision::NeedsMerge {
                        path: abs,
                        remote_content: content.clone(),
                        remote_hash: event.content_hash,
                    },
                })
            }
            ChangeKind::Renamed { from } => {
                let abs_from = self.absolute_path(from)?;
                let abs_to = self.absolute_path(&event.path)?;
                // Rename is a metadata-only op for the watcher; still
                // register both endpoints so neither side fires a
                // spurious watcher event.
                self.register_write_ignore(&abs_from)?;
                self.register_write_ignore(&abs_to)?;
                Ok(InboundDecision::Rename {
                    from: abs_from,
                    to: abs_to,
                })
            }
            ChangeKind::Deleted => {
                let abs = self.absolute_path(&event.path)?;
                self.register_write_ignore(&abs)?;
                Ok(InboundDecision::Delete { path: abs })
            }
        }
    }

    fn check_capability(
        &self,
        vault_id: &str,
        peer_device_id: &str,
        kind: &ChangeKind,
    ) -> Result<CapCheck, VaultError> {
        let Some(grant) = self.state.vault_grant(vault_id, peer_device_id)? else {
            return Ok(CapCheck::Reject(RejectReason::NoGrant));
        };
        let Some(pubkey_bytes) = self.state.peer_pubkey(peer_device_id)? else {
            return Ok(CapCheck::Reject(RejectReason::UnknownPeer));
        };
        let pubkey = ed25519_dalek::VerifyingKey::from_bytes(&pubkey_bytes).map_err(|e| {
            VaultError::SyncState {
                msg: format!("peer pubkey decode: {e}"),
            }
        })?;
        let body = match grant.verify(&pubkey) {
            Ok(b) => b,
            Err(_) => return Ok(CapCheck::Reject(RejectReason::InvalidSignature)),
        };
        // Read+write events require the ReadWrite scope.
        let needs_write = matches!(
            kind,
            ChangeKind::Upserted { .. } | ChangeKind::Deleted | ChangeKind::Renamed { .. }
        );
        if needs_write && body.scope != Scope::ReadWrite {
            return Ok(CapCheck::Reject(RejectReason::ScopeInsufficient));
        }
        // Sanity: grant must reference the same vault we're applying to.
        if body.local_vault_id != vault_id {
            return Ok(CapCheck::Reject(RejectReason::NoGrant));
        }
        Ok(CapCheck::Ok)
    }

    /// Resolve a vault-relative path against the configured vault root.
    /// **Does NOT** canonicalize — the file may not exist yet (Created /
    /// FastForward). Caller's `validate_rel`-equivalent guard is the
    /// last line of defense; we add a defensive `..` check here too.
    fn absolute_path(&self, rel: &std::path::Path) -> Result<PathBuf, VaultError> {
        let g = self
            .vault_root
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let root = g.as_ref().ok_or_else(|| VaultError::SyncState {
            msg: "sync engine has no vault_root configured".into(),
        })?;
        let rel_str = rel.to_string_lossy();
        if rel_str.contains("..") {
            return Err(VaultError::PathOutsideVault {
                path: rel_str.to_string(),
            });
        }
        Ok(root.join(rel))
    }

    /// **Critical invariant** (epic #73 D-12): register the write before
    /// the watcher could possibly observe it. Must be called from
    /// `apply_remote_event`, never from the caller post-write.
    fn register_write_ignore(&self, abs_path: &std::path::Path) -> Result<(), VaultError> {
        let mut g = self
            .write_ignore
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        g.record(abs_path.to_path_buf());
        Ok(())
    }

    /// Test hook: did the engine register `path` in WriteIgnoreList?
    /// Used by the property test that pins the BEFORE-the-write invariant.
    #[cfg(test)]
    pub fn is_write_ignored(&self, abs_path: &PathBuf) -> Result<bool, VaultError> {
        let g = self
            .write_ignore
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        Ok(g.should_ignore(abs_path))
    }
}

enum CapCheck {
    Ok,
    Reject(RejectReason),
}

// ─── SyncBatchGate ─────────────────────────────────────────────────────

/// Indexer-suppression marker. Wrapped around catch-up reconciliation
/// pulls so per-file `IndexCmd::AddFile` doesn't saturate the queue.
/// Between `begin` and `end`, callers register affected paths via
/// `note_change`; `end` returns the list so the caller can either
/// dispatch a single bulk update or — if oversized — `IndexCmd::Rebuild`.
pub struct SyncBatchGate {
    inner: Mutex<BatchGateInner>,
}

struct BatchGateInner {
    /// Vault id under reconciliation, or None if no batch is open.
    /// Multiple vaults may be reconciling concurrently in theory, but
    /// in practice sync runs one vault at a time and a single in-flight
    /// batch is sufficient for v1.
    open: Option<String>,
    /// Paths affected during this batch. `HashSet` so duplicates collapse.
    affected: std::collections::HashSet<PathBuf>,
}

/// If a batch ends with more than this many distinct affected paths,
/// the caller should issue `IndexCmd::Rebuild` instead of N updates.
pub const BATCH_REBUILD_THRESHOLD: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchOutcome {
    /// Apply per-file index updates for these paths.
    Bulk(Vec<PathBuf>),
    /// Affected count exceeds the threshold — issue a full Rebuild.
    Rebuild { affected_count: usize },
}

impl SyncBatchGate {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BatchGateInner {
                open: None,
                affected: std::collections::HashSet::new(),
            }),
        }
    }

    pub fn is_open(&self) -> bool {
        self.inner
            .lock()
            .map(|g| g.open.is_some())
            .unwrap_or(false)
    }

    pub fn open_vault(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|g| g.open.clone())
    }

    pub fn begin(&self, vault_id: &str) -> Result<(), VaultError> {
        let mut g = self.inner.lock().map_err(|_| VaultError::LockPoisoned)?;
        g.open = Some(vault_id.to_string());
        g.affected.clear();
        Ok(())
    }

    pub fn note_change(&self, path: PathBuf) -> Result<(), VaultError> {
        let mut g = self.inner.lock().map_err(|_| VaultError::LockPoisoned)?;
        if g.open.is_some() {
            g.affected.insert(path);
        }
        Ok(())
    }

    /// True iff a batch is currently open. Used by the indexer-dispatch
    /// hook to decide whether to send a per-file `IndexCmd` or buffer.
    pub fn should_suppress_dispatch(&self) -> bool {
        self.is_open()
    }

    pub fn end(&self) -> Result<BatchOutcome, VaultError> {
        let mut g = self.inner.lock().map_err(|_| VaultError::LockPoisoned)?;
        g.open = None;
        let n = g.affected.len();
        let paths: Vec<PathBuf> = g.affected.drain().collect();
        Ok(if n > BATCH_REBUILD_THRESHOLD {
            BatchOutcome::Rebuild { affected_count: n }
        } else {
            BatchOutcome::Bulk(paths)
        })
    }
}

impl Default for SyncBatchGate {
    fn default() -> Self {
        Self::new()
    }
}
