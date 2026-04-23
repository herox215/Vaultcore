// Per-vault manifest of encrypted folders.
//
// Lives at `<vault>/.vaultcore/encrypted-folders.json` — matches the
// existing per-vault sidecar convention used by bookmarks/snippets and
// survives vault moves (unlike an app-data-keyed sidecar).
//
// Schema (versioned wrapper):
//   { "schemaVersion": 1, "entries": [{ path, createdAt, salt, state }, …] }
// - schemaVersion: integer. Every reader validates. Newer minor fields
//                  on existing shape coexist without a bump. Shape
//                  changes require a bump + migration path.
// - path:          forward-slash vault-relative path (platform-stable).
// - createdAt:     ISO-8601 UTC timestamp of the encrypt operation.
// - salt:          base64-encoded 16-byte Argon2id salt (per-folder).
// - state:         "encrypting" | "encrypted". "encrypting" means a
//                  batch was interrupted and the folder may contain a
//                  mix of plain + ciphertext files — resume flow is
//                  PR 345.3.
//
// Backwards compatibility: the reader also accepts the bare-array legacy
// shape (no entries were ever shipped with it — this is defensive, in
// case a dev build landed without the wrapper) so a silent parse break
// never happens in the wild.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::encryption::crypto::SALT_LEN;
use crate::error::VaultError;

pub const SIDECAR_DIR: &str = ".vaultcore";
pub const MANIFEST_FILENAME: &str = "encrypted-folders.json";
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub entries: Vec<EncryptedFolderMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedFolderMeta {
    pub path: String,
    pub created_at: String,
    /// Never surfaced to the frontend — `list_encrypted_folders` returns
    /// a stripped view.
    pub salt: String,
    pub state: FolderState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderState {
    Encrypting,
    Encrypted,
}

impl EncryptedFolderMeta {
    pub fn salt_bytes(&self) -> Result<[u8; SALT_LEN], VaultError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&self.salt)
            .map_err(|e| VaultError::CryptoError {
                msg: format!("invalid salt encoding in manifest: {e}"),
            })?;
        if bytes.len() != SALT_LEN {
            return Err(VaultError::CryptoError {
                msg: format!("salt length {} != {}", bytes.len(), SALT_LEN),
            });
        }
        let mut arr = [0u8; SALT_LEN];
        arr.copy_from_slice(&bytes);
        Ok(arr)
    }

    pub fn encode_salt(salt: &[u8; SALT_LEN]) -> String {
        base64::engine::general_purpose::STANDARD.encode(salt)
    }
}

fn manifest_path(vault_root: &Path) -> PathBuf {
    vault_root.join(SIDECAR_DIR).join(MANIFEST_FILENAME)
}

