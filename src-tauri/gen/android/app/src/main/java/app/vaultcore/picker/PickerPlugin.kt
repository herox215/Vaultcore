// #391 / #392 — Tauri mobile plugin for VaultCore's vault folder picker
// (#391) and Storage Access Framework I/O (#392 PR-B).
//
// Placement note: this file lives directly in `gen/android/...` and NOT
// in a `src-tauri/android/` overlay directory. As of Tauri 2.10 the
// overlay convention is silently ignored at build time — verified via
// `dexdump`. The `gen/android/` placement empirically survives a
// `tauri android init` re-run in this Tauri version. See
// `docs/MOBILE_BUILD.md` → "Custom Android plugins".
//
// Commands exposed to the Rust side via Tauri's mobile-plugin FFI:
//
//   #391 (already shipped):
//   - pickDirectoryTree:  ACTION_OPEN_DOCUMENT_TREE  → content:// tree URI.
//   - pickSavePath:       ACTION_CREATE_DOCUMENT     → content:// save URI.
//
//   #392 PR-B:
//   - takePersistableUriPermission(uri): persists the read+write grant
//     so the URI survives app restart. MUST be called inside the
//     directoryTreeResult callback flow before the activity completes.
//   - hasPersistedPermission(uri):       boolean check on
//     contentResolver.getPersistedUriPermissions(). Used by `open_vault`
//     before opening a recents URI to surface VaultPermissionRevoked.
//   - readFile(treeUri, relPath):       returns base64 content.
//   - writeFile(treeUri, relPath, contentB64): creates parents as needed.
//   - createFile(treeUri, relPath, contentB64): same as writeFile today;
//     kept distinct so a future "fail if exists" semantic can diverge.
//   - createDir(treeUri, relPath):       walk + DocumentFile.createDirectory.
//   - delete(treeUri, relPath):           DocumentFile.delete (recursive).
//   - rename(treeUri, fromRel, toRel):    rename within the tree.
//   - metadata(treeUri, relPath):         returns { exists, isDir, size }.
//   - listDir(treeUri, relPath):          returns { entries: [{name, isDir}] }.
//   - exists(treeUri, relPath):           boolean.
//
// Cancellation: not applicable for I/O commands. They either succeed or
// reject with a stable error string. The Rust side maps rejections to
// `VaultError::Io { msg }` (the IPC's free-form Io variant).
//
// Performance: each `walkRel` step is one Binder round-trip (1-5ms).
// Deep paths cost more; documented in MOBILE_BUILD.md. Batch-API
// optimization deferred until UAT calls it out.

package app.vaultcore.picker

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSArray
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// ── #391 picker args ────────────────────────────────────────────────────────

@InvokeArg
class SavePathArgs {
    lateinit var defaultName: String
}

// ── #392 PR-B I/O args ──────────────────────────────────────────────────────

@InvokeArg
class UriArg {
    lateinit var uri: String
}

@InvokeArg
class ReadArgs {
    lateinit var treeUri: String
    lateinit var relPath: String
}

@InvokeArg
class WriteArgs {
    lateinit var treeUri: String
    lateinit var relPath: String
    lateinit var contentB64: String
}

@InvokeArg
class DirArgs {
    lateinit var treeUri: String
    lateinit var relPath: String
}

@InvokeArg
class RenameArgs {
    lateinit var treeUri: String
    lateinit var fromRel: String
    lateinit var toRel: String
}

@TauriPlugin
class PickerPlugin(private val activity: Activity) : Plugin(activity) {

    // ── #391 commands (unchanged) ───────────────────────────────────────────

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

    // ── #392 PR-B: persistable permission ──────────────────────────────────

