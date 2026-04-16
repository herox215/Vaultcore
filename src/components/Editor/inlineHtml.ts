// Inline HTML rendering CM6 plugin (#70).
//
// Walks the Lezer tree for `HTMLBlock` and `HTMLTag` nodes. When the cursor
// is NOT on the same line(s), the raw HTML source is replaced with a
// sanitized, rendered DOM widget. When the cursor is on the line, the raw
// source is shown for editing (same live-preview pattern as callouts.ts).
//
// HTML comments `<!-- … -->` are replaced with an empty decoration so they
// render as invisible.
//
// Uses a StateField (not ViewPlugin) because CM6 requires block-level
// replace decorations to come from a StateField.
//
// Security: DOMPurify strips `<script>`, `on*` attributes, `javascript:`
// URLs, and dangerous SVG features before any HTML reaches the DOM.

import {
  Decoration,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import DOMPurify from "dompurify";
import type { Extension } from "@codemirror/state";

// ── Sanitizer config ─────────────────────────────────────────────────────────

const PURIFY_CONFIG = {
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
  FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
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

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];

  const head = state.selection.main.head;
  const doc = state.doc;

  syntaxTree(state).iterate({
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
      if (text.trim().length === 0) return;

      if (isHtmlComment(text)) {
        ranges.push({
          from,
          to,
          decoration: Decoration.replace({}),
        });
      } else {
        // Don't replace HTML fragments whose sanitized output is empty
        // (e.g. a lone `</div>` after a blank line — CommonMark splits
        // multi-line HTML blocks at blank lines, producing orphan closing
        // tags that DOMPurify strips entirely).
        const sanitized = sanitizeHtml(text);
        if (sanitized.trim().length === 0) return;

        if (node.name === "HTMLBlock") {
          ranges.push({
            from,
            to,
            decoration: Decoration.replace({
              widget: new HtmlBlockWidget(text),
              block: true,
            }),
          });
        } else {
          ranges.push({
            from,
            to,
            decoration: Decoration.replace({
              widget: new HtmlInlineWidget(text),
            }),
          });
        }
      }
    },
  });

  ranges.sort((a, b) => a.from - b.from);

  return Decoration.set(
    ranges.map((r) => r.decoration.range(r.from, r.to)),
    true,
  );
}

// ── StateField ───────────────────────────────────────────────────────────────

const inlineHtmlField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

export const inlineHtmlPlugin: Extension = inlineHtmlField;