pub fn read_manifest(vault_root: &Path) -> Result<Vec<EncryptedFolderMeta>, VaultError> {
    let p = manifest_path(vault_root);
    match std::fs::read_to_string(&p) {
        Ok(s) => {
            if s.trim().is_empty() {
                return Ok(Vec::new());
            }
            // Try the versioned wrapper first; fall back to bare array
            // for defensive forward-compat with any dev build that
            // shipped without the wrapper.
            if let Ok(m) = serde_json::from_str::<Manifest>(&s) {
                if m.schema_version > CURRENT_SCHEMA_VERSION {
                    return Err(VaultError::CryptoError {
                        msg: format!(
                            "manifest schemaVersion {} newer than supported {}; upgrade required",
                            m.schema_version, CURRENT_SCHEMA_VERSION
                        ),
                    });
                }
                return Ok(m.entries);
            }
            serde_json::from_str::<Vec<EncryptedFolderMeta>>(&s).map_err(|e| {
                VaultError::CryptoError {
                    msg: format!("manifest parse error: {e}"),
                }
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(VaultError::Io(e)),
    }
}

pub fn write_manifest(
    vault_root: &Path,
    entries: &[EncryptedFolderMeta],
) -> Result<(), VaultError> {
    let dir = vault_root.join(SIDECAR_DIR);
    std::fs::create_dir_all(&dir).map_err(VaultError::Io)?;
    let p = manifest_path(vault_root);
    let wrapper = Manifest {
        schema_version: CURRENT_SCHEMA_VERSION,
        entries: entries.to_vec(),
    };
    let json = serde_json::to_string_pretty(&wrapper).map_err(|e| VaultError::CryptoError {
        msg: format!("manifest serialize error: {e}"),
    })?;
    std::fs::write(&p, json).map_err(VaultError::Io)?;
    Ok(())
}

/// Insert-or-replace `meta` by path (vault-relative, forward-slash).
pub fn upsert(
    vault_root: &Path,
    meta: EncryptedFolderMeta,
) -> Result<Vec<EncryptedFolderMeta>, VaultError> {
    let mut entries = read_manifest(vault_root)?;
    if let Some(existing) = entries.iter_mut().find(|e| e.path == meta.path) {
        *existing = meta;
    } else {
        entries.push(meta);
    }
    write_manifest(vault_root, &entries)?;
    Ok(entries)
}

/// Convert a canonical absolute path inside the vault into the
/// forward-slash vault-relative form used in manifest entries.
pub fn rel_path(vault_root: &Path, abs: &Path) -> Result<String, VaultError> {
    let rel = abs.strip_prefix(vault_root).map_err(|_| {
        VaultError::PermissionDenied {
            path: abs.display().to_string(),
        }
    })?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::crypto::random_salt;

    #[test]
    fn absent_manifest_is_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let entries = read_manifest(dir.path()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let salt = random_salt();
        let meta = EncryptedFolderMeta {
            path: "secret".into(),
            created_at: "2026-04-23T00:00:00Z".into(),
            salt: EncryptedFolderMeta::encode_salt(&salt),
            state: FolderState::Encrypted,
        };
        write_manifest(dir.path(), &[meta.clone()]).unwrap();
        let back = read_manifest(dir.path()).unwrap();
        assert_eq!(back, vec![meta]);
    }

    #[test]
    fn upsert_replaces_existing_and_appends_new() {
        let dir = tempfile::tempdir().unwrap();
        let salt_a = random_salt();
        let meta_a = EncryptedFolderMeta {
            path: "secret".into(),
            created_at: "2026-04-23T00:00:00Z".into(),
            salt: EncryptedFolderMeta::encode_salt(&salt_a),
            state: FolderState::Encrypting,
        };
        upsert(dir.path(), meta_a.clone()).unwrap();
        // Replace state.
        let meta_a2 = EncryptedFolderMeta {
            state: FolderState::Encrypted,
            ..meta_a
        };
        upsert(dir.path(), meta_a2.clone()).unwrap();
        // Append new entry.
        let salt_b = random_salt();
        let meta_b = EncryptedFolderMeta {
            path: "journal".into(),
            created_at: "2026-04-23T00:00:01Z".into(),
            salt: EncryptedFolderMeta::encode_salt(&salt_b),
            state: FolderState::Encrypted,
        };
        upsert(dir.path(), meta_b.clone()).unwrap();

        let back = read_manifest(dir.path()).unwrap();
        assert_eq!(back.len(), 2);
        assert!(back.iter().any(|m| m == &meta_a2));
        assert!(back.iter().any(|m| m == &meta_b));
    }

    #[test]
    fn salt_roundtrip_via_base64() {
        let salt = random_salt();
        let enc = EncryptedFolderMeta::encode_salt(&salt);
        let meta = EncryptedFolderMeta {
            path: "x".into(),
            created_at: "t".into(),
            salt: enc,
            state: FolderState::Encrypted,
        };
        assert_eq!(meta.salt_bytes().unwrap(), salt);
    }

    #[test]
    fn write_produces_versioned_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), &[]).unwrap();
        let json = std::fs::read_to_string(
            dir.path().join(SIDECAR_DIR).join(MANIFEST_FILENAME),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["schemaVersion"], CURRENT_SCHEMA_VERSION);
        assert!(parsed["entries"].is_array());
    }

    #[test]
    fn read_accepts_bare_array_legacy_shape() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(SIDECAR_DIR)).unwrap();
        let p = dir.path().join(SIDECAR_DIR).join(MANIFEST_FILENAME);
        std::fs::write(
            &p,
            r#"[{"path":"a","createdAt":"t","salt":"AAAAAAAAAAAAAAAAAAAAAA==","state":"encrypted"}]"#,
        )
        .unwrap();
        let back = read_manifest(dir.path()).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].path, "a");
    }

    #[test]
    fn read_rejects_newer_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(SIDECAR_DIR)).unwrap();
        let p = dir.path().join(SIDECAR_DIR).join(MANIFEST_FILENAME);
        std::fs::write(&p, r#"{"schemaVersion":999,"entries":[]}"#).unwrap();
        let err = read_manifest(dir.path()).unwrap_err();
        match err {
            VaultError::CryptoError { msg } => assert!(msg.contains("999")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn rel_path_normalizes_separators() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("secret/sub")).unwrap();
        let abs = root.join("secret").join("sub");
        let rel = rel_path(&root, &abs).unwrap();
        assert_eq!(rel, "secret/sub");
    }
}
