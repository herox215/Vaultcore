// Open-a-file-path-as-tab dispatcher (#49). Classifies the path by extension,
// and for unknown extensions probes readFile() to decide between the text
// viewer and the "unsupported" placeholder. Centralized so every caller
// (sidebar click, quick switcher, search result) routes through the same
// viewer-selection logic.

import { tabStore } from "../store/tabStore";
import { readFile } from "../ipc/commands";
import { isVaultError } from "../types/errors";
import {
  defaultViewModeForViewport,
  getExtension,
  getTabKind,
  IMAGE_EXTS,
  TEXT_EXTS,
} from "./tabKind";
import { encryptedFolders } from "../store/encryptedFoldersStore";
import { vaultStore } from "../store/vaultStore";
import { openUnlockModal } from "../store/encryptionModalStore";
import { get } from "svelte/store";

/**
 * Open `absPath` as a tab. Dispatches to the right viewer:
 *  - `.md` / `.markdown` → openTab() (existing markdown flow)
 *  - known image ext → openFileTab(path, "image")
 *  - known text ext → openFileTab(path, "text")
 *  - unknown ext → try readFile(); UTF-8 success → "text",
 *    InvalidEncoding → "unsupported".
 * Returns the opened tab id, or `null` if the probe throws for a non-
 * encoding reason (FileNotFound, PermissionDenied) — in that case the
 * caller's existing toast plumbing handles the user message.
 */
/**
 * #345: determine whether `absPath` sits inside a currently-locked
 * encrypted root. Returns the absolute path of the locking root, or
 * null if the target is plain / unlocked. Uses the frontend store
 * (salt-stripped manifest) and the vaultStore's current vault root
 * to construct the prefix — no IPC call on the hot click path.
 */
function findLockingRoot(absPath: string): string | null {
  const vs = get(vaultStore);
  const vaultRoot = vs.currentPath;
  if (!vaultRoot) return null;
  const entries = get(encryptedFolders);
  if (entries.length === 0) return null;
  const normalizedAbs = absPath.replace(/\\/g, "/");
  // #345: strip trailing separators from the vault root BEFORE we
  // join with the rel path — otherwise `/vault/` + `secret` produced
  // `/vault//secret` and the prefix check silently missed every
  // locked folder on systems where the vault path ends with a slash.
  const normalizedVault = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const entry of entries) {
    const rootAbs = `${normalizedVault}/${entry.path}`;
    if (normalizedAbs === rootAbs || normalizedAbs.startsWith(rootAbs + "/")) {
      // Note: the store does NOT carry an is-locked flag — the
      // backend state is the source of truth via the sidebar's
      // `DirEntry.encryption`. But any file in the manifest whose
      // host folder is currently locked will have already been
      // closed-or-never-opened by the tree; the safe default when a
      // link points into a manifest-listed folder is to check via
      // the backend. We use `DirEntry` on the sidebar for the UI;
      // here we defer to the backend's gate, which returns
      // PathLocked if the folder is locked — let that error drive
      // the unlock modal.
      return rootAbs;
    }
  }
  return null;
}

export async function openFileAsTab(absPath: string): Promise<string | null> {
  // #345: if the target sits inside an encrypted root that the user
  // is holding locked, open the unlock modal instead of routing into
  // the viewer (which would fail with a cryptic "file is binary" or
  // "invalid encoding" error on ciphertext). The `findLockingRoot`
  // check is O(k) against the encryptedFolders store; if no
  // encrypted folders exist it short-circuits to null at zero cost.
  //
  // We only prompt here for paths inside a known encrypted root that
  // COULD be locked. Paths outside any encrypted root skip this
  // entirely — no double read_file on the happy path.
  const lockingRoot = findLockingRoot(absPath);
  if (lockingRoot) {
    try {
      await readFile(absPath);
    } catch (err) {
      if (isVaultError(err) && err.kind === "PathLocked") {
        const label = lockingRoot.split("/").pop() ?? lockingRoot;
        openUnlockModal(lockingRoot, label, () => {
          void openFileAsTab(absPath);
        });
        return null;
      }
      // Any other error (incl. binary ciphertext) falls through; the
      // classifier below will handle InvalidEncoding → "unsupported".
    }
  }

  const ext = getExtension(absPath);
  if (ext === "md" || ext === "markdown") {
    // #388 — markdown opens default to read on mobile, edit elsewhere.
    // Only the markdown branch passes the hint; image/canvas/text/unsupported
    // viewers have no Reading Mode path so the hint would be a no-op there
    // (and the tabStore would still write `viewMode: "read"` onto a tab kind
    // that EditorPane ignores — wasted state).
    return tabStore.openTab(absPath, defaultViewModeForViewport());
  }
  if (ext === "canvas") {
    return tabStore.openFileTab(absPath, "canvas");
  }
  if (IMAGE_EXTS.has(ext)) {
    return tabStore.openFileTab(absPath, "image");
  }
  if (TEXT_EXTS.has(ext)) {
    return tabStore.openFileTab(absPath, "text");
  }

  // Unknown extension — probe UTF-8 decodability.
  try {
    await readFile(absPath);
    return tabStore.openFileTab(absPath, "text");
  } catch (err) {
    if (isVaultError(err) && err.kind === "InvalidEncoding") {
      return tabStore.openFileTab(absPath, "unsupported");
    }
    // Re-throw unrelated errors — caller may want to surface a toast.
    throw err;
  }
}

// Re-export for callers that only want the synchronous classifier.
export { getTabKind };
