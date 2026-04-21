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
import { readCached, requestLoad } from "./noteContentCache";

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
      // Active tab → live buffer (reflects unsaved edits).
      const s = get(editorStore);
      if (s.activePath === relPath) return s.content;
      // Otherwise fall back to the shared on-disk cache (#319). A miss
      // kicks an async load; the next render-tick — triggered by the
      // `noteContentCacheVersion` store — will see the filled entry.
      const cached = readCached(relPath);
      if (cached !== null) return cached;
      requestLoad(relPath);
      return null;
    },
  };
}

export function currentVaultRoot(): VaultRoot {
  return createVaultRoot(currentStores());
}