    @Command
    fun takePersistableUriPermission(invoke: Invoke) {
        val args = invoke.parseArgs(UriArg::class.java)
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
            activity.contentResolver
                .takePersistableUriPermission(Uri.parse(args.uri), flags)
            invoke.resolve(JSObject())
        } catch (ex: SecurityException) {
            // Tree URI was not surfaced via SAF in this app session
            // (e.g. trying to take perms on a stale URI from recents
            // when the picker hasn't been invoked since reinstall).
            invoke.reject("takePersistableUriPermission denied: ${ex.message}")
        }
    }

    @Command
    fun hasPersistedPermission(invoke: Invoke) {
        val args = invoke.parseArgs(UriArg::class.java)
        val target = Uri.parse(args.uri)
        val granted = activity.contentResolver.persistedUriPermissions.any {
            it.uri == target && (it.isReadPermission || it.isWritePermission)
        }
        invoke.resolve(JSObject().apply { put("granted", granted) })
    }

    // ── #392 PR-B: I/O against SAF tree ────────────────────────────────────

    @Command
    fun readFile(invoke: Invoke) {
        val args = invoke.parseArgs(ReadArgs::class.java)
        try {
            val node = walkRel(args.treeUri, args.relPath, createParents = false)
                ?: return invoke.reject("not found: ${args.relPath}")
            val bytes = activity.contentResolver
                .openInputStream(node.uri)
                ?.use { it.readBytes() }
                ?: return invoke.reject("openInputStream returned null: ${args.relPath}")
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            invoke.resolve(JSObject().apply { put("contentB64", b64) })
        } catch (ex: Exception) {
            invoke.reject("readFile ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun writeFile(invoke: Invoke) {
        val args = invoke.parseArgs(WriteArgs::class.java)
        try {
            val bytes = Base64.decode(args.contentB64, Base64.NO_WRAP)
            val parent = walkRel(
                args.treeUri,
                parentOf(args.relPath),
                createParents = true,
            ) ?: return invoke.reject("could not resolve parent: ${args.relPath}")
            val name = lastSegment(args.relPath)
                ?: return invoke.reject("invalid relPath: ${args.relPath}")
            val target = parent.findFile(name) ?: parent.createFile(
                /* mimeType */ "application/octet-stream",
                name,
            ) ?: return invoke.reject("createFile failed: ${args.relPath}")
            activity.contentResolver
                .openOutputStream(target.uri, "wt")
                ?.use { it.write(bytes) }
                ?: return invoke.reject("openOutputStream returned null: ${args.relPath}")
            invoke.resolve(JSObject())
        } catch (ex: Exception) {
            invoke.reject("writeFile ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun createFile(invoke: Invoke) {
        // PR-B v1: same behavior as writeFile (creates-or-truncates).
        // The "fail if exists" semantic the Rust caller expects is
        // enforced one layer up by `commands/files.rs::create_file_impl`
        // which checks for collision before invoking us.
        writeFile(invoke)
    }

    @Command
    fun createDir(invoke: Invoke) {
        val args = invoke.parseArgs(DirArgs::class.java)
        try {
            walkRel(args.treeUri, args.relPath, createParents = true)
                ?: return invoke.reject("createDir failed: ${args.relPath}")
            invoke.resolve(JSObject())
        } catch (ex: Exception) {
            invoke.reject("createDir ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun deletePath(invoke: Invoke) {
        val args = invoke.parseArgs(DirArgs::class.java)
        try {
            val node = walkRel(args.treeUri, args.relPath, createParents = false)
                ?: return invoke.reject("not found: ${args.relPath}")
            // DocumentFile.delete is recursive on directories per platform docs.
            if (!node.delete()) {
                return invoke.reject("delete returned false: ${args.relPath}")
            }
            invoke.resolve(JSObject())
        } catch (ex: Exception) {
            invoke.reject("delete ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun renamePath(invoke: Invoke) {
        val args = invoke.parseArgs(RenameArgs::class.java)
        try {
            val from = walkRel(args.treeUri, args.fromRel, createParents = false)
                ?: return invoke.reject("not found: ${args.fromRel}")
            val fromParent = parentOf(args.fromRel)
            val toParent = parentOf(args.toRel)
            if (fromParent == toParent) {
                // Same-parent rename — DocumentFile.renameTo handles it.
                val newName = lastSegment(args.toRel)
                    ?: return invoke.reject("invalid toRel: ${args.toRel}")
                if (!from.renameTo(newName)) {
                    return invoke.reject("renameTo returned false: ${args.toRel}")
                }
                invoke.resolve(JSObject())
            } else {
                // Cross-parent rename — SAF doesn't support this directly.
                // Use DocumentsContract.moveDocument if both parents are
                // queryable (provider must support FLAG_SUPPORTS_MOVE).
                val to = lastSegment(args.toRel)
                    ?: return invoke.reject("invalid toRel: ${args.toRel}")
                val newParent = walkRel(args.treeUri, toParent, createParents = true)
                    ?: return invoke.reject("could not resolve dest parent: ${args.toRel}")
                val moved = DocumentsContract.moveDocument(
                    activity.contentResolver,
                    from.uri,
                    from.parentFile?.uri ?: return invoke.reject("source has no parent"),
                    newParent.uri,
                ) ?: return invoke.reject(
                    "moveDocument failed (provider may not support cross-parent move)",
                )
                // After move, rename the leaf if the basename changed.
                val movedDoc = DocumentFile.fromTreeUri(activity, moved)
                if (movedDoc?.name != to) {
                    movedDoc?.renameTo(to)
                }
                invoke.resolve(JSObject())
            }
        } catch (ex: Exception) {
            invoke.reject("rename ${args.fromRel} → ${args.toRel}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun metadata(invoke: Invoke) {
        val args = invoke.parseArgs(DirArgs::class.java)
        try {
            val node = walkRel(args.treeUri, args.relPath, createParents = false)
            val out = JSObject()
            if (node == null) {
                out.put("exists", false)
                out.put("isDir", false)
                out.put("size", 0)
            } else {
                out.put("exists", true)
                out.put("isDir", node.isDirectory)
                out.put("size", node.length())
            }
            invoke.resolve(out)
        } catch (ex: Exception) {
            invoke.reject("metadata ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun listDir(invoke: Invoke) {
        val args = invoke.parseArgs(DirArgs::class.java)
        try {
            val dir = walkRel(args.treeUri, args.relPath, createParents = false)
                ?: return invoke.reject("not found: ${args.relPath}")
            if (!dir.isDirectory) {
                return invoke.reject("not a directory: ${args.relPath}")
            }
            val entries = JSArray()
            for (child in dir.listFiles()) {
                val e = JSObject()
                e.put("name", child.name ?: continue)
                e.put("isDir", child.isDirectory)
                entries.put(e)
            }
            invoke.resolve(JSObject().apply { put("entries", entries) })
        } catch (ex: Exception) {
            invoke.reject("listDir ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    @Command
    fun pathExists(invoke: Invoke) {
        val args = invoke.parseArgs(DirArgs::class.java)
        try {
            val node = walkRel(args.treeUri, args.relPath, createParents = false)
            invoke.resolve(JSObject().apply { put("exists", node != null) })
        } catch (ex: Exception) {
            invoke.reject("exists ${args.relPath}: ${ex.message ?: ex.javaClass.simpleName}")
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /**
     * Walk a forward-slash-separated rel path under the SAF tree URI,
     * returning the leaf DocumentFile (file or directory). Returns
     * `null` if any intermediate component is missing AND
     * [createParents] is `false`.
     *
     * If [createParents] is `true`, missing intermediate directories
     * are created via DocumentFile.createDirectory. The leaf component
     * is always treated as the target — this function never creates a
     * leaf file (writeFile/createFile own that).
     *
     * `relPath = ""` returns the tree root.
     *
     * Rel-path validation is the Rust caller's job (storage::validate_rel)
     * — this function trusts its input is normalized.
     */
    private fun walkRel(
        treeUri: String,
        relPath: String,
        createParents: Boolean,
    ): DocumentFile? {
        val root = DocumentFile.fromTreeUri(activity, Uri.parse(treeUri)) ?: return null
        if (relPath.isEmpty()) return root
        val parts = relPath.split('/').filter { it.isNotEmpty() }
        var cur: DocumentFile = root
        for ((i, name) in parts.withIndex()) {
            val isLeaf = i == parts.size - 1
            val existing = cur.findFile(name)
            cur = if (existing != null) {
                existing
            } else if (createParents && !isLeaf) {
                cur.createDirectory(name) ?: return null
            } else if (createParents && isLeaf) {
                // Caller wants the leaf itself — treat as a dir (we
                // don't know the target type for a non-existent file).
                cur.createDirectory(name) ?: return null
            } else {
                return null
            }
        }
        return cur
    }

    /**
     * Parent rel-path of `relPath`, forward-slash separated. Returns
     * empty string if the rel has no `/`.
     */
    private fun parentOf(relPath: String): String {
        val i = relPath.lastIndexOf('/')
        return if (i <= 0) "" else relPath.substring(0, i)
    }

    /**
     * Last segment of `relPath`. Returns null for empty input.
     */
    private fun lastSegment(relPath: String): String? {
        if (relPath.isEmpty()) return null
        val i = relPath.lastIndexOf('/')
        return if (i < 0) relPath else relPath.substring(i + 1)
    }
}
