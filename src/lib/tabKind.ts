// Extension-based classifier used when opening a file path as a new tab (#49).
// Pure helper — no IPC, no filesystem access. The caller is responsible for
// subsequently loading the file content (or, for "unsupported", skipping it).
//
// Also hosts two viewport-aware helpers for the #388 mobile read-mode flow:
//   - `tabSupportsReading(tab)`: predicate over tab shape, used wherever the
//     UI needs to know whether Reading Mode applies to the active tab.
//   - `defaultViewModeForViewport()`: read-once viewport hint passed to
//     openers when creating a new tab. The store remains environment-agnostic
//     — viewport awareness lives at this UI boundary.

import { get } from "svelte/store";
import { viewportStore } from "../store/viewportStore";
import type { Tab, TabViewMode } from "../store/tabStoreCore";

/** Image extensions that render via `<img src={convertFileSrc(abs)} />`. */
export const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
]);

/**
 * Extensions that open read-only in the CodeMirror viewer. Known-safe plain
 * text / config file extensions — these never trigger the UTF-8 fallback path.
 */
export const TEXT_EXTS = new Set([
  "txt",
  "log",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
]);

/** Tab viewer — what UI branch EditorPane should render for a tab. */
export type TabKind = "markdown" | "image" | "text" | "unsupported" | "canvas";

/**
 * Extract the lowercase extension from a path (without the leading dot).
 * Returns "" if the basename has no dot.
 */
export function getExtension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Decide the viewer for a file path based on its extension. Files with
 * unknown extensions return "text" so the caller tries readFile and falls
 * back to "unsupported" if the bytes aren't valid UTF-8.
 */
export function getTabKind(path: string): TabKind {
  const ext = getExtension(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "canvas") return "canvas";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  // Unknown extension — caller should try UTF-8 read and fall back
  // to "unsupported" if decoding fails.
  return "text";
}

/**
 * #388 — does this tab kind have a Reading Mode path?
 *
 * Reading Mode renders rendered Markdown via `ReadingView.svelte`. Tab kinds
 * with their own dedicated surface (graph) or a non-markdown viewer
 * (image / unsupported / text / canvas) have no ReadingView path and must
 * never receive `viewMode === "read"`.
 *
 * Single source of truth: previously inlined in `EditorPane.svelte`'s
 * `paneActiveTabSupportsReading` and `VaultLayout.toggleActiveReadingMode`,
 * the two had drifted (canvas exclusion missing in EditorPane, both text
 * and canvas missing in VaultLayout). Extracting here fixes both.
 */
export function tabSupportsReading(tab: Tab): boolean {
  if (tab.type === "graph") return false;
  if (tab.viewer === "image") return false;
  if (tab.viewer === "unsupported") return false;
  if (tab.viewer === "text") return false;
  if (tab.viewer === "canvas") return false;
  return true;
}

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
