// Open-a-file-path-as-tab dispatcher (#49). Classifies the path by extension,
// and for unknown extensions probes readFile() to decide between the text
// viewer and the "unsupported" placeholder. Centralized so every caller
// (sidebar click, quick switcher, search result) routes through the same
// viewer-selection logic.

import { tabStore } from "../store/tabStore";
import { readFile } from "../ipc/commands";
import { isVaultError } from "../types/errors";
import { getExtension, getTabKind, IMAGE_EXTS, TEXT_EXTS } from "./tabKind";

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
export async function openFileAsTab(absPath: string): Promise<string | null> {
  const ext = getExtension(absPath);
  if (ext === "md" || ext === "markdown") {
    return tabStore.openTab(absPath);
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
