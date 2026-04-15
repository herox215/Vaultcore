// Active-tab → tree reveal bridge (#50).
//
// The sidebar's file tree should always follow whichever tab the user
// has active in the editor — mirroring Obsidian. Tabs can be activated
// from many places (tree click, Quick Switcher, wiki-link, backlinks,
// bookmarks, Cmd+N, tab cycling, tab close, …) and we don't want to
// scatter reveal calls through all of them. Instead, a single subscription
// on tabStore routes every activation through treeRevealStore.
//
// This module contains the pure decision logic — turning an active tab
// plus the current vault root into the reveal payload — so it can be
// unit-tested without spinning up the Svelte component.
//
// Rules:
//   - No reveal when there is no active tab.
//   - No reveal when the vault path is null.
//   - No reveal for graph tabs (sentinel filePath "vault://graph").
//   - No reveal when the tab's absolute path is outside the vault.
//   - Otherwise, return the vault-relative path (forward slashes,
//     no leading slash).

import { GRAPH_TAB_PATH, type Tab } from "../store/tabStore";

/**
 * Compute the vault-relative path that should be revealed in the tree for
 * a given active tab. Returns `null` when no reveal is appropriate.
 */
export function resolveRevealRelPath(
  activeTab: Tab | null | undefined,
  vaultPath: string | null,
): string | null {
  if (!activeTab) return null;
  if (!vaultPath) return null;
  if (activeTab.type === "graph") return null;
  if (activeTab.filePath === GRAPH_TAB_PATH) return null;

  const abs = activeTab.filePath.replace(/\\/g, "/");
  const root = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!abs.startsWith(root + "/")) return null;

  const rel = abs.slice(root.length + 1);
  return rel.length > 0 ? rel : null;
}
