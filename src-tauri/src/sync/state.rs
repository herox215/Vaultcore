//! Sync metadata store backed by a single SQLite database
//! (`<vault>/.vaultcore/sync-state.sqlite`).
//!
//! Schema is the verbatim epic #73 specification — `PRAGMA user_version = 1`.
//! Adding a column or table requires bumping `user_version` and adding a
//! `migrate_v1_to_v2` arm in [`SyncState::open`]; never edit the v1 SQL.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::VaultError;

use super::clock::{Clock, SystemClock};
use super::history::{History, HistoryConfig};
use super::tombstone::Tombstones;
use super::{ApplyOutcome, ContentHash, PeerId, VaultId, VersionVector};

/// Current schema version. Bump and add a migration arm if the schema
/// changes; never mutate the v1 SQL in place.
pub const SCHEMA_VERSION: u32 = 1;

/// Subdirectory under `.vaultcore/` that backs the content-addressed
/// history blob store.
const HISTORY_DIRNAME: &str = "sync-history";

/// Full v1 schema, exactly as specified in epic #73. Wrapped in a
/// transaction at open-time. **Do not edit** — to evolve the schema,
/// bump `SCHEMA_VERSION` and add a `migrate_v1_to_v2` step.
const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS sync_files (
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash BLOB NOT NULL,
  version_vector BLOB NOT NULL,
  last_synced_wall_time INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);

CREATE TABLE IF NOT EXISTS sync_peers (
  peer_device_id TEXT PRIMARY KEY,
  peer_pubkey BLOB NOT NULL,
  peer_name TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER,
  trust_state TEXT NOT NULL,
  superseded_by TEXT
);

CREATE TABLE IF NOT EXISTS sync_vault_grants (
  local_vault_id TEXT NOT NULL,
  peer_device_id TEXT NOT NULL,
  peer_vault_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  capability_token BLOB NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  requires_unlock INTEGER NOT NULL DEFAULT 0,
  wrapped_key BLOB,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (local_vault_id, peer_device_id)
);

CREATE TABLE IF NOT EXISTS sync_history (
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash BLOB NOT NULL,
  version_vector BLOB NOT NULL,
  blob_path TEXT NOT NULL,
  retained_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path, content_hash)
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  deleted_at_vv BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_expires ON sync_tombstones(expires_at);
CREATE INDEX IF NOT EXISTS idx_history_retained ON sync_history(vault_id, path, retained_at);

-- #420: per-vault Merkle hash tree backing catch-up reconciliation.
-- One row per node: `node_path = ""` is the root folder. `parent_path`
-- is the index used by the descent protocol to fetch direct children
-- in O(children).
CREATE TABLE IF NOT EXISTS sync_merkle_nodes (
  vault_id TEXT NOT NULL,
  node_path TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- 'file' | 'folder'
  hash BLOB NOT NULL,
  PRIMARY KEY (vault_id, node_path)
);
CREATE INDEX IF NOT EXISTS idx_merkle_parent ON sync_merkle_nodes(vault_id, parent_path);
"#;

/// Per-file row from `sync_files`. Returned by the read APIs the sync
/// engine uses to decide fast-forward / discard / 3-way merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    pub vault_id: VaultId,
    pub path: String,
    pub content_hash: ContentHash,
    pub version_vector: VersionVector,
    pub last_synced_wall_time: i64,
}

/// Top-level handle bundling the SQLite connection, history blob store,
/// and tombstone helper. The caller threads a single `SyncState` through
/// the sync stack; concurrency is handled by the wrapped `Mutex`
/// (throughput is not on the critical path of editor latency).
pub struct SyncState {
    conn: Mutex<Connection>,
    history: History,
    clock: Arc<dyn Clock>,
    /// Stable owning peer id (`device_id`). Stored here so
    /// `record_local_write` can increment the right slot of the VV
    /// without the caller threading it through every call site.
    self_peer: PeerId,
}

