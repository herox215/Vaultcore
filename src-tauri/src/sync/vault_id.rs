//! Per-vault UUIDv4 stored at `<vault>/.vaultcore/vault-id` (epic #73).
//!
//! Generated on first call, then read verbatim on every subsequent call —
//! the vault-id outlives any single sync peering, so it must persist
//! across launches without rotation.

use std::fs;
use std::path::Path;

use uuid::Uuid;

use crate::error::VaultError;

const VAULT_ID_FILENAME: &str = "vault-id";

/// Read `vault-id`, or generate + write a fresh UUIDv4 if missing.
/// Returns the canonical hyphenated string.
///
/// `metadata_dir` is the path returned by `VaultStorage::metadata_path()`
/// (i.e. `<vault>/.vaultcore`). The caller is expected to have already
/// ensured it exists; this function will `create_dir_all` defensively.
pub fn load_or_create(metadata_dir: &Path) -> Result<String, VaultError> {
    fs::create_dir_all(metadata_dir).map_err(VaultError::Io)?;
    let path = metadata_dir.join(VAULT_ID_FILENAME);
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(VaultError::Io)?;
        let trimmed = raw.trim().to_string();
        // Defensive: only accept well-formed UUIDs. A corrupt file should
        // surface as an error, never as silent regeneration — that would
        // re-pair with peers under a different identity.
        Uuid::parse_str(&trimmed).map_err(|e| VaultError::SyncState {
            msg: format!("vault-id at {} is not a valid UUID: {e}", path.display()),
        })?;
        return Ok(trimmed);
    }
    let id = Uuid::new_v4().to_string();
    fs::write(&path, &id).map_err(VaultError::Io)?;
    Ok(id)
}
