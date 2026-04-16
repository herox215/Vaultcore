// Inline HTML rendering CM6 plugin (#70).
//
// Walks the Lezer tree for `HTMLBlock` and `HTMLTag` nodes. When the cursor
// is NOT on the same line(s), the raw HTML source is replaced with a
// sanitized, rendered DOM widget. When the cursor is on the line, the raw
// source is shown for editing (same live-preview pattern as livePreview.ts
// and callouts.ts).
//
// HTML comments `<!-- … -->` are replaced with an empty widget so they
// render as invisible.
//
// Security: DOMPurify strips `<script>`, `on*` attributes, `javascript:`
// URLs, and dangerous SVG features before any HTML reaches the DOM.

import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type EditorView,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import DOMPurify from "dompurify";

// ── Sanitizer config ─────────────────────────────────────────────────────────

const PURIFY_CONFIG = {
  // Allow common safe HTML tags
  ALLOWED_TAGS: [
    "div", "span", "p", "br", "hr",
    "details", "summary",
    "kbd", "sub", "sup", "mark", "abbr", "small",
    "b", "i", "em", "strong", "u", "s", "del", "ins",
    "center",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "ul", "ol", "li", "dl", "dt", "dd",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code",
    "a", "img",
    // SVG subset
    "svg", "path", "circle", "rect", "line", "polyline", "polygon",
    "ellipse", "g", "text", "tspan", "defs", "use", "symbol",
  ],
  ALLOWED_ATTR: [
    "style", "class", "id", "title", "alt", "src", "href", "target",
    "width", "height", "colspan", "rowspan", "open",
    // SVG attributes
    "viewBox", "fill", "stroke", "stroke-width", "stroke-linecap",
    "stroke-linejoin", "d", "cx", "cy", "r", "rx", "ry",
    "x", "y", "x1", "y1", "x2", "y2", "points",
    "xmlns", "transform", "opacity",
  ],
  // Block dangerous SVG elements
  FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed"],
  // Strip all event handlers (on*)
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  // Disallow javascript: URLs
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/** Sanitize HTML string, returns safe HTML. Exported for testing. */
export function sanitizeHtml(raw: string): string {
  return DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string;
}

// ── Comment detection ────────────────────────────────────────────────────────

const COMMENT_RE = /^<!--[\s\S]*?-->$/;

function isHtmlComment(text: string): boolean {
  return COMMENT_RE.test(text.trim());
}

// ── Widgets ──────────────────────────────────────────────────────────────────

class HtmlBlockWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }

  eq(other: HtmlBlockWidget): boolean {
    return this.html === other.html;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-html-rendered";
    wrap.innerHTML = sanitizeHtml(this.html);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class HtmlInlineWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }

  eq(other: HtmlInlineWidget): boolean {
    return this.html === other.html;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-html-rendered-inline";
    wrap.innerHTML = sanitizeHtml(this.html);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── Decoration builder ───────────────────────────────────────────────────────

interface HtmlRange {
  from: number;
  to: number;
  isBlock: boolean;
  text: string;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: HtmlRange[] = [];

  const head = view.state.selection.main.head;
  const doc = view.state.doc;

  syntaxTree(view.state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      if (node.name !== "HTMLBlock" && node.name !== "HTMLTag") return;

      const from = node.from;
      const to = node.to;

      // If cursor is on any line within this node, show raw source
      const startLine = doc.lineAt(from).number;
      const endLine = doc.lineAt(to).number;
      const cursorLine = doc.lineAt(head).number;
      if (cursorLine >= startLine && cursorLine <= endLine) return;

      const text = doc.sliceString(from, to);

      // Skip empty strings
      if (text.trim().length === 0) return;

      ranges.push({
        from,
        to,
        isBlock: node.name === "HTMLBlock",
        text,
      });
    },
  });

  // Sort by position
  ranges.sort((a, b) => a.from - b.from);

  for (const r of ranges) {
    if (isHtmlComment(r.text)) {
      // Comments become invisible
      builder.add(r.from, r.to, Decoration.replace({}));
    } else if (r.isBlock) {
      builder.add(
        r.from,
        r.to,
        Decoration.replace({
          widget: new HtmlBlockWidget(r.text),
          block: true,
        }),
      );
    } else {
      builder.add(
        r.from,
        r.to,
        Decoration.replace({
          widget: new HtmlInlineWidget(r.text),
        }),
      );
    }
  }

  return builder.finish();
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const inlineHtmlPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
