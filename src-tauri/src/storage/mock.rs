// #392 PR-B — in-memory `VaultStorage` impl for host-side tests.
//
// AndroidStorage's real I/O routes through the Tauri mobile-plugin
// FFI (`run_mobile_plugin`), which can't be exercised from a host
// build. MockAndroidStorage gives us a behavior-equivalent surface
// to verify error mapping + validate_rel integration without an
// emulator. Tests in `tests/storage_mock.rs` use it to lock in the
// per-method validate_rel behavior; PR-B's AndroidStorage delegates
// to the same `validate_rel` so the mock is a faithful proxy.

#![cfg(test)]

use super::{validate_rel, DirEntry, FileMeta, VaultStorage};
use crate::error::VaultError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug)]
pub struct MockAndroidStorage {
    files: Mutex<HashMap<String, Vec<u8>>>,
    dirs: Mutex<std::collections::HashSet<String>>,
    metadata_dir: PathBuf,
}

impl MockAndroidStorage {
    pub fn new(metadata_dir: PathBuf) -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
            dirs: Mutex::new(std::collections::HashSet::new()),
            metadata_dir,
        }
    }
}

impl VaultStorage for MockAndroidStorage {
    fn read_file(&self, rel_path: &str) -> Result<Vec<u8>, VaultError> {
        validate_rel(rel_path)?;
        let files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        files
            .get(rel_path)
            .cloned()
            .ok_or_else(|| VaultError::FileNotFound {
                path: rel_path.to_string(),
            })
    }

    fn write_file(&self, rel_path: &str, contents: &[u8]) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let mut files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        files.insert(rel_path.to_string(), contents.to_vec());
        Ok(())
    }

    fn create_file(&self, rel_path: &str, initial: &[u8]) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let mut files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        files.insert(rel_path.to_string(), initial.to_vec());
        Ok(())
    }

    fn create_dir(&self, rel_path: &str) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let mut dirs = self.dirs.lock().map_err(|_| VaultError::LockPoisoned)?;
        dirs.insert(rel_path.to_string());
        Ok(())
    }

    fn delete(&self, rel_path: &str) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let mut files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        let mut dirs = self.dirs.lock().map_err(|_| VaultError::LockPoisoned)?;
        let removed_file = files.remove(rel_path).is_some();
        let removed_dir = dirs.remove(rel_path);
        // Recursive: remove any file/dir under the deleted prefix.
        let prefix = format!("{rel_path}/");
        files.retain(|k, _| !k.starts_with(&prefix));
        dirs.retain(|k| !k.starts_with(&prefix));
        if removed_file || removed_dir {
            Ok(())
        } else {
            Err(VaultError::FileNotFound {
                path: rel_path.to_string(),
            })
        }
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), VaultError> {
        validate_rel(from)?;
        validate_rel(to)?;
        let mut files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        let bytes = files.remove(from).ok_or_else(|| VaultError::FileNotFound {
            path: from.to_string(),
        })?;
        files.insert(to.to_string(), bytes);
        Ok(())
    }

    fn metadata(&self, rel_path: &str) -> Result<FileMeta, VaultError> {
        validate_rel(rel_path)?;
        let files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        let dirs = self.dirs.lock().map_err(|_| VaultError::LockPoisoned)?;
        if let Some(b) = files.get(rel_path) {
            return Ok(FileMeta {
                size: b.len() as u64,
                is_dir: false,
            });
        }
        if dirs.contains(rel_path) {
            return Ok(FileMeta {
                size: 0,
                is_dir: true,
            });
        }
        Err(VaultError::FileNotFound {
            path: rel_path.to_string(),
        })
    }

    fn list_dir(&self, rel_path: &str) -> Result<Vec<DirEntry>, VaultError> {
        validate_rel(rel_path)?;
        let files = self.files.lock().map_err(|_| VaultError::LockPoisoned)?;
        let dirs = self.dirs.lock().map_err(|_| VaultError::LockPoisoned)?;
        let prefix = if rel_path.is_empty() {
            String::new()
        } else {
            format!("{rel_path}/")
        };
        let mut out: Vec<DirEntry> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for k in files.keys() {
            if let Some(rest) = k.strip_prefix(&prefix) {
                if let Some(name) = rest.split('/').next() {
                    if seen.insert(name.to_string()) {
                        let is_dir = rest.contains('/');
                        out.push(DirEntry {
                            name: name.to_string(),
                            is_dir,
                        });
                    }
                }
            }
        }
        for k in dirs.iter() {
            if let Some(rest) = k.strip_prefix(&prefix) {
                if let Some(name) = rest.split('/').next() {
                    if seen.insert(name.to_string()) {
                        out.push(DirEntry {
                            name: name.to_string(),
                            is_dir: true,
                        });
                    }
                }
            }
        }
        Ok(out)
    }

    fn exists(&self, rel_path: &str) -> bool {
        if validate_rel(rel_path).is_err() {
            return false;
        }
        let files = self.files.lock().map(|f| f.contains_key(rel_path)).unwrap_or(false);
        let dirs = self.dirs.lock().map(|d| d.contains(rel_path)).unwrap_or(false);
        files || dirs
    }

    fn metadata_path(&self) -> &Path {
        &self.metadata_dir
    }
}
