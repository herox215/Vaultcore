// Per-vault bundled docs page helpers (#285).
// Mirrors homeCanvas.ts: the docs page lives at `<vault>/.vaultcore/DOCS.md`
// and is bootstrapped / refreshed by the Rust side (`ensure_docs_page`) on
// every vault open. The Markdown tab opened through here behaves like any
// other file tab — opening it twice focuses the existing tab instead of
// creating a duplicate, thanks to `openFileAsTab` deduping on filePath.

import { get } from "svelte/store";
import { vaultStore } from "../store/vaultStore";
import { tabStore } from "../store/tabStore";
import { openFileAsTab } from "./openFileAsTab";

/** Vault-relative path of the bundled docs page. */
export const DOCS_PAGE_REL = ".vaultcore/DOCS.md";

/** Normalise path separators so comparisons work on Windows paths too. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Absolute path of the docs page inside the given vault. */
export function docsPagePath(vaultPath: string): string {
  return `${norm(vaultPath)}/${DOCS_PAGE_REL}`;
}

/** True when `absPath` points at a vault's docs page. */
export function isDocsPagePath(absPath: string): boolean {
  return norm(absPath).endsWith(`/${DOCS_PAGE_REL}`);
}

/**
 * Label shown on the docs tab. Fixed string — every vault's docs page is
 * the same bundled content, so there's nothing vault-specific to surface.
 */
export function docsTabLabel(_absPath: string): string {
  return "Docs";
}

/**
 * Open (or focus) the current vault's docs page. Singleton by path —
 * `openFileAsTab` routes to `tabStore.openFileTab` which dedupes on filePath.
 * No-op when no vault is open.
 *
 * The docs page defaults to reading mode. The table of contents at the top
 * uses `[text](#anchor)` links that only render as clickable anchors in the
 * HTML reader — showing the raw markdown source on first open would bury the
 * navigation the user came for. Users can still toggle to edit mode via the
 * breadcrumbs button or `Cmd/Ctrl+E`, and that choice sticks for the tab's
 * lifetime because we only set `viewMode` when it's unset (fresh tab).
 */
export async function openDocsPage(): Promise<void> {
  const vaultPath = get(vaultStore).currentPath;
  if (!vaultPath) return;
  const absPath = docsPagePath(vaultPath);
  const tabId = await openFileAsTab(absPath);
  if (!tabId) return;
  const tab = get(tabStore).tabs.find((t) => t.id === tabId);
  if (tab && tab.viewMode === undefined) {
    tabStore.setViewMode(tabId, "read");
  }
}
