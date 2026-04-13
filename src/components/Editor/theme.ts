import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const markdownHighlightStyle = HighlightStyle.define([
  // ── Markdown structural tokens ─────────────────────────────────────────────
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

  // ── Fenced-code language tokens (EDIT-03 / BUG-05.1) ───────────────────────
  // The markdown({ codeLanguages: languages }) extension lazy-loads Lezer
  // grammars for ```lang fences and emits these highlight tags; without mapping
  // them here the grammar parses correctly but everything renders as plain text.
  // Values use CSS variables so dark-mode flips via data-theme swap.
  { tag: tags.keyword, color: "var(--color-accent)", fontWeight: "600" },
  { tag: tags.controlKeyword, color: "var(--color-accent)", fontWeight: "600" },
  { tag: tags.operatorKeyword, color: "var(--color-accent)", fontWeight: "600" },
  { tag: tags.definitionKeyword, color: "var(--color-accent)", fontWeight: "600" },
  { tag: tags.modifier, color: "var(--color-accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "#059669" },
  { tag: tags.number, color: "#D97706" },
  { tag: tags.bool, color: "#D97706" },
  { tag: tags.atom, color: "#D97706" },
  { tag: [tags.name, tags.variableName], color: "var(--color-text)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#2563EB", fontWeight: "500" },
  { tag: tags.propertyName, color: "#7C3AED" },
  { tag: tags.className, color: "#DB2777", fontWeight: "500" },
  { tag: [tags.typeName, tags.labelName], color: "#DB2777" },
  { tag: [tags.tagName, tags.angleBracket], color: "#DB2777" },
  { tag: tags.attributeName, color: "#7C3AED" },
  { tag: tags.attributeValue, color: "#059669" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.paren, tags.brace, tags.separator], color: "var(--color-text-muted)" },
  { tag: tags.regexp, color: "#059669" },
  { tag: tags.escape, color: "#D97706" },
  { tag: tags.meta, color: "var(--color-text-muted)" },
]);

export const markdownTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text)",
    height: "100%",
    fontSize: "var(--vc-font-size)",
    fontFamily: "var(--vc-font-body)",
  },
  // BUG-05.1: center the content properly — using multiple overlapping rules
  // because CM6 layers base-theme !important rules on .cm-scroller/.cm-content.
  // 1. Make .cm-scroller center its flex child (.cm-content).
  // 2. Clamp .cm-content's flex-basis so it doesn't grow beyond 720px.
  // 3. Also apply margin-auto + max-width on content as a fallback for base
  //    themes that leave justifyContent alone.
  // BUG-05.1: CM6 base theme has .cm-content { flexGrow: 2 } which overrides
  // max-width alone. Force !important so our values win the cascade.
  ".cm-scroller": {
    overflow: "auto",
    justifyContent: "center !important",
  },
  ".cm-content": {
    padding: "16px !important",
    width: "100% !important",
    maxWidth: "720px !important",
    marginLeft: "auto !important",
    marginRight: "auto !important",
    flexGrow: "0 !important",
    flexShrink: "1 !important",
    flexBasis: "720px !important",
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
  // BUG-05.1: fenced code blocks now render with a background + mono font.
  // The Lezer markdown grammar marks fence content with FencedCode class
  // (not a highlight tag), so this targets the DOM class directly.
  ".cm-content .cm-FencedCode, .cm-content .tok-FencedCode": {
    backgroundColor: "var(--color-code-bg)",
    fontFamily: "var(--vc-font-mono)",
    fontSize: "13px",
    display: "block",
    padding: "8px 12px",
    borderRadius: "4px",
  },
});