impl SyncState {
    /// Open or create the sync-state DB at `vault_metadata_dir/sync-state.sqlite`.
    /// `vault_metadata_dir` is the path returned by `VaultStorage::metadata_path()`
    /// (i.e. `<vault>/.vaultcore` on desktop). The history blob store is
    /// created at `<vault_metadata_dir>/sync-history/`.
    pub fn open(
        vault_metadata_dir: &Path,
        self_peer: PeerId,
    ) -> Result<Self, VaultError> {
        Self::open_with(
            vault_metadata_dir,
            self_peer,
            Arc::new(SystemClock),
            HistoryConfig::default(),
        )
    }

    /// Test-friendly variant that accepts an injectable clock + history config.
    pub fn open_with(
        vault_metadata_dir: &Path,
        self_peer: PeerId,
        clock: Arc<dyn Clock>,
        history_cfg: HistoryConfig,
    ) -> Result<Self, VaultError> {
        std::fs::create_dir_all(vault_metadata_dir).map_err(VaultError::Io)?;
        let db_path = vault_metadata_dir.join("sync-state.sqlite");
        let history_root = vault_metadata_dir.join(HISTORY_DIRNAME);

        let conn = Connection::open(&db_path).map_err(sqlite_err)?;
        Self::initialize_schema(&conn)?;

        let history = History::new(history_root, history_cfg);

        Ok(Self {
            conn: Mutex::new(conn),
            history,
            clock,
            self_peer,
        })
    }

    /// Apply the v1 schema if `user_version` is 0; verify it matches
    /// `SCHEMA_VERSION` otherwise. Future migrations dispatch off the
    /// existing `user_version` here.
    fn initialize_schema(conn: &Connection) -> Result<(), VaultError> {
        let current: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sqlite_err)?;

        if current == 0 {
            conn.execute_batch(SCHEMA_V1).map_err(sqlite_err)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(sqlite_err)?;
        } else if current != SCHEMA_VERSION {
            return Err(VaultError::SyncState {
                msg: format!(
                    "unsupported sync-state schema version {current} (expected {SCHEMA_VERSION})"
                ),
            });
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<u32, VaultError> {
        let conn = self.lock_conn()?;
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sqlite_err)
    }

    pub fn self_peer(&self) -> &str {
        &self.self_peer
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    /// Tombstone helper bound to this DB connection. Re-issued cheaply on
    /// each call (`Tombstones` borrows `&self`).
    pub fn tombstones(&self) -> Tombstones<'_> {
        Tombstones::new(self)
    }

    // ─── Peer trust store (sync_peers) ────────────────────────────────────

