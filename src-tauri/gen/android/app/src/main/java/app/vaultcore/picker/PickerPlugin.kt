// #391 — Tauri mobile plugin for VaultCore's vault folder + save-as picker.
//
// Placement note: this file lives directly in `gen/android/...` and NOT
// in a `src-tauri/android/` overlay directory. As of Tauri 2.10 the
// overlay convention is silently ignored at build time — verified via
// `dexdump` on a build that placed the file in the overlay path: the
// resulting APK's `classes*.dex` did not contain `Lcom/vaultcore/app/
// PickerPlugin;`. The `gen/android/` placement empirically survives a
// `tauri android init` re-run in this Tauri version. If a future Tauri
// version changes init behavior this file may need re-applying after
// init. See `docs/MOBILE_BUILD.md` → "Custom Android plugins".
//
// Two commands exposed to the Rust side via Tauri's mobile-plugin FFI:
//
//   - pickDirectoryTree: fires `Intent.ACTION_OPEN_DOCUMENT_TREE` and
//     resolves with the resulting `content://...tree/...` URI. The
//     persistable-permission flag is set on the intent so #392 can call
//     `takePersistableUriPermission` later when the bookmark layer
//     exists. We deliberately do NOT call `takePersistableUriPermission`
//     here — without a place to store the URI, the grant would just
//     churn the system's grant table.
//
//   - pickSavePath: fires `Intent.ACTION_CREATE_DOCUMENT`. Lossy MIME
//     transform: SAF accepts a single MIME per intent, so v1 hardcodes
//     `application/octet-stream`. The user-visible `EXTRA_TITLE` keeps
//     the suggested filename so UX is unchanged. Per-extension MIME
//     hint is a follow-up if UX requires it.
//
// Cancellation taxonomy: any non-`RESULT_OK` result code maps to
// `uri = null`. This covers `RESULT_CANCELED`, `RESULT_FIRST_USER`
// (Samsung/MIUI vendor extensions), and any future vendor-specific
// codes — cancellation is a UX state, not an error.

package app.vaultcore.picker

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SavePathArgs {
    lateinit var defaultName: String
}

@TauriPlugin
class PickerPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun pickDirectoryTree(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
            )
        }
        startActivityForResult(invoke, intent, "directoryTreeResult")
    }

    @Command
    fun pickSavePath(invoke: Invoke) {
        val args = invoke.parseArgs(SavePathArgs::class.java)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // ACTION_CREATE_DOCUMENT returns a one-shot write URI; the
            // persistable flag would be a no-op here. Kept off so the
            // intent reads as exactly what it does.
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_TITLE, args.defaultName)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        startActivityForResult(invoke, intent, "savePathResult")
    }

    @ActivityCallback
    fun directoryTreeResult(invoke: Invoke, result: ActivityResult) {
        val out = JSObject()
        if (result.resultCode == Activity.RESULT_OK) {
            out.put("uri", result.data?.data?.toString())
        } else {
            out.put("uri", null as String?)
        }
        invoke.resolve(out)
    }

    @ActivityCallback
    fun savePathResult(invoke: Invoke, result: ActivityResult) {
        val out = JSObject()
        if (result.resultCode == Activity.RESULT_OK) {
            out.put("uri", result.data?.data?.toString())
        } else {
            out.put("uri", null as String?)
        }
        invoke.resolve(out)
    }
}
