// #391 — Document Picker IPC abstraction.
//
// Two `#[tauri::command]`s, each cfg-branched between the desktop dialog
// (`tauri-plugin-dialog`'s NSOpenPanel / GTK file chooser flow) and the
// Android Storage Access Framework intents (`ACTION_OPEN_DOCUMENT_TREE`,
// `ACTION_CREATE_DOCUMENT`).
//
// The frontend is platform-agnostic: it always invokes `pick_vault_folder`
// or `pick_save_path` and treats the returned string as an opaque vault
// handle. On desktop that's a POSIX path; on Android it's a `content://`
// URI. The vault-storage layer (#392) consumes the URI opaquely.
//
// Cancellation is uniformly `Ok(None)` — never an `Err`. Genuine failures
// (channel closed, mobile-plugin bridge deserialize failure) surface as
// `VaultError::PickerFailed { msg }`.

use crate::error::VaultError;
use serde::Deserialize;
use tauri::AppHandle;

/// Mirrors `tauri_plugin_dialog::Filter` (which is `pub(crate)` and so
/// cannot be re-exported). The shape matches the JS-side filter object
/// `{ name: string; extensions: string[] }` already passed by today's
/// `pickSavePath` callers (HTML export, decrypted-export). Forwarded
/// into the dialog builder's `add_filter(name, &extensions)`.
#[derive(Debug, Deserialize)]
pub struct PickerFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub async fn pick_vault_folder(app: AppHandle) -> Result<Option<String>, VaultError> {
    pick_folder_impl(&app).await
}

#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    default_name: String,
    filters: Vec<PickerFilter>,
) -> Result<Option<String>, VaultError> {
    pick_save_path_impl(&app, default_name, filters).await
}

// ── Desktop branch (macOS / Windows / Linux) ────────────────────────────────

#[cfg(not(target_os = "android"))]
async fn pick_folder_impl(app: &AppHandle) -> Result<Option<String>, VaultError> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Open vault")
        .pick_folder(move |fp| {
            // Best-effort send. The receiver always exists (we own it on
            // this same async task), so this only fails if the runtime is
            // tearing down — at which point the picker result is moot.
            let _ = tx.send(fp);
        });
    let picked = rx.await.map_err(|_| VaultError::PickerFailed {
        msg: "picker channel closed".into(),
    })?;
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .and_then(|p| p.to_str().map(String::from)))
}

#[cfg(not(target_os = "android"))]
async fn pick_save_path_impl(
    app: &AppHandle,
    default_name: String,
    filters: Vec<PickerFilter>,
) -> Result<Option<String>, VaultError> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_file_name(default_name);
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&f.name, &exts);
    }
    builder.save_file(move |fp| {
        let _ = tx.send(fp);
    });
    let picked = rx.await.map_err(|_| VaultError::PickerFailed {
        msg: "picker channel closed".into(),
    })?;
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .and_then(|p| p.to_str().map(String::from)))
}

// ── Android branch ──────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
pub mod android {
    use super::{PickerFilter, VaultError};
    use serde::Deserialize;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    /// Tauri's reverse-DNS plugin identifier convention; mirrors
    /// `app.tauri.dialog` from the bundled dialog plugin.
    const PLUGIN_IDENTIFIER: &str = "app.vaultcore.picker";

    #[derive(Deserialize)]
    struct PickerResponse {
        uri: Option<String>,
    }

    /// Wrapper around the PluginHandle for the Kotlin `PickerPlugin`
    /// class. Stored in Tauri's `app.state()` so #392 PR-B's
    /// `AndroidStorage` and the existing #391 picker commands share a
    /// single registered plugin instance — `register_android_plugin`
    /// is idempotent per-name but allocating two plugins for the same
    /// Kotlin class is wasted JVM-side work.
    pub struct AndroidPicker<R: Runtime>(pub PluginHandle<R>);

    /// Registers the Kotlin `PickerPlugin` class on the JVM classpath as
    /// the Tauri mobile plugin handle. Called from `lib.rs` next to the
    /// existing `tauri_plugin_dialog::init()` registration, gated to
    /// `#[cfg(target_os = "android")]`.
    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("vaultcore-picker")
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "PickerPlugin")?;
                app.manage(AndroidPicker(handle));
                Ok(())
            })
            .build()
    }

    pub async fn pick_folder<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, VaultError> {
        let picker = app.state::<AndroidPicker<R>>();
        let r: PickerResponse = picker
            .0
            .run_mobile_plugin("pickDirectoryTree", serde_json::json!({}))
            .map_err(|e| VaultError::PickerFailed { msg: e.to_string() })?;
        Ok(r.uri)
    }

    pub async fn pick_save_path<R: Runtime>(
        app: &AppHandle<R>,
        default_name: String,
        // Filters drop on Android: `ACTION_CREATE_DOCUMENT` accepts a
        // single MIME type, and the JS callers supply category-name +
        // extension lists tuned for the desktop NSOpenPanel UX. The
        // Kotlin side hardcodes `application/octet-stream` for v1; a
        // per-extension MIME hint is a follow-up if UX requires it.
        _filters: Vec<PickerFilter>,
    ) -> Result<Option<String>, VaultError> {
        let picker = app.state::<AndroidPicker<R>>();
        let r: PickerResponse = picker
            .0
            .run_mobile_plugin(
                "pickSavePath",
                serde_json::json!({ "defaultName": default_name }),
            )
            .map_err(|e| VaultError::PickerFailed { msg: e.to_string() })?;
        Ok(r.uri)
    }
}

#[cfg(target_os = "android")]
async fn pick_folder_impl(app: &AppHandle) -> Result<Option<String>, VaultError> {
    android::pick_folder(app).await
}

#[cfg(target_os = "android")]
async fn pick_save_path_impl(
    app: &AppHandle,
    default_name: String,
    filters: Vec<PickerFilter>,
) -> Result<Option<String>, VaultError> {
    android::pick_save_path(app, default_name, filters).await
}

#[cfg(target_os = "android")]
pub fn android_init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    android::init()
}
