// Viewport-aware UI helpers (#388). Lives in its own module so the pure
// `tabKind` classifier (`getTabKind` / `getExtension` / `tabSupportsReading`)
// stays free of `viewportStore` — i.e., free of the matchMedia listener
// initializer that the store grabs at module load. Importing
// `getExtension` for an extension lookup must NOT pull in matchMedia.

import { get } from "svelte/store";
import { viewportStore } from "../store/viewportStore";
import type { TabViewMode } from "../store/tabStoreCore";

/**
 * #388 — viewport-aware default `viewMode` for newly-opened markdown tabs.
 *
 * Mobile users get notes in Reading Mode by default to avoid accidental
 * edits while scrolling. Desktop and tablet keep the existing edit default.
 *
 * Always returns a `TabViewMode` — callers may pass it directly to
 * `tabStore.openTab(path, defaultViewModeForViewport())` without
 * conditional checks. Returning `"edit"` on desktop is byte-identical
 * in effect to omitting the hint, since every reader coalesces
 * `viewMode ?? "edit"`.
 *
 * The store layer never reads `viewportStore`; this helper is the single
 * UI seam where viewport state crosses into tab metadata. Tests stub
 * `viewportStore` here and nowhere else.
 */
export function defaultViewModeForViewport(): TabViewMode {
  return get(viewportStore).mode === "mobile" ? "read" : "edit";
}
