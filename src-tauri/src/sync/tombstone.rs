//! Deletion records with a 30-day TTL (epic #73). The TTL gives offline
//! peers a window to receive the deletion without resurrection;
//! `gc_tombstones` clears expired rows so the table stays bounded.

use rusqlite::params;

use crate::error::VaultError;

use super::state::SyncState;
use super::VersionVector;

/// Tombstone retention window per epic #73's "30-day TTL" decision.
pub const TOMBSTONE_TTL_SECS: i64 = 30 * 24 * 60 * 60;

pub struct Tombstones<'a> {
    state: &'a SyncState,
}

impl<'a> Tombstones<'a> {
    pub(crate) fn new(state: &'a SyncState) -> Self {
        Self { state }
    }

    /// Record a deletion. `expires_at` is `now + TOMBSTONE_TTL_SECS`.
    /// On conflict (re-delete) the row is replaced so the TTL window
    /// extends — the deletion event we're propagating is the most recent.
    pub fn record_delete(
        &self,
        vault_id: &str,
        path: &str,
        deleted_at_vv: &VersionVector,
    ) -> Result<(), VaultError> {
        let now = self.state.clock().now_secs();
        let expires_at = now + TOMBSTONE_TTL_SECS;
        let vv_bytes = deleted_at_vv.to_bytes();
        let conn = self.state.lock_conn()?;
        conn.execute(
            "INSERT INTO sync_tombstones (vault_id, path, deleted_at_vv, expires_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(vault_id, path) DO UPDATE SET
                 deleted_at_vv = excluded.deleted_at_vv,
                 expires_at = excluded.expires_at",
            params![vault_id, path, &vv_bytes, expires_at],
        )
        .map_err(|e| VaultError::SyncState {
            msg: format!("sqlite: {e}"),
        })?;
        Ok(())
    }

    /// Returns true if a non-expired tombstone exists for this `(vault_id, path)`.
    pub fn is_tombstoned(&self, vault_id: &str, path: &str) -> Result<bool, VaultError> {
        let now = self.state.clock().now_secs();
        let conn = self.state.lock_conn()?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_tombstones
                 WHERE vault_id = ?1 AND path = ?2 AND expires_at > ?3",
                params![vault_id, path, now],
                |row| row.get(0),
            )
            .map_err(|e| VaultError::SyncState {
                msg: format!("sqlite: {e}"),
            })?;
        Ok(count > 0)
    }

    /// Delete expired tombstones. Returns the count removed. Indexed
    /// scan via `idx_tombstones_expires` keeps this O(removed).
    pub fn gc(&self) -> Result<usize, VaultError> {
        self.gc_at(self.state.clock().now_secs())
    }

    /// Like [`gc`] but explicit about the "now" boundary — used by tests
    /// that want to verify the TTL math without relying on the wrapped
    /// clock.
    pub fn gc_at(&self, now: i64) -> Result<usize, VaultError> {
        let conn = self.state.lock_conn()?;
        let n = conn
            .execute(
                "DELETE FROM sync_tombstones WHERE expires_at <= ?1",
                params![now],
            )
            .map_err(|e| VaultError::SyncState {
                msg: format!("sqlite: {e}"),
            })?;
        Ok(n)
    }

    /// Total live tombstone count (for tests + diagnostics).
    pub fn count(&self) -> Result<usize, VaultError> {
        let conn = self.state.lock_conn()?;
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_tombstones", [], |row| row.get(0))
            .map_err(|e| VaultError::SyncState {
                msg: format!("sqlite: {e}"),
            })?;
        Ok(n as usize)
    }
}
