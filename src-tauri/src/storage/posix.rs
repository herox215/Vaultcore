// #392 — POSIX file storage backing the desktop and dev vault.
//
// Wraps `std::fs::*` calls and routes every rel_path through a T-02
// path-traversal guard before touching the filesystem. The guard mirrors
// the semantics of the existing `commands/files.rs::ensure_inside_vault`:
// the resolved canonical path must sit under the canonical vault root.
// `vault_root.join("../../etc/passwd")` returns `PathOutsideVault`.
//
// Two resolution modes:
// - `resolve_existing(rel)`: canonicalizes the full path. Used by ops
//   that REQUIRE the target to exist (read, list_dir, metadata, delete).
//   Returns `FileNotFound` if `canonicalize` errors with NotFound.
// - `resolve_for_write(rel)`: canonicalizes the parent (which MUST
//   exist) then joins the file_name. Used by ops that may target a
//   not-yet-existent leaf (write_file, create_file, create_dir, rename
//   destination). The guard runs against the canonical parent, ruling
//   out `../escape/file` while permitting `subdir/new.md`.
//
// Errors:
// - `PathOutsideVault` for actual T-02 violations (canonical resolves
//   outside the vault). Distinct from `PermissionDenied`, which is OS
//   access refusal.
// - Existing `VaultError` taxonomy preserved for IO mapping (NotFound,
//   PermissionDenied, StorageFull → DiskFull).

use super::{DirEntry, FileMeta, VaultStorage};
use crate::error::VaultError;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct PosixStorage {
    /// Canonical vault root, cached at construction so the per-call
    /// `starts_with` check doesn't re-canonicalize on every I/O.
    vault_root: PathBuf,
    metadata_dir: PathBuf,
}

impl PosixStorage {
    /// Construct a storage rooted at `vault_root`. The vault path must
    /// already be canonicalized — `VaultHandle::parse` is the canonical
    /// entry point and runs `std::fs::canonicalize` for us. The cached
    /// canonical root powers the per-call T-02 guard below.
    pub fn new(vault_root: PathBuf) -> Self {
        let metadata_dir = vault_root.join(".vaultcore");
        Self {
            vault_root,
            metadata_dir,
        }
    }

    /// T-02 guard for ops on existing paths. Canonicalizes the full
    /// joined path and confirms it sits under the canonical vault root.
    /// Returns `FileNotFound` if the path doesn't exist (matches the
    /// pre-#392 `read_file` error shape via `map_io(NotFound, _)`).
    fn resolve_existing(&self, rel_path: &str) -> Result<PathBuf, VaultError> {
        let joined = self.vault_root.join(rel_path);
        let canonical = std::fs::canonicalize(&joined).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::FileNotFound {
                path: rel_path.to_string(),
            },
            std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
                path: rel_path.to_string(),
            },
            _ => VaultError::Io(e),
        })?;
        if !canonical.starts_with(&self.vault_root) {
            return Err(VaultError::PathOutsideVault {
                path: rel_path.to_string(),
            });
        }
        Ok(canonical)
    }

    /// T-02 guard for ops whose target may not exist yet. Canonicalizes
    /// the *parent* (which MUST exist), confirms it sits under the vault
    /// root, then joins the file_name. Mirrors the parent-canonicalize
    /// pattern in `commands/files.rs::write_file`.
    fn resolve_for_write(&self, rel_path: &str) -> Result<PathBuf, VaultError> {
        let joined = self.vault_root.join(rel_path);
        let parent = joined.parent().ok_or_else(|| VaultError::PathOutsideVault {
            path: rel_path.to_string(),
        })?;
        let file_name = joined.file_name().ok_or_else(|| VaultError::PathOutsideVault {
            path: rel_path.to_string(),
        })?;
        let canonical_parent = std::fs::canonicalize(parent).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::FileNotFound {
                path: rel_path.to_string(),
            },
            std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
                path: rel_path.to_string(),
            },
            _ => VaultError::Io(e),
        })?;
        if !canonical_parent.starts_with(&self.vault_root) {
            return Err(VaultError::PathOutsideVault {
                path: rel_path.to_string(),
            });
        }
        Ok(canonical_parent.join(file_name))
    }

    /// Variant of `resolve_for_write` for `create_dir_all`, which can
    /// create missing intermediate components — so neither the leaf nor
    /// any of its ancestors necessarily exists. The guard walks UP from
    /// `joined` until it finds an existing ancestor, canonicalizes that,
    /// and ensures it sits inside `vault_root`. This rules out
    /// `vault_root.join("../sibling/foo")` because the first existing
    /// ancestor is the parent's parent (or higher), which canonicalizes
    /// outside the vault.
    fn resolve_for_create_dir(&self, rel_path: &str) -> Result<PathBuf, VaultError> {
        let joined = self.vault_root.join(rel_path);
        // Find the first existing ancestor and canonicalize it.
        let mut probe: &Path = joined.as_path();
        let canonical_anchor = loop {
            match std::fs::canonicalize(probe) {
                Ok(c) => break c,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    probe = probe
                        .parent()
                        .ok_or_else(|| VaultError::PathOutsideVault {
                            path: rel_path.to_string(),
                        })?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Err(VaultError::PermissionDenied {
                        path: rel_path.to_string(),
                    });
                }
                Err(e) => return Err(VaultError::Io(e)),
            }
        };
        if !canonical_anchor.starts_with(&self.vault_root) {
            return Err(VaultError::PathOutsideVault {
                path: rel_path.to_string(),
            });
        }
        Ok(joined)
    }
}