    /// Insert or update a peer record. Used by the pairing flow on
    /// successful PAKE + key-confirmation to persist the peer's
    /// long-term Ed25519 pubkey.
    pub fn upsert_peer(
        &self,
        peer_device_id: &str,
        peer_pubkey: &[u8; 32],
        peer_name: &str,
        trust_state: PeerTrust,
    ) -> Result<(), VaultError> {
        let now = self.clock.now_secs();
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO sync_peers (peer_device_id, peer_pubkey, peer_name, paired_at, last_seen, trust_state, superseded_by)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL)
             ON CONFLICT(peer_device_id) DO UPDATE SET
                 peer_pubkey = excluded.peer_pubkey,
                 peer_name = excluded.peer_name,
                 trust_state = excluded.trust_state",
            rusqlite::params![peer_device_id, &peer_pubkey[..], peer_name, now, trust_state.as_str()],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Look up the peer's pubkey for capability-signature verification.
    /// Returns `None` if the peer is unknown or revoked.
    pub fn peer_pubkey(&self, peer_device_id: &str) -> Result<Option<[u8; 32]>, VaultError> {
        let conn = self.lock_conn()?;
        let row: Option<(Vec<u8>, String)> = conn
            .query_row(
                "SELECT peer_pubkey, trust_state FROM sync_peers WHERE peer_device_id = ?1",
                rusqlite::params![peer_device_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sqlite_err)?;
        let Some((bytes, trust)) = row else {
            return Ok(None);
        };
        if trust != PeerTrust::Trusted.as_str() {
            return Ok(None);
        }
        if bytes.len() != 32 {
            return Err(VaultError::SyncState {
                msg: format!("peer_pubkey wrong length: {}", bytes.len()),
            });
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(Some(out))
    }

    // ─── Capability grants (sync_vault_grants) ────────────────────────────

    /// Persist a signed `Capability` as a row in `sync_vault_grants`.
    /// `local_vault_id` and `peer_device_id` are the primary key —
    /// re-issuing replaces the prior token.
    pub fn upsert_vault_grant(
        &self,
        capability: &super::capability::Capability,
    ) -> Result<(), VaultError> {
        let body = bincode::deserialize::<super::capability::CapabilityBody>(&capability.body)
            .map_err(|e| VaultError::SyncState {
                msg: format!("capability body decode: {e}"),
            })?;
        let token_bytes = capability.to_bytes();
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO sync_vault_grants (
                local_vault_id, peer_device_id, peer_vault_id, scope,
                capability_token, format_version, requires_unlock, wrapped_key, enabled
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
             ON CONFLICT(local_vault_id, peer_device_id) DO UPDATE SET
                 peer_vault_id = excluded.peer_vault_id,
                 scope = excluded.scope,
                 capability_token = excluded.capability_token,
                 format_version = excluded.format_version,
                 requires_unlock = excluded.requires_unlock,
                 wrapped_key = excluded.wrapped_key,
                 enabled = 1",
            rusqlite::params![
                body.local_vault_id,
                body.peer_device_id,
                body.peer_vault_id,
                body.scope.as_str(),
                token_bytes,
                body.format_version,
                body.requires_unlock,
                body.wrapped_key,
            ],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Fetch the `Capability` for a `(local_vault_id, peer_device_id)` pair
    /// if one is enabled. Returns `None` if the grant is missing or
    /// disabled — caller treats that as "no access".
    pub fn vault_grant(
        &self,
        local_vault_id: &str,
        peer_device_id: &str,
    ) -> Result<Option<super::capability::Capability>, VaultError> {
        let conn = self.lock_conn()?;
        let row: Option<Vec<u8>> = conn
            .query_row(
                "SELECT capability_token FROM sync_vault_grants
                 WHERE local_vault_id = ?1 AND peer_device_id = ?2 AND enabled = 1",
                rusqlite::params![local_vault_id, peer_device_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite_err)?;
        let Some(bytes) = row else {
            return Ok(None);
        };
        Ok(Some(super::capability::Capability::from_bytes(&bytes)?))
    }

    /// Enumerate every `Trusted` peer with its display name + last-seen
    /// timestamp. Used by the IPC bridge's `sync_list_paired_peers`
    /// command to populate the Settings → Sync paired-devices list.
    /// Revoked / superseded peers are excluded from the response.
    pub fn list_paired_peers(&self) -> Result<Vec<PairedPeerRecord>, VaultError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT peer_device_id, peer_name, last_seen
                 FROM sync_peers
                 WHERE trust_state = ?1
                 ORDER BY peer_device_id",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(rusqlite::params![PeerTrust::Trusted.as_str()], |r| {
                Ok(PairedPeerRecord {
                    peer_device_id: r.get(0)?,
                    peer_name: r.get(1)?,
                    last_seen: r.get::<_, Option<i64>>(2)?,
                })
            })
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(sqlite_err)?);
        }
        Ok(out)
    }

