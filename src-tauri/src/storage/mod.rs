// #392 — vault storage abstraction.
//
// PR-A (this slice): introduces `VaultHandle` and the `VaultStorage` trait
// + `PosixStorage` impl as scaffolding. The trait sits in `VaultState.storage`
// but no commands route through it yet — the migration is mechanical and
// behavior-identical to pre-#392 desktop. PR-B routes `commands/files.rs`
// through the trait, adds `AndroidStorage`, and changes `metadata_path()`
// to return per-platform locations.

pub mod handle;
pub mod posix;

pub use handle::VaultHandle;
pub use posix::PosixStorage;

use crate::error::VaultError;
use std::path::Path;

/// File metadata returned by [`VaultStorage::metadata`].
#[derive(Debug, Clone)]
pub struct FileMeta {
    pub size: u64,
    pub is_dir: bool,
}

/// Directory entry returned by [`VaultStorage::list_dir`].
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Cross-platform vault I/O. Desktop impl wraps `std::fs::*`; PR-B's
/// Android impl routes through `ContentResolver` via the `PickerPlugin`
/// JNI bridge.
///
/// All paths are vault-relative — the storage impl resolves them
/// against the vault root it owns. This intentionally inverts today's
/// `commands/files.rs` flow which works in canonical absolute paths;
/// rel-path-based commands are PR-B's job. PR-A's `PosixStorage` is
/// fully implemented but unused so PR-B has a stable surface to plug
/// `AndroidStorage` into without re-writing the trait.
pub trait VaultStorage: Send + Sync {
    fn read_file(&self, rel_path: &str) -> Result<Vec<u8>, VaultError>;
    fn write_file(&self, rel_path: &str, contents: &[u8]) -> Result<(), VaultError>;
    fn create_file(&self, rel_path: &str, initial: &[u8]) -> Result<(), VaultError>;
    fn create_dir(&self, rel_path: &str) -> Result<(), VaultError>;
    fn delete(&self, rel_path: &str) -> Result<(), VaultError>;
    fn rename(&self, from: &str, to: &str) -> Result<(), VaultError>;
    fn metadata(&self, rel_path: &str) -> Result<FileMeta, VaultError>;
    fn list_dir(&self, rel_path: &str) -> Result<Vec<DirEntry>, VaultError>;
    fn exists(&self, rel_path: &str) -> bool;

    /// Where Tantivy + bookmarks + other vault metadata lives. Desktop
    /// returns `<vault>/.vaultcore` so behavior is bit-identical to the
    /// pre-#392 hard-coded path. PR-B's Android impl returns app-private
    /// scratch under `<getFilesDir()>/vaults/<uri_hash>/` because mmap
    /// (Tantivy's storage backend) does not work over `ContentResolver`.
    fn metadata_path(&self) -> &Path;
}
