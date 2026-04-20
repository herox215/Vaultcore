// Glue between the svelte stores and the pure `VaultStores` interface the
// vault API expects. Kept in a separate module so `vaultApi.ts` stays
// store-agnostic (and cheap to test with plain objects).

import { get } from "svelte/store";
import { vaultStore } from "../store/vaultStore";
import { tagsStore } from "../store/tagsStore";
import { bookmarksStore } from "../store/bookmarksStore";
import { editorStore } from "../store/editorStore";
import { createVaultRoot } from "./vaultApi";
import type { VaultStores, VaultRoot } from "./vaultApi";

function vaultNameFromPath(path: string | null): string {
  if (!path) return "";
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

function currentStores(): VaultStores {
  return {
    readVault: () => {
      const s = get(vaultStore);
      return {
        name: vaultNameFromPath(s.currentPath),
        path: s.currentPath ?? "",
        fileList: s.fileList,
      };
    },
    readTags: () => get(tagsStore).tags,
    readBookmarks: () => get(bookmarksStore).paths,
    readNoteContent: (relPath: string) => {
      // In-memory only: the active editor tab. Non-active notes have no
      // content available synchronously. See #283 follow-up.
      const s = get(editorStore);
      return s.activePath === relPath ? s.content : null;
    },
  };
}

export function currentVaultRoot(): VaultRoot {
  return createVaultRoot(currentStores());
}