    /// All enabled grants issued to `peer_device_id` across every
    /// `local_vault_id` tracked by this DB. Returns `(local_vault_id,
    /// peer_vault_id, scope)` triples in stable lexicographic order.
    pub fn list_grants_for_peer(
        &self,
        peer_device_id: &str,
    ) -> Result<Vec<GrantRecord>, VaultError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT local_vault_id, peer_vault_id, scope
                 FROM sync_vault_grants
                 WHERE peer_device_id = ?1 AND enabled = 1
                 ORDER BY local_vault_id",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(rusqlite::params![peer_device_id], |r| {
                Ok(GrantRecord {
                    local_vault_id: r.get(0)?,
                    peer_vault_id: r.get(1)?,
                    scope: r.get(2)?,
                })
            })
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(sqlite_err)?);
        }
        Ok(out)
    }

    /// Disable the grant for `(local_vault_id, peer_device_id)`. The row
    /// stays in the table so re-grant retains the previous wrapped_key
    /// (if any) without needing a new key-exchange round-trip; capability
    /// validation skips disabled rows via the `enabled = 1` predicate
    /// already in `vault_grant`.
    pub fn disable_vault_grant(
        &self,
        local_vault_id: &str,
        peer_device_id: &str,
    ) -> Result<bool, VaultError> {
        let conn = self.lock_conn()?;
        let n = conn
            .execute(
                "UPDATE sync_vault_grants SET enabled = 0
                 WHERE local_vault_id = ?1 AND peer_device_id = ?2 AND enabled = 1",
                rusqlite::params![local_vault_id, peer_device_id],
            )
            .map_err(sqlite_err)?;
        Ok(n > 0)
    }

    /// Mark a peer's trust state as `Revoked` and disable every grant
    /// row for that peer in one transaction. Used by
    /// `sync_revoke_peer` when the user removes a paired device entirely
    /// rather than per-vault. Returns the number of grants affected.
    pub fn revoke_peer(&self, peer_device_id: &str) -> Result<usize, VaultError> {
        let conn = self.lock_conn()?;
        let tx = conn_transaction(&conn)?;
        tx.execute(
            "UPDATE sync_peers SET trust_state = ?1
             WHERE peer_device_id = ?2",
            rusqlite::params![PeerTrust::Revoked.as_str(), peer_device_id],
        )
        .map_err(sqlite_err)?;
        let n = tx
            .execute(
                "UPDATE sync_vault_grants SET enabled = 0 WHERE peer_device_id = ?1",
                rusqlite::params![peer_device_id],
            )
            .map_err(sqlite_err)?;
        tx.commit().map_err(sqlite_err)?;
        Ok(n)
    }

    // ─── Read APIs ───────────────────────────────────────────────────────

    /// Fetch the `(content_hash, vv)` for a tracked file, if any.
    pub fn get_file(
        &self,
        vault_id: &str,
        path: &str,
    ) -> Result<Option<FileRecord>, VaultError> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT vault_id, path, content_hash, version_vector, last_synced_wall_time
             FROM sync_files WHERE vault_id = ?1 AND path = ?2",
            params![vault_id, path],
            row_to_file_record,
        )
        .optional()
        .map_err(sqlite_err)
    }

    // ─── Write APIs ──────────────────────────────────────────────────────

    /// Record a local write. Reads the current VV (or zero if absent),
    /// increments `self_peer`'s counter, persists `(content_hash, vv)`,
    /// and copies the bytes into the history blob store with LRU
    /// eviction.
    ///
    /// Returns the new VV so callers can broadcast it to peers without a
    /// second round-trip to the DB.
    pub fn record_local_write(
        &self,
        vault_id: &str,
        path: &str,
        content_hash: ContentHash,
        content: &[u8],
    ) -> Result<VersionVector, VaultError> {
        let now = self.clock.now_secs();
        let mut vv = self
            .get_file(vault_id, path)?
            .map(|r| r.version_vector)
            .unwrap_or_default();
        vv.increment(&self.self_peer);
        let vv_bytes = vv.to_bytes();

        // History record: write the blob first, then the index row, so a
        // crash between the two leaves an orphan blob (cheap to GC) rather
        // than a dangling DB pointer.
        let blob_rel = self
            .history
            .put_blob(content_hash, content)
            .map_err(VaultError::Io)?;

        let conn = self.lock_conn()?;
        let tx = conn_transaction(&conn)?;
        tx.execute(
            "INSERT INTO sync_files (vault_id, path, content_hash, version_vector, last_synced_wall_time)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(vault_id, path) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 version_vector = excluded.version_vector,
                 last_synced_wall_time = excluded.last_synced_wall_time",
            params![vault_id, path, &content_hash[..], &vv_bytes, now],
        )
        .map_err(sqlite_err)?;
        upsert_history_row(&tx, vault_id, path, &content_hash, &vv_bytes, &blob_rel, now)?;
        evict_history_lru(&tx, vault_id, path, self.history.config().retain_per_file)?;
        tx.commit().map_err(sqlite_err)?;
        // Best-effort: prune blob files whose index rows just got deleted.
        // Failure here is non-fatal — `History::gc_orphans` cleans up next pass.
        Ok(vv)
    }

    /// Apply a remote write decision. Does NOT touch the working file —
    /// the caller is responsible for that (this layer is metadata-only).
    /// On `FastForward` / `Created`, the new `(content_hash, vv)` is
    /// persisted and the supplied bytes are stashed in history.
    pub fn apply_remote_write(
        &self,
        vault_id: &str,
        path: &str,
        remote_hash: ContentHash,
        remote_vv: VersionVector,
        remote_content: &[u8],
    ) -> Result<ApplyOutcome, VaultError> {
        let now = self.clock.now_secs();
        let existing = self.get_file(vault_id, path)?;

        let outcome = match &existing {
            None => ApplyOutcome::Created,
            Some(local) if local.version_vector == remote_vv => {
                // Identical VV → already in sync; treat as discard.
                return Ok(ApplyOutcome::Discard);
            }
            Some(local) if local.version_vector.dominates(&remote_vv) => ApplyOutcome::Discard,
            Some(local) if remote_vv.dominates(&local.version_vector) => ApplyOutcome::FastForward,
            Some(_) => ApplyOutcome::Conflict,
        };

        if matches!(outcome, ApplyOutcome::Discard | ApplyOutcome::Conflict) {
            // Concurrent: also stash the remote blob in history so the
            // 3-way merge call site can fetch it by hash. Cheap and
            // bounded by LRU eviction.
            if matches!(outcome, ApplyOutcome::Conflict) {
                let blob_rel = self
                    .history
                    .put_blob(remote_hash, remote_content)
                    .map_err(VaultError::Io)?;
                let conn = self.lock_conn()?;
                let tx = conn_transaction(&conn)?;
                upsert_history_row(
                    &tx,
                    vault_id,
                    path,
                    &remote_hash,
                    &remote_vv.to_bytes(),
                    &blob_rel,
                    now,
                )?;
                evict_history_lru(&tx, vault_id, path, self.history.config().retain_per_file)?;
                tx.commit().map_err(sqlite_err)?;
            }
            return Ok(outcome);
        }

        // FastForward or Created: persist and stash blob.
        let vv_bytes = remote_vv.to_bytes();
        let blob_rel = self
            .history
            .put_blob(remote_hash, remote_content)
            .map_err(VaultError::Io)?;

        let conn = self.lock_conn()?;
        let tx = conn_transaction(&conn)?;
        tx.execute(
            "INSERT INTO sync_files (vault_id, path, content_hash, version_vector, last_synced_wall_time)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(vault_id, path) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 version_vector = excluded.version_vector,
                 last_synced_wall_time = excluded.last_synced_wall_time",
            params![vault_id, path, &remote_hash[..], &vv_bytes, now],
        )
        .map_err(sqlite_err)?;
        upsert_history_row(&tx, vault_id, path, &remote_hash, &vv_bytes, &blob_rel, now)?;
        evict_history_lru(&tx, vault_id, path, self.history.config().retain_per_file)?;
        tx.commit().map_err(sqlite_err)?;

        Ok(outcome)
    }

    /// Look up a historical version's blob bytes by content hash.
    /// Returns `None` if the hash isn't in this file's retention window
    /// — caller should fall back to conflict-copy semantics.
    pub fn get_history(
        &self,
        vault_id: &str,
        path: &str,
        content_hash: &ContentHash,
    ) -> Result<Option<Vec<u8>>, VaultError> {
        let conn = self.lock_conn()?;
        let blob_path: Option<String> = conn
            .query_row(
                "SELECT blob_path FROM sync_history
                 WHERE vault_id = ?1 AND path = ?2 AND content_hash = ?3",
                params![vault_id, path, &content_hash[..]],
                |row| row.get(0),
            )
            .optional()
            .map_err(sqlite_err)?;
        let Some(rel) = blob_path else {
            return Ok(None);
        };
        drop(conn);
        let bytes = self
            .history
            .read_blob(Path::new(&rel))
            .map_err(VaultError::Io)?;
        Ok(Some(bytes))
    }

    // ─── Internals shared with sibling submodules ─────────────────────────

    pub(crate) fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, VaultError> {
        self.conn.lock().map_err(|_| VaultError::LockPoisoned)
    }

    pub(crate) fn clock(&self) -> &dyn Clock {
        self.clock.as_ref()
    }
}

