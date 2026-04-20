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
// replace decorations to come from a StateField. A companion ViewPlugin
// plumbs the current viewport bounds into a separate StateField via
// `setViewportEffect` so that decoration building can clip the Lezer-tree
// iteration to the visible slice.
//
// Performance (#249):
//   * Selection-only transactions only rebuild when the cursor enters or
//     leaves an existing HTML node range — otherwise the previous decoration
//     set is reused.
//   * `DOMPurify.sanitize` results are memoised by raw input text via a
//     bounded module-level cache, so the same `<details>` block is
//     sanitised once, not on every keystroke.
//   * Widgets carry the pre-sanitised HTML, so `toDOM()` does not run a
//     second sanitise pass over content already cleared by `buildDecorations`.
//
// Security: DOMPurify strips `<script>`, `on*` attributes, `javascript:`
// URLs, and dangerous SVG features before any HTML reaches the DOM.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
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

// ── Sanitise cache (#249) ────────────────────────────────────────────────────
//
// DOMPurify is deterministic for a fixed config, so memoising by raw text
// is safe. A bounded Map keeps the cache size under control for
// pathological vaults — we purge the oldest entries on overflow. 1024 slots
// comfortably cover typical power-user notes (which usually contain a handful
// of HTML blocks at most).

const SANITIZE_CACHE_LIMIT = 1024;
const sanitizeCache: Map<string, string> = new Map();

/** Sanitize HTML string, returns safe HTML. Cached by raw input text. Exported for testing. */
export function sanitizeHtml(raw: string): string {
  const hit = sanitizeCache.get(raw);
  if (hit !== undefined) {
    // Refresh LRU position.
    sanitizeCache.delete(raw);
    sanitizeCache.set(raw, hit);
    return hit;
  }
  const clean = DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string;
  if (sanitizeCache.size >= SANITIZE_CACHE_LIMIT) {
    const oldestKey = sanitizeCache.keys().next().value;
    if (oldestKey !== undefined) sanitizeCache.delete(oldestKey);
  }
  sanitizeCache.set(raw, clean);
  return clean;
}

/** Test-only: drop every cached sanitiser result. */
export function __resetSanitizeCacheForTests(): void {
  sanitizeCache.clear();
}

// ── Comment detection ────────────────────────────────────────────────────────

const COMMENT_RE = /^<!--[\s\S]*?-->$/;

function isHtmlComment(text: string): boolean {
  return COMMENT_RE.test(text.trim());
}

// ── Widgets ──────────────────────────────────────────────────────────────────
//
// Both widgets receive the already-sanitised HTML string so their `toDOM()`
// can skip a second DOMPurify pass. `eq()` still compares the raw input (kept
// for cache-key stability and cheap identity checks).

class HtmlBlockWidget extends WidgetType {
  constructor(readonly html: string, readonly sanitized: string) {
    super();
  }

