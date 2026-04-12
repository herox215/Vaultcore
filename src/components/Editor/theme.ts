import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "26px", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "22px", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "18px", fontWeight: "700" },
  { tag: tags.heading4, fontSize: "16px", fontWeight: "700" },
  { tag: tags.heading5, fontSize: "15px", fontWeight: "700" },
  { tag: tags.heading6, fontSize: "15px", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.monospace, fontFamily: "var(--vc-font-mono)" },
  { tag: tags.link, color: "var(--color-accent)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--color-accent)" },
  { tag: tags.comment, color: "var(--color-text-muted)", fontStyle: "italic" },
]);

export const markdownTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text)",
    height: "100%",
    fontSize: "var(--vc-font-size)",
    fontFamily: "var(--vc-font-body)",
  },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": {
    padding: "16px",
    maxWidth: "720px",
    margin: "0 auto",
    caretColor: "var(--color-accent)",
  },
  ".cm-line": { lineHeight: "1.6" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-accent)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-accent-bg)",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  // Monospace inline code (styled by HighlightStyle fontFamily; add bg here)
  ".cm-content .tok-monospace": {
    backgroundColor: "var(--color-code-bg)",
    borderRadius: "3px",
    padding: "1px 4px",
    fontSize: "13px",
  },
});
