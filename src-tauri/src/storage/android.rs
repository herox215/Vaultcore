// #392 PR-B — Android `VaultStorage` impl backed by SAF.
//
// Routes all I/O through the Kotlin `PickerPlugin` via Tauri's
// mobile-plugin FFI (`run_mobile_plugin`). Each method is one Binder
// round-trip per path-component plus the actual I/O — typical 5-25ms
// for a 5-deep path. Acceptable for v1; batch API is a UAT-driven
// follow-up.
//
// `validate_rel` runs at every entry so the Kotlin side never sees
// `..` or absolute paths. SAF's tree-URI scope provides defense in
// depth — `walkRel` in PickerPlugin.kt only ever traverses children
// of the original tree URI — but the explicit Rust-side guard means a
// bug in the Kotlin walk can't escape the vault scope.
//
// Tantivy index + bookmarks live in app-private scratch under
// `<getFilesDir()>/vaults/<sha256(uri)[..16]>/`. mmap doesn't work
// over ContentResolver, so this directory is genuine POSIX storage on
// the device — fast for the index, app-private (no SAF prompt).

#![cfg(target_os = "android")]

use super::{validate_rel, DirEntry, FileMeta, VaultStorage};
use crate::commands::picker::android::AndroidPicker;
use crate::error::VaultError;
use base64::Engine;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::plugin::PluginHandle;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Deserialize)]
struct ReadResp {
    #[serde(rename = "contentB64")]
    content_b64: String,
}

#[derive(Deserialize)]
struct MetaResp {
    exists: bool,
    #[serde(rename = "isDir")]
    is_dir: bool,
    size: u64,
}

#[derive(Deserialize)]
struct ListResp {
    entries: Vec<EntryResp>,
}

#[derive(Deserialize)]
struct EntryResp {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

#[derive(Deserialize)]
struct ExistsResp {
    exists: bool,
}

#[derive(Deserialize)]
struct GrantedResp {
    granted: bool,
}

#[derive(Deserialize)]
#[allow(dead_code)] // Kotlin returns {} on success; nothing to inspect.
struct OkResp {}

pub struct AndroidStorage {
    tree_uri: String,
    metadata_dir: PathBuf,
    plugin: PluginHandle<tauri::Wry>,
}

impl AndroidStorage {
    /// Construct a storage rooted at the given SAF tree URI. The URI
    /// must already have a persisted permission grant (caller's job —
    /// `open_vault` checks this before constructing). `app_local_data`
    /// is the result of `app.path().app_local_data_dir()`; the
    /// per-URI scratch dir lives at `<app_local_data>/vaults/<hash>/`.
    pub fn new<R: Runtime>(
        app: &AppHandle<R>,
        tree_uri: String,
        app_local_data: &Path,
    ) -> Result<Self, VaultError> {
        // The PluginHandle is registered in lib.rs at app init; we
        // borrow a clone from the shared AndroidPicker state.
        // Storing R = Wry is acceptable because production app builds
        // are always Wry; tests don't exercise this path.
        let picker = app.state::<AndroidPicker<tauri::Wry>>();
        let plugin = picker.0.clone();

        let hash = sha256_hex(&tree_uri);
        let metadata_dir = app_local_data.join("vaults").join(&hash[..16]);
        std::fs::create_dir_all(&metadata_dir).map_err(VaultError::Io)?;

        Ok(Self {
            tree_uri,
            metadata_dir,
            plugin,
        })
    }

    /// Convenience for `open_vault`'s persisted-permission check. Not
    /// part of the trait surface — only meaningful for ContentUri
    /// vaults.
    pub fn has_persisted_permission<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
    ) -> Result<bool, VaultError> {
        let picker = app.state::<AndroidPicker<tauri::Wry>>();
        let r: GrantedResp = picker
            .0
            .run_mobile_plugin(
                "hasPersistedPermission",
                serde_json::json!({ "uri": uri }),
            )
            .map_err(|e| VaultError::Io(std::io::Error::other(e.to_string())))?;
        Ok(r.granted)
    }

    /// Idempotent: take the persistable read+write grant on a tree
    /// URI. Called from `open_vault` after the picker resolves so the
    /// URI survives app restart. Safe to call on a URI that already
    /// has a grant — the contract is "after this returns Ok, the URI
    /// is granted".
    pub fn take_persistable_uri_permission<R: Runtime>(
        app: &AppHandle<R>,
        uri: &str,
    ) -> Result<(), VaultError> {
        let picker = app.state::<AndroidPicker<tauri::Wry>>();
        let _: OkResp = picker
            .0
            .run_mobile_plugin(
                "takePersistableUriPermission",
                serde_json::json!({ "uri": uri }),
            )
            .map_err(|e| VaultError::Io(std::io::Error::other(e.to_string())))?;
        Ok(())
    }