/// Row returned by [`SyncState::list_paired_peers`]. Shape mirrors the
/// columns the IPC bridge cares about (id, display name, last-seen) —
/// the long-term pubkey isn't needed by the UI and is kept off the wire
/// to avoid accidentally surfacing it through frontend-side logging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedPeerRecord {
    pub peer_device_id: String,
    pub peer_name: String,
    pub last_seen: Option<i64>,
}

/// Row returned by [`SyncState::list_grants_for_peer`]. Carries the raw
/// `scope` string straight from the column so the IPC layer can pass it
/// to `Scope::parse` without re-deserializing the full capability blob.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantRecord {
    pub local_vault_id: String,
    pub peer_vault_id: String,
    pub scope: String,
}

/// `sync_peers.trust_state` values per epic schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerTrust {
    Trusted,
    Revoked,
    Superseded,
}

impl PeerTrust {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Revoked => "revoked",
            Self::Superseded => "superseded",
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

fn sqlite_err(e: rusqlite::Error) -> VaultError {
    VaultError::SyncState {
        msg: format!("sqlite: {e}"),
    }
}

fn row_to_file_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileRecord> {
    let vault_id: String = row.get(0)?;
    let path: String = row.get(1)?;
    let hash_bytes: Vec<u8> = row.get(2)?;
    let vv_bytes: Vec<u8> = row.get(3)?;
    let last_synced_wall_time: i64 = row.get(4)?;
    let mut content_hash: ContentHash = [0; 32];
    if hash_bytes.len() != 32 {
        return Err(rusqlite::Error::InvalidColumnType(
            2,
            "content_hash must be 32 bytes".into(),
            rusqlite::types::Type::Blob,
        ));
    }
    content_hash.copy_from_slice(&hash_bytes);
    let vv = VersionVector::from_bytes(&vv_bytes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Blob, Box::new(e))
    })?;
    Ok(FileRecord {
        vault_id,
        path,
        content_hash,
        version_vector: vv,
        last_synced_wall_time,
    })
}