  eq(other: HtmlBlockWidget): boolean {
    return this.html === other.html;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-html-rendered";
    wrap.innerHTML = this.sanitized;
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class HtmlInlineWidget extends WidgetType {
  constructor(readonly html: string, readonly sanitized: string) {
    super();
  }

  eq(other: HtmlInlineWidget): boolean {
    return this.html === other.html;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-html-rendered-inline";
    wrap.innerHTML = this.sanitized;
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── Viewport plumbing ────────────────────────────────────────────────────────

interface ViewportRange {
  from: number;
  to: number;
}

const setViewportEffect = StateEffect.define<ViewportRange>();

// `{from: -1, to: -1}` sentinel means "viewport not yet known" — on first
// build we fall back to iterating the full tree until the companion
// ViewPlugin pushes a real viewport. For non-ViewPlugin environments (e.g.
// unit tests that build a bare state) this keeps behaviour identical to the
// pre-#249 implementation.
const UNKNOWN_VIEWPORT: ViewportRange = { from: -1, to: -1 };

const viewportField = StateField.define<ViewportRange>({
  create() {
    return UNKNOWN_VIEWPORT;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setViewportEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

const viewportTrackerPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // Seed the viewport on mount so the very first decoration rebuild
      // can clip its iterate() call.
      queueMicrotask(() => {
        try {
          view.dispatch({
            effects: setViewportEffect.of({
              from: view.viewport.from,
              to: view.viewport.to,
            }),
          });
        } catch {
          // View may already be destroyed.
        }
      });
    }

    update(u: ViewUpdate) {
      if (u.viewportChanged) {
        u.view.dispatch({
          effects: setViewportEffect.of({
            from: u.view.viewport.from,
            to: u.view.viewport.to,
          }),
        });
      }
    }
  },
);

// ── Decoration builder ───────────────────────────────────────────────────────

interface HtmlNodeRange {
  from: number;
  to: number;
}

interface InlineHtmlValue {
  decorations: DecorationSet;
  /** Document-order list of every HTML node range that was considered. */
  ranges: HtmlNodeRange[];
}

function buildDecorations(state: EditorState): InlineHtmlValue {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  const nodeRanges: HtmlNodeRange[] = [];

  const head = state.selection.main.head;
  const doc = state.doc;

  const viewport = state.field(viewportField, false) ?? UNKNOWN_VIEWPORT;
  const iterateArgs: {
    from?: number;
    to?: number;
    enter: (node: { name: string; from: number; to: number }) => void | boolean;
  } = {
    enter(node) {
      if (node.name !== "HTMLBlock" && node.name !== "HTMLTag") return;

      const from = node.from;
      const to = node.to;

      nodeRanges.push({ from, to });

      // If cursor is on any line within this node, show raw source.
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
        // tags that DOMPurify strips entirely). The sanitised output is
        // memoised so the widget can reuse it without a second pass.
        const sanitized = sanitizeHtml(text);
        if (sanitized.trim().length === 0) return;

        if (node.name === "HTMLBlock") {
          ranges.push({
            from,
            to,
            decoration: Decoration.replace({
              widget: new HtmlBlockWidget(text, sanitized),
              block: true,
            }),
          });
        } else {
          ranges.push({
            from,
            to,
            decoration: Decoration.replace({
              widget: new HtmlInlineWidget(text, sanitized),
            }),
          });
        }
      }
    },
  };

  if (viewport.from !== -1 || viewport.to !== -1) {
    iterateArgs.from = viewport.from;
    iterateArgs.to = viewport.to;
  }

  syntaxTree(state).iterate(iterateArgs);

  ranges.sort((a, b) => a.from - b.from);
  nodeRanges.sort((a, b) => a.from - b.from);

  return {
    decorations: Decoration.set(
      ranges.map((r) => r.decoration.range(r.from, r.to)),
      true,
    ),
    ranges: nodeRanges,
  };
}

// ── Short-circuit logic ──────────────────────────────────────────────────────

/**
 * Return true iff moving the cursor from `oldHead` to `newHead` crosses at
 * least one HTML-node line boundary in `ranges`. A "cross" means the old line
 * is inside/outside a node while the new line is outside/inside (i.e. the
 * cursor-on-line live-preview gate would flip for that node).
 */
function crossesHtmlBoundary(
  ranges: HtmlNodeRange[],
  doc: EditorState["doc"],
  oldHead: number,
  newHead: number,
): boolean {
  if (ranges.length === 0) return false;
  if (oldHead === newHead) return false;
  const oldLine = doc.lineAt(Math.min(Math.max(oldHead, 0), doc.length)).number;
  const newLine = doc.lineAt(Math.min(Math.max(newHead, 0), doc.length)).number;
  if (oldLine === newLine) return false;
  for (const r of ranges) {
    const rStart = doc.lineAt(r.from).number;
    const rEnd = doc.lineAt(r.to).number;
    const oldInside = oldLine >= rStart && oldLine <= rEnd;
    const newInside = newLine >= rStart && newLine <= rEnd;
    if (oldInside !== newInside) return true;
  }
  return false;
}

// ── StateField ───────────────────────────────────────────────────────────────

const inlineHtmlField = StateField.define<InlineHtmlValue>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    // Viewport changes must re-run the build so off-screen → on-screen blocks
    // get decorated. Check effects before the fast-path bail-outs.
    let viewportChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setViewportEffect)) {
        viewportChanged = true;
        break;
      }
    }

    if (tr.docChanged || viewportChanged) {
      return buildDecorations(tr.state);
    }

    if (tr.selection) {
      const oldHead = tr.startState.selection.main.head;
      const newHead = tr.state.selection.main.head;
      if (!crossesHtmlBoundary(value.ranges, tr.state.doc, oldHead, newHead)) {
        // Pure cursor movement within the same "html vs not" region — the
        // decoration set we returned last time is still correct.
        return value;
      }
      return buildDecorations(tr.state);
    }

    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f, (v) => v.decorations);
  },
});

// ── Exported extension ───────────────────────────────────────────────────────

export const inlineHtmlPlugin: Extension = [
  viewportField,
  inlineHtmlField,
  viewportTrackerPlugin,
];

// Test-only internals.
export const __test = {
  buildDecorations,
  crossesHtmlBoundary,
  inlineHtmlField,
  viewportField,
  setViewportEffect,
};
