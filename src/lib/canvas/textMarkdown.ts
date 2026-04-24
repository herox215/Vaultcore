// Helper that pre-renders canvas text-node Markdown to HTML, keyed by
// node.id. Lives in the canvas lib layer so both the interactive
// CanvasView and the read-only embed widget in embedPlugin can feed
// the same `mdTextNodes` prop into CanvasRenderer.
//
// The helper is intentionally a plain function — not a $derived — so
// non-Svelte callers (embedPlugin's `mount`) can use it too. Callers
// in Svelte components wrap it in their own $derived to re-compute
// when doc.nodes change.
//
// #364: this replaces the previous `tokenizeCanvasText` path. Canvas
// text nodes now render full Markdown (including template expression
// evaluation via `renderMarkdownToHtml`'s existing `{{ ... }}`
// pipeline), so the #332 template-body link-suppression that
// textTokens applied is no longer in effect — templates in canvas
// text nodes now behave identically to templates in note content.

import type { CanvasDoc, CanvasTextNode } from "./types";
import { renderMarkdownToHtml } from "../../components/Editor/reading/markdownRenderer";

/**
 * Render every text node's Markdown to HTML.
 *
 * @param doc - the canvas document.
 * @param skipId - when set, the node with this id is omitted from the
 *   output. Used by CanvasView to skip the currently-edited node (the
 *   textarea branch does not read `mdTextNodes`, and rendering HTML
 *   for a buffer that's about to change on every keystroke is wasted
 *   work).
 * @param noteTitle - feeds `{{title}}` inside template expressions.
 *   For canvas text nodes the canonical binding is the canvas file's
 *   basename — not the last-focused editor tab. Callers pass the
 *   result of `titleFromPath(canvasAbs)`. Omitting it falls back to
 *   the `editorStore.activePath`, which is wrong for canvases (the
 *   canvas view is not an editor tab) and non-reactive in a
 *   `$derived` — always pass a concrete string from the caller.
 */
export function computeCanvasTextHtml(
  doc: CanvasDoc,
  skipId: string | null = null,
  noteTitle?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of doc.nodes) {
    if (n.type !== "text") continue;
    if (n.id === skipId) continue;
    const text = (n as CanvasTextNode).text ?? "";
    out[n.id] = renderMarkdownToHtml(text, noteTitle);
  }
  return out;
}
