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
  { tag: tags.propertyName, color: "#9575CD" },
  { tag: tags.className, color: "#DB2777", fontWeight: "500" },
  { tag: [tags.typeName, tags.labelName], color: "#DB2777" },
  { tag: [tags.tagName, tags.angleBracket], color: "#DB2777" },
  { tag: tags.attributeName, color: "#9575CD" },
  { tag: tags.attributeValue, color: "#059669" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.paren, tags.brace, tags.separator], color: "var(--color-text-muted)" },
  { tag: tags.regexp, color: "#059669" },
  { tag: tags.escape, color: "#D97706" },
  { tag: tags.meta, color: "var(--color-text-muted)" },
]);

export const markdownTheme = EditorView.theme({
  // Editor root = warm gutter background. The .cm-content "document card"
  // sits centered on this gutter so the user can see why the text is
  // constrained — visually clear that the card is the writing surface.
  "&": {
    backgroundColor: "var(--color-bg)",
    color: "var(--color-text)",
    height: "100%",
    fontSize: "var(--vc-font-size)",
    fontFamily: "var(--vc-font-body)",
  },
  // BUG-05.1: CM6 base theme has .cm-content { flexGrow: 2 } which overrides
  // max-width alone. Force !important so our values win the cascade.
  ".cm-scroller": {
    overflow: "auto",
    justifyContent: "center !important",
  },
  // .cm-content = the centered "page". Surface-white background contrasts
  // gently with the gutter (--color-bg). Subtle border + shadow give it a
  // document-card feel without being heavy.
  // CSS variable defaults for each callout type. Themes may override these.
  ".cm-content": {
    padding: "32px 24px !important",
    width: "100% !important",
    maxWidth: "720px !important",
    marginLeft: "auto !important",
    marginRight: "auto !important",
    marginTop: "24px !important",
    marginBottom: "24px !important",
    flexGrow: "0 !important",
    flexShrink: "1 !important",
    flexBasis: "720px !important",
    backgroundColor: "var(--color-surface) !important",
    borderRadius: "8px !important",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06) !important",
    caretColor: "var(--color-accent)",
    "--callout-note-color": "#4A90D9",
    "--callout-info-color": "#4A90D9",
    "--callout-tip-color": "#38A169",
    "--callout-success-color": "#38A169",
    "--callout-question-color": "#D69E2E",
    "--callout-warning-color": "#E67E22",
    "--callout-failure-color": "#E53E3E",
    "--callout-danger-color": "#C53030",
    "--callout-bug-color": "#E53E3E",
    "--callout-example-color": "#805AD5",
    "--callout-quote-color": "#718096",
    "--callout-abstract-color": "#3182CE",
    "--callout-todo-color": "#38A169",
  },
  ".cm-line": { lineHeight: "1.6" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-accent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & .cm-selectionBackground": {
    background: "var(--color-selection) !important",
  },
  "&.cm-focused .cm-content ::selection, & .cm-content ::selection": {
    background: "var(--color-selection) !important",
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
  // Frontmatter is fully hidden in the editor — the block-replace widget
  // collapses to zero height so there is no visible gap at the top.
  ".cm-frontmatter-hidden": {
    display: "none",
  },

  // ── Callout blockquotes ────────────────────────────────────────────────────

  ".cm-callout": {
    borderLeft: "3px solid",
    paddingLeft: "12px",
    marginLeft: "0",
    position: "relative",
  },
  // Each type sets both color (for icon/title inheritance) and borderLeftColor
  // explicitly, so body-line rules that reset `color` don't drop the border.
  ".cm-callout-note": { color: "var(--callout-note-color)", borderLeftColor: "var(--callout-note-color)" },
  ".cm-callout-info": { color: "var(--callout-info-color)", borderLeftColor: "var(--callout-info-color)" },
  ".cm-callout-tip": { color: "var(--callout-tip-color)", borderLeftColor: "var(--callout-tip-color)" },
  ".cm-callout-success": { color: "var(--callout-success-color)", borderLeftColor: "var(--callout-success-color)" },
  ".cm-callout-question": { color: "var(--callout-question-color)", borderLeftColor: "var(--callout-question-color)" },
  ".cm-callout-warning": { color: "var(--callout-warning-color)", borderLeftColor: "var(--callout-warning-color)" },
  ".cm-callout-failure": { color: "var(--callout-failure-color)", borderLeftColor: "var(--callout-failure-color)" },
  ".cm-callout-danger": { color: "var(--callout-danger-color)", borderLeftColor: "var(--callout-danger-color)" },
  ".cm-callout-bug": { color: "var(--callout-bug-color)", borderLeftColor: "var(--callout-bug-color)" },
  ".cm-callout-example": { color: "var(--callout-example-color)", borderLeftColor: "var(--callout-example-color)" },
  ".cm-callout-quote": { color: "var(--callout-quote-color)", borderLeftColor: "var(--callout-quote-color)" },
  ".cm-callout-abstract": { color: "var(--callout-abstract-color)", borderLeftColor: "var(--callout-abstract-color)" },
  ".cm-callout-todo": { color: "var(--callout-todo-color)", borderLeftColor: "var(--callout-todo-color)" },

  // Title-line styles
  ".cm-callout-title-line": {
    fontWeight: "600",
    fontSize: "0.95em",
  },

  // Body lines: reset text color to editor default
  ".cm-callout-body-line": {
    color: "var(--color-text)",
  },

  // Title widget elements
  ".cm-callout-title-wrap": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    lineHeight: "1.6",
  },
  ".cm-callout-icon": {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: "0",
    color: "inherit",
  },
  ".cm-callout-icon svg": {
    display: "block",
  },
  ".cm-callout-title": {
    fontWeight: "600",
    color: "inherit",
  },
  ".cm-callout-chevron": {
    display: "inline-flex",
    alignItems: "center",
    marginLeft: "auto",
    paddingLeft: "8px",
    cursor: "pointer",
    color: "inherit",
    opacity: "0.7",
    transition: "transform 0.15s ease",
    transform: "rotate(0deg)",
  },
  ".cm-callout-chevron-collapsed": {
    transform: "rotate(-90deg)",
  },

  // ── Task list checkboxes ──────────────────────────────────────────────────
  ".cm-task-checkbox": {
    verticalAlign: "middle",
    marginRight: "0.35em",
    marginTop: "-2px",
    cursor: "pointer",
    accentColor: "var(--color-accent)",
  },
  ".cm-task-done": {
    textDecoration: "line-through",
    color: "var(--color-text-muted)",
  },

  // ── Embeds (issue #9) ─────────────────────────────────────────────────────
  // Images render inline via convertFileSrc + the asset protocol. Note embeds
  // show a bordered monospace block until a real markdown renderer is wired up.
  ".cm-embed-img": {
    display: "inline-block",
    maxWidth: "100%",
    borderRadius: "4px",
  },
  ".cm-embed-note": {
    display: "block",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    padding: "12px 16px",
    margin: "8px 0",
    backgroundColor: "var(--color-surface-2, var(--color-bg))",
    fontFamily: "var(--vc-font-mono)",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    maxHeight: "320px",
    overflow: "auto",
  },
  ".cm-embed-broken": {
    color: "var(--color-text-muted)",
    fontStyle: "italic",
  },

  // ── Inline HTML rendering (#70) ──────────────────────────────────────────
  ".cm-html-rendered": {
    display: "block",
    color: "var(--color-text)",
    lineHeight: "1.6",
  },
  ".cm-html-rendered-inline": {
    color: "var(--color-text)",
  },
  // <kbd> styling
  ".cm-html-rendered kbd, .cm-html-rendered-inline kbd": {
    fontFamily: "var(--vc-font-mono)",
    fontSize: "0.85em",
    padding: "2px 6px",
    border: "1px solid var(--color-border)",
    borderRadius: "3px",
    backgroundColor: "var(--color-code-bg)",
    boxShadow: "0 1px 0 rgba(0, 0, 0, 0.08)",
  },
  // <details> styling
  ".cm-html-rendered details": {
    border: "1px solid var(--color-border)",
    borderRadius: "4px",
    padding: "8px 12px",
    margin: "4px 0",
  },
  ".cm-html-rendered details summary": {
    cursor: "pointer",
    fontWeight: "600",
  },
  // <mark> styling
  ".cm-html-rendered mark, .cm-html-rendered-inline mark": {
    backgroundColor: "rgba(255, 213, 79, 0.4)",
    padding: "1px 2px",
    borderRadius: "2px",
  },

  // ── GFM table rendering (#99) + inline editing (#101) ───────────────────
  ".cm-table-wrap": {
    position: "relative",
    margin: "8px 0",
    padding: "0 14px 14px 0",
  },
  ".cm-table-rendered": {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "inherit",
    fontFamily: "inherit",
  },
  ".cm-table-rendered th, .cm-table-rendered td": {
    border: "1px solid var(--color-border)",
    padding: "6px 12px",
    lineHeight: "1.5",
    position: "relative",
  },
  ".cm-table-rendered th": {
    fontWeight: "600",
    backgroundColor: "var(--color-code-bg)",
  },
  ".cm-table-rendered tbody tr:hover": {
    backgroundColor: "var(--color-accent-bg)",
  },
  ".cm-table-rendered .cm-table-cell": {
    display: "block",
    minWidth: "2ch",
    minHeight: "1em",
    outline: "none",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".cm-table-rendered .cm-table-cell:focus": {
    outline: "1px solid var(--color-accent)",
    outlineOffset: "-1px",
  },
  // Hover controls fade in together when the wrap is hovered. They remain
  // focusable via keyboard so screen-reader / test code can reach them even
  // when not visually present.
  //
  // The 300ms fade-OUT delay (`opacity 120ms ease 300ms, visibility 0s 300ms`)
  // is the fix for issue #110: row/col delete buttons sit outside the table's
  // visible area (top: -22px, left: -24px), so moving the cursor from a cell
  // toward the button crosses a region that is not `.cm-table-wrap`. Without
  // the delay the wrap-hover selector drops before the cursor reaches the
  // button, `visibility` flips to `hidden`, and the button becomes
  // unclickable — exactly when the user tries to hit it. Using `visibility`
  // (not just `pointer-events`) keeps the transition discrete-friendly across
  // WebKit versions. `.cm-table-ctrl:hover` and `:focus-visible` re-arm the
  // visible state once the cursor / focus lands on the control, so it stays
  // reachable even if the wrap itself is no longer hovered.
  ".cm-table-wrap .cm-table-ctrl": {
    opacity: "0",
    visibility: "hidden",
    transition: "opacity 120ms ease 300ms, visibility 0s 300ms",
  },
  ".cm-table-wrap:hover .cm-table-ctrl, .cm-table-wrap:focus-within .cm-table-ctrl": {
    opacity: "1",
    visibility: "visible",
    transitionDelay: "0s",
  },
  ".cm-table-wrap .cm-table-ctrl:hover, .cm-table-wrap .cm-table-ctrl:focus-visible": {
    opacity: "1",
    visibility: "visible",
    transitionDelay: "0s",
  },
  ".cm-table-wrap .cm-table-add-col-btn": {
    position: "absolute",
    top: "0",
    bottom: "14px",
    right: "0",
    width: "14px",
    border: "1px dashed var(--color-border)",
    borderRadius: "0 3px 3px 0",
    background: "var(--color-surface)",
    color: "var(--color-text-muted)",
    fontSize: "14px",
    lineHeight: "1",
    cursor: "pointer",
    padding: "0",
  },
  ".cm-table-wrap .cm-table-add-row-btn": {
    position: "absolute",
    left: "0",
    right: "14px",
    bottom: "0",
    height: "14px",
    border: "1px dashed var(--color-border)",
    borderRadius: "0 0 3px 3px",
    background: "var(--color-surface)",
    color: "var(--color-text-muted)",
    fontSize: "14px",
    lineHeight: "1",
    cursor: "pointer",
    padding: "0",
  },
  // Table-level delete button — sits above the top-right corner of the table
  // in the same horizontal band as the per-column controls. The z-index keeps
  // it above the rightmost column's controls when they visually overlap.
  ".cm-table-wrap .cm-table-delete-btn": {
    position: "absolute",
    top: "-22px",
    right: "0",
    width: "20px",
    height: "20px",
    border: "1px solid var(--color-border)",
    borderRadius: "3px",
    background: "var(--color-surface)",
    color: "var(--color-text-muted)",
    fontSize: "12px",
    lineHeight: "1",
    cursor: "pointer",
    padding: "0",
    zIndex: "2",
  },
  ".cm-table-wrap .cm-table-delete-btn:hover": {
    background: "var(--color-danger, var(--color-border))",
    color: "var(--color-danger-fg, var(--color-text))",
    borderColor: "var(--color-danger, var(--color-border))",
  },
  ".cm-table-col-ctrls": {
    position: "absolute",
    top: "-22px",
    left: "0",
    right: "0",
    display: "inline-flex",
    justifyContent: "center",
    gap: "4px",
    fontSize: "11px",
    userSelect: "none",
  },
  ".cm-table-row-ctrls": {
    position: "absolute",
    left: "-24px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "inline-flex",
    flexDirection: "column",
    gap: "2px",
    fontSize: "11px",
    userSelect: "none",
  },
  ".cm-table-col-sort, .cm-table-col-delete, .cm-table-row-delete": {
    cursor: "pointer",
    color: "var(--color-text-muted)",
    background: "transparent",
    border: "none",
    padding: "1px 3px",
    borderRadius: "2px",
    fontSize: "11px",
    lineHeight: "1",
  },
  ".cm-table-col-sort:hover, .cm-table-col-delete:hover, .cm-table-row-delete:hover": {
    background: "var(--color-border)",
    color: "var(--color-text)",
  },
});