    fn invoke<T: serde::de::DeserializeOwned>(
        &self,
        cmd: &str,
        payload: serde_json::Value,
        rel_for_err: &str,
    ) -> Result<T, VaultError> {
        self.plugin
            .run_mobile_plugin::<T>(cmd, payload)
            .map_err(|e| VaultError::Io(std::io::Error::other(format!(
                "{cmd}({rel_for_err}): {e}"
            ))))
    }
}

impl VaultStorage for AndroidStorage {
    fn read_file(&self, rel_path: &str) -> Result<Vec<u8>, VaultError> {
        validate_rel(rel_path)?;
        let r: ReadResp = self.invoke(
            "readFile",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
            }),
            rel_path,
        )?;
        base64::engine::general_purpose::STANDARD
            .decode(&r.content_b64)
            .map_err(|e| VaultError::Io(std::io::Error::other(format!(
                "base64 decode failed for {rel_path}: {e}"
            ))))
    }

    fn write_file(&self, rel_path: &str, contents: &[u8]) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(contents);
        let _: OkResp = self.invoke(
            "writeFile",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
                "contentB64": b64,
            }),
            rel_path,
        )?;
        Ok(())
    }

    fn create_file(&self, rel_path: &str, initial: &[u8]) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(initial);
        let _: OkResp = self.invoke(
            "createFile",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
                "contentB64": b64,
            }),
            rel_path,
        )?;
        Ok(())
    }

    fn create_dir(&self, rel_path: &str) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let _: OkResp = self.invoke(
            "createDir",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
            }),
            rel_path,
        )?;
        Ok(())
    }

    fn delete(&self, rel_path: &str) -> Result<(), VaultError> {
        validate_rel(rel_path)?;
        let _: OkResp = self.invoke(
            "deletePath",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
            }),
            rel_path,
        )?;
        Ok(())
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), VaultError> {
        validate_rel(from)?;
        validate_rel(to)?;
        let _: OkResp = self.invoke(
            "renamePath",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "fromRel": from,
                "toRel": to,
            }),
            from,
        )?;
        Ok(())
    }

    fn metadata(&self, rel_path: &str) -> Result<FileMeta, VaultError> {
        validate_rel(rel_path)?;
        let r: MetaResp = self.invoke(
            "metadata",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
            }),
            rel_path,
        )?;
        if !r.exists {
            return Err(VaultError::FileNotFound {
                path: rel_path.to_string(),
            });
        }
        Ok(FileMeta {
            size: r.size,
            is_dir: r.is_dir,
        })
    }

    fn list_dir(&self, rel_path: &str) -> Result<Vec<DirEntry>, VaultError> {
        validate_rel(rel_path)?;
        let r: ListResp = self.invoke(
            "listDir",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
            }),
            rel_path,
        )?;
        Ok(r.entries
            .into_iter()
            .map(|e| DirEntry {
                name: e.name,
                is_dir: e.is_dir,
            })
            .collect())
    }

    fn exists(&self, rel_path: &str) -> bool {
        if validate_rel(rel_path).is_err() {
            return false;
        }
        let r: Result<ExistsResp, VaultError> = self.invoke(
            "pathExists",
            serde_json::json!({
                "treeUri": &self.tree_uri,
                "relPath": rel_path,
            }),
            rel_path,
        );
        r.map(|x| x.exists).unwrap_or(false)
    }

    fn metadata_path(&self) -> &Path {
        &self.metadata_dir
    }
}

/// Stable per-URI hex hash for the app-private scratch directory.
/// 16 hex chars (= 64 bits of SHA-256) gives ~10^19 namespace; collision
/// probability for any realistic vault count is astronomically low. Use
/// the hex form rather than base64 for filename compatibility — `+` and
/// `/` would need escaping in path segments.
fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let bytes = h.finalize();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod sha_tests {
    use super::*;

    #[test]
    fn sha256_hex_is_deterministic() {
        let uri = "content://com.android.externalstorage.documents/tree/primary%3AVault";
        assert_eq!(sha256_hex(uri), sha256_hex(uri));
    }

    #[test]
    fn sha256_hex_differs_for_different_inputs() {
        let a = sha256_hex("content://provider/tree/A");
        let b = sha256_hex("content://provider/tree/B");
        assert_ne!(a, b);
    }

    #[test]
    fn sha256_hex_first_16_are_filename_safe() {
        let h = sha256_hex("anything");
        let prefix = &h[..16];
        assert!(prefix.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