fn conn_transaction(conn: &Connection) -> Result<rusqlite::Transaction<'_>, VaultError> {
    // SAFETY: `Connection::unchecked_transaction` borrows `&self` to start a
    // transaction; needed because we hold a `MutexGuard<'_, Connection>` and
    // `Connection::transaction` requires `&mut self`.
    conn.unchecked_transaction().map_err(sqlite_err)
}

fn upsert_history_row(
    tx: &rusqlite::Transaction<'_>,
    vault_id: &str,
    path: &str,
    content_hash: &ContentHash,
    vv_bytes: &[u8],
    blob_rel: &Path,
    retained_at: i64,
) -> Result<(), VaultError> {
    let blob_path_str = blob_rel.to_string_lossy().to_string();
    tx.execute(
        "INSERT INTO sync_history (vault_id, path, content_hash, version_vector, blob_path, retained_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(vault_id, path, content_hash) DO UPDATE SET
             version_vector = excluded.version_vector,
             blob_path = excluded.blob_path,
             retained_at = excluded.retained_at",
        params![vault_id, path, &content_hash[..], vv_bytes, blob_path_str, retained_at],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

/// Keep only the `keep` most recently retained history rows per
/// `(vault_id, path)`; delete the rest. Blob files orphaned by this
/// step are cleaned by `History::gc_orphans`, which the caller can run
/// opportunistically.
fn evict_history_lru(
    tx: &rusqlite::Transaction<'_>,
    vault_id: &str,
    path: &str,
    keep: usize,
) -> Result<(), VaultError> {
    tx.execute(
        "DELETE FROM sync_history
         WHERE vault_id = ?1 AND path = ?2
           AND content_hash NOT IN (
               SELECT content_hash FROM sync_history
               WHERE vault_id = ?1 AND path = ?2
               ORDER BY retained_at DESC
               LIMIT ?3
           )",
        params![vault_id, path, keep as i64],
    )
    .map_err(sqlite_err)?;
    Ok(())
}