fn map_io(e: std::io::Error, path: &str) -> VaultError {
    match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound {
            path: path.to_string(),
        },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
            path: path.to_string(),
        },
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    }
}

impl VaultStorage for PosixStorage {
    fn read_file(&self, rel_path: &str) -> Result<Vec<u8>, VaultError> {
        let p = self.resolve_existing(rel_path)?;
        std::fs::read(p).map_err(|e| map_io(e, rel_path))
    }

    fn write_file(&self, rel_path: &str, contents: &[u8]) -> Result<(), VaultError> {
        let p = self.resolve_for_write(rel_path)?;
        std::fs::write(p, contents).map_err(|e| map_io(e, rel_path))
    }

    fn create_file(&self, rel_path: &str, initial: &[u8]) -> Result<(), VaultError> {
        // Same shape as `write_file` — `std::fs::write` creates-or-truncates,
        // which matches the existing `commands/files.rs::create_file_impl`
        // behavior of failing fast at higher layers when the file already
        // exists. The collision check is the caller's responsibility today
        // and stays that way; this is a faithful one-to-one wrapper.
        let p = self.resolve_for_write(rel_path)?;
        std::fs::write(p, initial).map_err(|e| map_io(e, rel_path))
    }

    fn create_dir(&self, rel_path: &str) -> Result<(), VaultError> {
        let p = self.resolve_for_create_dir(rel_path)?;
        std::fs::create_dir_all(p).map_err(|e| map_io(e, rel_path))
    }

    fn delete(&self, rel_path: &str) -> Result<(), VaultError> {
        let p = self.resolve_existing(rel_path)?;
        let meta = std::fs::metadata(&p).map_err(|e| map_io(e, rel_path))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| map_io(e, rel_path))
        } else {
            std::fs::remove_file(&p).map_err(|e| map_io(e, rel_path))
        }
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), VaultError> {
        let from_p = self.resolve_existing(from)?;
        let to_p = self.resolve_for_write(to)?;
        std::fs::rename(from_p, to_p).map_err(|e| map_io(e, from))
    }

    fn metadata(&self, rel_path: &str) -> Result<FileMeta, VaultError> {
        let p = self.resolve_existing(rel_path)?;
        let m = std::fs::metadata(p).map_err(|e| map_io(e, rel_path))?;
        Ok(FileMeta {
            size: m.len(),
            is_dir: m.is_dir(),
        })
    }

    fn list_dir(&self, rel_path: &str) -> Result<Vec<DirEntry>, VaultError> {
        // `list_dir("")` is the legitimate "list the vault root" call —
        // `resolve_existing("")` canonicalizes `vault_root.join("")` =
        // `vault_root` itself, which passes the guard.
        let p = self.resolve_existing(rel_path)?;
        let read = std::fs::read_dir(p).map_err(|e| map_io(e, rel_path))?;
        let mut out = Vec::new();
        for entry in read {
            let entry = entry.map_err(|e| map_io(e, rel_path))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            out.push(DirEntry { name, is_dir });
        }
        Ok(out)
    }

    fn exists(&self, rel_path: &str) -> bool {
        // T-02: `exists` returns `false` for paths that resolve outside
        // the vault. `Path::exists()` already returns `false` for
        // unreadable paths, so widening to "false on guard violation"
        // matches the existing semantic.
        self.resolve_existing(rel_path).is_ok()
    }

    fn metadata_path(&self) -> &Path {
        &self.metadata_dir
    }
}
