// #392 — POSIX file storage backing the desktop and dev vault.
//
// Wraps `std::fs::*` calls one-for-one. Resolves rel_paths against the
// vault root by `vault_root.join(rel_path)` and maps `io::Error` kinds
// to the existing `VaultError` taxonomy so the IPC error-shape contract
// is preserved.
//
// PR-A scope reminder: `PosixStorage` is constructed by `open_vault` but
// no commands route through it yet. The exhaustive impl + tests guard
// the surface PR-B will consume.

use super::{DirEntry, FileMeta, VaultStorage};
use crate::error::VaultError;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct PosixStorage {
    vault_root: PathBuf,
    metadata_dir: PathBuf,
}

impl PosixStorage {
    /// Construct a storage rooted at `vault_root`. The vault path must
    /// already be canonicalized — `VaultHandle::parse` is the canonical
    /// entry point and runs `std::fs::canonicalize` for us.
    pub fn new(vault_root: PathBuf) -> Self {
        let metadata_dir = vault_root.join(".vaultcore");
        Self {
            vault_root,
            metadata_dir,
        }
    }

    fn resolve(&self, rel_path: &str) -> PathBuf {
        self.vault_root.join(rel_path)
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
        std::fs::read(self.resolve(rel_path)).map_err(|e| map_io(e, rel_path))
    }

    fn write_file(&self, rel_path: &str, contents: &[u8]) -> Result<(), VaultError> {
        std::fs::write(self.resolve(rel_path), contents).map_err(|e| map_io(e, rel_path))
    }

    fn create_file(&self, rel_path: &str, initial: &[u8]) -> Result<(), VaultError> {
        // Same shape as `write_file` — `std::fs::write` creates-or-truncates,
        // which matches the existing `commands/files.rs::create_file_impl`
        // behavior of failing fast at higher layers when the file already
        // exists. The collision check is the caller's responsibility today
        // and stays that way; this is a faithful one-to-one wrapper.
        std::fs::write(self.resolve(rel_path), initial).map_err(|e| map_io(e, rel_path))
    }

    fn create_dir(&self, rel_path: &str) -> Result<(), VaultError> {
        std::fs::create_dir_all(self.resolve(rel_path)).map_err(|e| map_io(e, rel_path))
    }

    fn delete(&self, rel_path: &str) -> Result<(), VaultError> {
        let p = self.resolve(rel_path);
        let meta = std::fs::metadata(&p).map_err(|e| map_io(e, rel_path))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| map_io(e, rel_path))
        } else {
            std::fs::remove_file(&p).map_err(|e| map_io(e, rel_path))
        }
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), VaultError> {
        std::fs::rename(self.resolve(from), self.resolve(to)).map_err(|e| map_io(e, from))
    }

    fn metadata(&self, rel_path: &str) -> Result<FileMeta, VaultError> {
        let m = std::fs::metadata(self.resolve(rel_path)).map_err(|e| map_io(e, rel_path))?;
        Ok(FileMeta {
            size: m.len(),
            is_dir: m.is_dir(),
        })
    }

    fn list_dir(&self, rel_path: &str) -> Result<Vec<DirEntry>, VaultError> {
        let read = std::fs::read_dir(self.resolve(rel_path)).map_err(|e| map_io(e, rel_path))?;
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
        self.resolve(rel_path).exists()
    }

    fn metadata_path(&self) -> &Path {
        &self.metadata_dir
    }
}
